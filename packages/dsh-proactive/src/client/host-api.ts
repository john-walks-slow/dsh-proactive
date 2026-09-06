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

  /** Subscribe to host change pushes; the listener re-pulls state on each event. */
  subscribe(listener: () => void): () => void {
    const source = new EventSource(EVENTS_URL);
    source.addEventListener("changed", () => listener());
    source.onmessage = () => listener();
    source.onerror = () => {
      /* EventSource auto-reconnects; nothing to do but keep the last snapshot */
    };
    return () => source.close();
  }
}