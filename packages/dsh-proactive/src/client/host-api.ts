/**
 * Browser transport to the host-side panel routes: one snapshot GET, one
 * closed action POST, and an SSE change stream that signals re-pull.
 */

import type { PanelAction } from "../panel/contract.js";

export interface PanelSnapshotDto {
  server: { now: string; dataDir: string; corrupt: boolean };
  config: { enabled: boolean; maxDeliveriesPerDay: number; quietHours: { start: string; end: string; timeZone: string }; heartbeatPrompt: string; heartbeatEverySeconds: number; heartbeatJitter: number };
  alarms: Array<{ id: string; mode: string; prompt: string; wakeReason: string; nextDueAt: string; state: string; deliveryMode: string; jitter?: number }>;
  runs: Array<{ id: string; alarmId: string; firedAt: string; decision: string; budgetDelta: number; note?: string; reasoningSummary?: string; replySummary?: string }>;
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

export class ProactiveHostTransport {
  async state(): Promise<PanelSnapshotDto> {
    const response = await fetch(STATE_URL, { cache: "no-store" });
    const body = (await response.json()) as PanelSnapshotDto | PanelErrorDto;
    if (!response.ok || isPanelError(body)) {
      throw new Error((body as PanelErrorDto).code + ": " + ((body as PanelErrorDto).message ?? ""));
    }
    return body;
  }

  async action(action: PanelAction): Promise<PanelSnapshotDto> {
    const response = await fetch(ACTION_URL, {
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