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

/**
 * Read-only configuration summary the panel displays in the settings header.
 * Global interval/jitter defaults were removed on purpose: every alarm picks
 * its own every_seconds/jitter at create/edit time (per-reminder config).
 */
export interface ConfigView {
  enabled: boolean;
  maxDeliveriesPerDay: number;
  quietHours: { start: string; end: string; timeZone: string };
  /** Default heartbeat (check-in) prompt — the wake wording baseline. */
  heartbeatPrompt: string;
}

/** One alarm row plus the owning session's display title (empty = unknown). */
export interface AlarmRowView extends AlarmView {
  /** Display title of the owning session; empty when the host cannot resolve it. */
  sessionTitle: string;
  /** Creation instant (for sorting). */
  createdAt: string;
  /** Repeat interval, present for repeat alarms (for the edit form prefill). */
  everySeconds?: number;
  /** Absolute due instant, present for one-shot alarms (for the edit form prefill). */
  at?: string;
}

export interface PanelSnapshot {
  server: { now: string; dataDir: string; corrupt: boolean };
  config: ConfigView;
  alarms: AlarmRowView[];
  runs: RunView[];
}

/**
 * Closed panel action vocabulary. `create`/`edit` carry the same argument root
 * as proactive_set (prompt/at|after_seconds|every_seconds/time_zone/
 * wake_reason) and are validated by the exact same function.
 *
 * Scope rule (single source of truth = the route's `?session=` query):
 *   - the host-wide settings view has NO scope → mutate anything.
 *   - every session-scoped request is pinned to its query session: `create`
 *     must name that same session and `cancel/toggle/fire` ids are
 *     ownership-guarded against it.
 * The body id fields below are the alarm/session names, NOT a second scope.
 */
export type PanelAction =
  | { kind: "create"; sessionId: string; args: Record<string, unknown> }
  | { kind: "edit"; id: string; args: Record<string, unknown> }
  | { kind: "cancel"; id: string }
  | { kind: "toggle"; id: string }
  | { kind: "fire"; id: string }
  /** Persist + hot-apply a partial global configuration patch. */
  | { kind: "update_config"; patch: Record<string, unknown> };

export type PanelErrorCode = ProactiveErrorCode | "invalid_action" | "bad_action" | "forbidden" | "invalid_prefs" | "scope_mismatch";

export interface PanelError {
  code: PanelErrorCode;
  message: string;
}

export type PanelResult = { ok: true; snapshot: PanelSnapshot } | { ok: false; error: PanelError };

/** Create/edit arguments from the panel form (a superset of the tool dialect keys). */
export interface PanelCreateForm {
  prompt: string;
  /** Owning session (host-wide view only; the conversation tab pins its own). */
  sessionId?: string;
  at?: string;
  afterSeconds?: number;
  everySeconds?: number;
  /** Repeat randomness 0..1; only meaningful together with everySeconds. */
  jitter?: number;
  timeZone?: string;
  wakeReason?: string;
}

/** Map a form to the shared argument root so one validator serves both surfaces. */
export function createArgsFromForm(form: PanelCreateForm): Record<string, unknown> {
  const args: Record<string, unknown> = { prompt: form.prompt };
  if (form.at !== undefined && form.at !== "") args["at"] = form.at;
  if (form.afterSeconds !== undefined) args["after_seconds"] = form.afterSeconds;
  if (form.everySeconds !== undefined) args["every_seconds"] = form.everySeconds;
  // Jitter is only meaningful with every_seconds: never carry a stale jitter
  // (e.g. from a form that previously held a repeat) into after_seconds
  // creations, which the shared validator would reject as invalid_trigger.
  if (form.everySeconds !== undefined && form.jitter !== undefined) args["jitter"] = form.jitter;
  if (form.timeZone !== undefined && form.timeZone !== "") args["time_zone"] = form.timeZone;
  if (form.wakeReason !== undefined && form.wakeReason !== "") args["wake_reason"] = form.wakeReason;
  return args;
}