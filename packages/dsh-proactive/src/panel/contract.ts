/**
 * Wire contract between the GUI panel (client half) and the host-side panel
 * service. One dialect is shared with the model tools through the closed
 * validation in alarm-factory.ts, so a UI action and a proactive_set call
 * accept the same create shape and surface the same error codes.
 */

import type { AlarmView, ProactiveErrorCode, RunDecision } from "../domain.js";

export interface RunView {
  id: string;
  alarmId: string;
  sessionId: string;
  firedAt: string;
  decision: RunDecision;
  budgetDelta: number;
  note?: string;
  /** Truncated reasoning (thinking) summary of the wake turn. */
  reasoningSummary?: string;
  /** Truncated visible-reply summary of the wake turn. */
  replySummary?: string;
}

/** Read-only configuration summary the panel displays next to the alarms. */
export interface ConfigView {
  enabled: boolean;
  maxDeliveriesPerDay: number;
  quietHours: { start: string; end: string; timeZone: string };
  /** Default heartbeat (check-in) prompt used to prefill the create form. */
  heartbeatPrompt: string;
  /** Default heartbeat repeat interval in seconds used to prefill the create form. */
  heartbeatEverySeconds: number;
}

export interface PanelSnapshot {
  server: { now: string; dataDir: string; corrupt: boolean };
  config: ConfigView;
  alarms: AlarmView[];
  runs: RunView[];
}

/**
 * Closed panel action vocabulary. `create` carries the same argument root as
 * proactive_set (prompt/at|after_seconds|every_seconds/time_zone/delivery/
 * wake_reason) and is validated by the exact same function.
 */
export type PanelAction =
  | { kind: "create"; sessionId: string; args: Record<string, unknown> }
  | { kind: "cancel"; id: string }
  | { kind: "toggle"; id: string }
  | { kind: "fire"; id: string };

export type PanelErrorCode = ProactiveErrorCode | "invalid_action" | "bad_action";

export interface PanelError {
  code: PanelErrorCode;
  message: string;
}

export type PanelResult = { ok: true; snapshot: PanelSnapshot } | { ok: false; error: PanelError };

/** Create arguments from the panel form (a superset of the tool dialect keys). */
export interface PanelCreateForm {
  prompt: string;
  at?: string;
  afterSeconds?: number;
  everySeconds?: number;
  timeZone?: string;
  delivery?: { chat: boolean; push: boolean; wechat: boolean };
  wakeReason?: string;
}

/** Map a form to the shared argument root so one validator serves both surfaces. */
export function createArgsFromForm(form: PanelCreateForm): Record<string, unknown> {
  const args: Record<string, unknown> = { prompt: form.prompt, delivery: form.delivery ?? { chat: true, push: false, wechat: false } };
  if (form.at !== undefined && form.at !== "") args["at"] = form.at;
  if (form.afterSeconds !== undefined) args["after_seconds"] = form.afterSeconds;
  if (form.everySeconds !== undefined) args["every_seconds"] = form.everySeconds;
  if (form.timeZone !== undefined && form.timeZone !== "") args["time_zone"] = form.timeZone;
  if (form.wakeReason !== undefined && form.wakeReason !== "") args["wake_reason"] = form.wakeReason;
  return args;
}