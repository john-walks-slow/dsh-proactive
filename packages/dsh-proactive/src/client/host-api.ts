/**
 * Browser transport to the host-side panel routes: one snapshot GET, one
 * closed action POST, and an SSE change stream that signals re-pull.
 *
 * Both state and action accept an optional `sessionId`; when present the
 * request carries `?session=<id>` and the host scopes the snapshot (alarms,
 * runs) and enforces alarm ownership on mutations.
 */

import type { PanelAction } from "../panel/contract.js";

export interface PanelSnapshotDto {
  server: { now: string; dataDir: string; corrupt: boolean };
  config: { enabled: boolean; maxDeliveriesPerDay: number; quietHours: { start: string; end: string; timeZone: string }; heartbeatPrompt: string };
  alarms: Array<{ id: string; sessionId: string; sessionTitle: string; mode: string; prompt: string; wakeReason: string; nextDueAt: string; createdAt: string; state: string; deliveryMode: string; jitter?: number; everySeconds?: number; at?: string }>;
  runs: Array<{ id: string; alarmId: string; sessionId: string; firedAt: string; decision: string; budgetDelta: number; note?: string; reasoningSummary?: string; replySummary?: string }>;
}

export interface PanelErrorDto {
  code: string;
  message: string;
}

/** One host session for pickers: durable id plus its display title (empty = unknown). */
export interface SessionInfo {
  id: string;
  title: string;
}

function isPanelError(body: PanelSnapshotDto | PanelErrorDto): body is PanelErrorDto {
  return typeof (body as PanelErrorDto).code === "string";
}

const STATE_URL = "/api/dsh-proactive/state";
const ACTION_URL = "/api/dsh-proactive/action";
const EVENTS_URL = "/api/dsh-proactive/events";

function sessionQuery(sessionId?: string): string {
  return sessionId === undefined ? "" : "?session=" + encodeURIComponent(sessionId);
}

export class ProactiveHostTransport {
  /** Fetch one snapshot; omit sessionId for the host-wide settings view. */
  async state(sessionId?: string): Promise<PanelSnapshotDto> {
    const response = await fetch(STATE_URL + sessionQuery(sessionId), { cache: "no-store" });
    const body = (await response.json()) as PanelSnapshotDto | PanelErrorDto;
    if (!response.ok || isPanelError(body)) {
      throw new Error((body as PanelErrorDto).code + ": " + ((body as PanelErrorDto).message ?? ""));
    }
    return body;
  }

  /** Like `state`, but fills alarm session titles from the host session list. */
  async stateEnriched(sessionId?: string): Promise<PanelSnapshotDto> {
    const [snapshot, titles] = await Promise.all([this.state(sessionId), fetchSessionTitles()]);
    return withSessionTitles(snapshot, titles);
  }

  /**
   * Host-wide reload for the settings panel: the snapshot plus the complete
   * session list for the target-session picker, in one round trip (titles are
   * enriched from the very same list, so no duplicate session.list call).
   */
  async stateForHost(sessionId?: string): Promise<{ snapshot: PanelSnapshotDto; sessions: SessionInfo[] }> {
    const [snapshot, sessions] = await Promise.all([this.state(sessionId), fetchSessionList()]);
    return { snapshot: withSessionTitles(snapshot, toTitleMap(sessions)), sessions };
  }

  /** Run one closed action; the returned snapshot follows the same scope. */
  async action(action: PanelAction, sessionId?: string): Promise<PanelSnapshotDto> {
    const response = await fetch(ACTION_URL + sessionQuery(sessionId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action })
    });
    const body = (await response.json()) as PanelSnapshotDto | PanelErrorDto;
    if (!response.ok || isPanelError(body)) {
      throw new Error((body as PanelErrorDto).code + ": " + ((body as PanelErrorDto).message ?? ""));
    }
    return body;
  }

  /** Like `action`, but fills alarm session titles from the host session list. */
  async actionEnriched(action: PanelAction, sessionId?: string): Promise<PanelSnapshotDto> {
    const [snapshot, titles] = await Promise.all([this.action(action, sessionId), fetchSessionTitles()]);
    return withSessionTitles(snapshot, titles);
  }

  /** Like `stateForHost` for the settings panel's closed actions. */
  async actionForHost(action: PanelAction, sessionId?: string): Promise<{ snapshot: PanelSnapshotDto; sessions: SessionInfo[] }> {
    const [snapshot, sessions] = await Promise.all([this.action(action, sessionId), fetchSessionList()]);
    return { snapshot: withSessionTitles(snapshot, toTitleMap(sessions)), sessions };
  }

  /**
   * Subscribe to host change pushes; the listener re-pulls state on each event
   * and also whenever the stream (re)connects — a missed "changed" event during
   * a disconnection (sleep, network drop) must not leave the panel stale.
   */
  subscribe(listener: () => void): () => void {
    const source = new EventSource(EVENTS_URL);
    source.addEventListener("changed", () => listener());
    source.onmessage = () => listener();
    source.onopen = () => listener();
    source.onerror = () => {
      /* EventSource auto-reconnects; onopen re-pulls once the stream is back */
    };
    return () => source.close();
  }
}

/** Overlay the session-title map onto alarm rows (server title wins, then map, then raw id). */
function withSessionTitles(snapshot: PanelSnapshotDto, titles: Map<string, string>): PanelSnapshotDto {
  if (titles.size === 0) return snapshot;
  return {
    ...snapshot,
    alarms: snapshot.alarms.map((alarm) => {
      if (alarm.sessionTitle !== undefined && alarm.sessionTitle !== "") return alarm;
      const title = titles.get(alarm.sessionId);
      return { ...alarm, sessionTitle: title ?? "" };
    })
  };
}

interface SessionListEntry {
  sessionId: string;
  projections?: { values?: { title?: string | null } } | null;
}

interface SessionListResponse {
  result: { value: { items?: SessionListEntry[] } };
}

const SESSION_LIST_URL = "/api/session.list";

/**
 * One extra call to the host's session.list RPC, mirroring how the sidebar
 * derives display titles: the durable title lives in each entry's
 * `projections.values.title` (folded by the session-title projection), not in
 * the raw summary. Returns the complete session list (empty = unknown /
 * fetch failure — the panel then degrades to alarm-derived options). The
 * settings panel's target-session picker uses this same list.
 */
export async function fetchSessionList(): Promise<SessionInfo[]> {
  try {
    const response = await fetch(SESSION_LIST_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "dsh-proactive:session-list", method: "session.list", params: {}, payload: {} })
    });
    if (!response.ok) return [];
    const body = (await response.json()) as SessionListResponse;
    const sessions: SessionInfo[] = [];
    for (const entry of body?.result?.value?.items ?? []) {
      const title = entry.projections?.values?.title;
      sessions.push({ id: entry.sessionId, title: typeof title === "string" && title !== "" ? title : "" });
    }
    return sessions;
  } catch {
    /* degrade to an empty list */
    return [];
  }
}

function toTitleMap(sessions: SessionInfo[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const session of sessions) {
    if (session.title !== "") titles.set(session.id, session.title);
  }
  return titles;
}

/** {sessionId -> title} map over the live session list (empty = unknown). */
export async function fetchSessionTitles(): Promise<Map<string, string>> {
  return toTitleMap(await fetchSessionList());
}