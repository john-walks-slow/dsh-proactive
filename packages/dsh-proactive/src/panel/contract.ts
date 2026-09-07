/**
 * Wire contract between the GUI panel (client half) and the host-side panel
 * service. One dialect is shared with the model tools through the closed
 * validation in alarm-factory.ts, so a UI action and a proactive_set call
 * accept the same create shape and surface the same error codes.
 *
 * v2 (260907-proactive-alarm-v2): the form carries a three-way kind
 * (once/every/cron), the unified jitterSeconds, the respectQuietHours switch
 * and the target_mode/target_session_id destination — the same vocabulary as
 * proactive_set, mapped through createArgsFromForm.
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
 * The repo-wide default heartbeat prompt was removed in v2: every alarm
 * carries its own prompt and respect_quiet_hours switch.
 */
export interface ConfigView {
  enabled: boolean;
  maxDeliveriesPerDay: number;
  quietHours: { start: string; end: string; timeZone: string };
}

/** One alarm row plus the owning session's display title (empty = unknown). */
export interface AlarmRowView extends AlarmView {
  /** Display title of the owning session; empty when the host cannot resolve it. */
  sessionTitle: string;
  /** Creation instant (for sorting). */
  createdAt: string;
}

export interface PanelSnapshot {
  server: { now: string; dataDir: string; corrupt: boolean };
  config: ConfigView;
  alarms: AlarmRowView[];
  runs: RunView[];
}

/**
 * Closed panel action vocabulary. `create`/`edit` carry the same argument root
 * as proactive_set (prompt/at|after_seconds|every_seconds|cron/jitter_seconds/
 * respect_quiet_hours/target_mode/target_session_id/time_zone) and are
 * validated by the exact same function.
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

/**
 * Create/edit arguments from the panel form. `kind` selects the create shape:
 * once = afterSeconds (relative delay) or atDate+atTime (local absolute),
 * every = everySeconds (+ jitterSeconds), cron = cron expression
 * (+ jitterSeconds). respectQuietHours and the target destination are
 * independent of the type.
 */
export interface PanelCreateForm {
  prompt: string;
  kind: "once" | "every" | "cron";
  /** Owning session (host-wide view only; the conversation tab pins its own). */
  sessionId?: string;
  /** once: relative delay in seconds (alternative to atDate/atTime). */
  afterSeconds?: number;
  /** once: local absolute date (alternative to afterSeconds). */
  atDate?: string;
  /** once: local absolute time HH:mm (alternative to afterSeconds). */
  atTime?: string;
  /** every: fixed interval in seconds (>= 300). */
  everySeconds?: number;
  /** cron: five-field expression. */
  cron?: string;
  /** Unified per-occurrence random delay in seconds; 0/absent = exact timing. */
  jitterSeconds?: number;
  timeZone?: string;
  /** false (default) = user-requested, exempt from quiet hours + budget. */
  respectQuietHours?: boolean;
  targetMode?: "resume" | "fork" | "new";
  /** Destination for resume/fork; omitted = owner. Ignored for new. */
  targetSessionId?: string;
}

/** Map a form to the shared argument root so one validator serves both surfaces. */
export function createArgsFromForm(form: PanelCreateForm): Record<string, unknown> {
  const args: Record<string, unknown> = { prompt: form.prompt };
  if (form.kind === "every") {
    if (form.everySeconds !== undefined) args["every_seconds"] = form.everySeconds;
  } else if (form.kind === "cron") {
    if (form.cron !== undefined && form.cron !== "") args["cron"] = form.cron;
  } else {
    // once — either a relative delay or a local absolute instant.
    if (form.afterSeconds !== undefined) {
      args["after_seconds"] = form.afterSeconds;
    } else if (form.atDate !== undefined && form.atDate !== "" && form.atTime !== undefined && form.atTime !== "") {
      // Local absolute instant: the zone is resolved host-side through the
      // same default chain as top-level time_zone (client zone -> host zone),
      // so an empty slot here means "the caller's zone", never a hardcoded UTC.
      args["at"] = { date: form.atDate, time: form.atTime + ":00", time_zone: form.timeZone ?? "" };
    }
  }
  // Jitter is a first-class knob on all three types (v2: once/every/cron all
  // accept a per-occurrence random delay); stale zero values are simply dropped.
  if (form.jitterSeconds !== undefined && form.jitterSeconds > 0) args["jitter_seconds"] = form.jitterSeconds;
  if (form.timeZone !== undefined && form.timeZone !== "") args["time_zone"] = form.timeZone;
  if (form.respectQuietHours !== undefined) args["respect_quiet_hours"] = form.respectQuietHours;
  if (form.targetMode !== undefined && form.targetMode !== "resume") args["target_mode"] = form.targetMode;
  if (form.targetSessionId !== undefined && form.targetSessionId !== "") args["target_session_id"] = form.targetSessionId;
  return args;
}