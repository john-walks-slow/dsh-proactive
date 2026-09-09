/**
 * Browser transport to the host-side panel routes: one snapshot GET, one
 * closed action POST, and an SSE change stream that signals re-pull.
 *
 * Both state and action accept an optional `sessionId`; when present the
 * request carries `?session=<id>` and the host scopes the snapshot (alarms,
 * runs) and enforces alarm ownership on mutations.
 */

import type { PanelAction } from "../panel/contract.js";

/**
 * One alarm row on the wire (v2): `sessionId` keeps its historical meaning of
 * OWNER; the wake destination is surface separately via targetMode /
 * targetSessionId (owner ⇔ create-side, target ⇔ wake-side).
 */
export interface AlarmRowDto {
  id: string;
  sessionId: string;
  sessionTitle: string;
  type: "once" | "every" | "cron";
  targetMode: "resume" | "fork" | "new";
  /** Present for resume/fork targets. */
  targetSessionId?: string;
  /** Display title of the target session (client-enriched; empty = unknown). */
  targetSessionTitle?: string;
  respectQuietHours: boolean;
  prompt: string;
  nextDueAt: string;
  createdAt: string;
  state: string;
  deliveryMode: string;
  compaction: "off" | "minimal" | "aggressive";
  jitterSeconds?: number;
  everySeconds?: number;
  cron?: string;
  at?: string;
}

export interface PanelSnapshotDto {
  server: { now: string; dataDir: string; corrupt: boolean };
  /**
   * `defaultPrompt` (the create-form prefill) is optional: a host still
   * running a pre-260907 build serves the v2 shape without it, and the client
   * falls back to the bundled repo default until the next host restart.
   */
  config: { enabled: boolean; maxDeliveriesPerDay: number; quietHours: { start: string; end: string; timeZone: string }; defaultPrompt?: string };
  alarms: AlarmRowDto[];
  runs: Array<{ id: string; alarmId: string; sessionId: string; firedAt: string; decision: string; budgetDelta: number; note?: string; reasoningSummary?: string; replySummary?: string; noReplyReason?: string }>;
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

  /**
   * Snapshot plus the complete session list (ids + titles), in one round
   * trip: titles enrich alarm rows, and the id set feeds the create form's
   * unknown-target hint. Both surfaces use this (the session tab passes its
   * own sessionId to keep the scoped snapshot).
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

  /** Like `stateForHost` for closed actions: refreshed snapshot + session list. */
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

/**
 * Overlay the session-title map onto alarm rows (server title wins, then map,
 * then raw id). Both the owner (`sessionId`) and the wake target
 * (`targetSessionId`) get display titles, so the table can show either as a
 * readable name without fetching session.list again.
 */
function withSessionTitles(snapshot: PanelSnapshotDto, titles: Map<string, string>): PanelSnapshotDto {
  if (titles.size === 0) return snapshot;
  return {
    ...snapshot,
    alarms: snapshot.alarms.map((alarm) => {
      if (alarm.sessionTitle !== undefined && alarm.sessionTitle !== "") return alarm;
      const title = titles.get(alarm.sessionId);
      const targetTitle = alarm.targetSessionId !== undefined ? titles.get(alarm.targetSessionId) : undefined;
      return {
        ...alarm,
        sessionTitle: title ?? "",
        ...(targetTitle !== undefined && targetTitle !== "" ? { targetSessionTitle: targetTitle } : {})
      };
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
 * fetch failure — the panel then degrades: no title enrichment, no
 * unknown-target hint).
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