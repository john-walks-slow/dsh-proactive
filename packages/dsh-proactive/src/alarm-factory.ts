/**
 * Shared alarm factory: the single path that turns a validated create request
 * into a stored Alarm. Both the model tools (tools.ts) and the GUI panel
 * (panel/service.ts) drive it, so a nuance fixed once cannot drift between
 * the two surfaces.
 *
 * v2 (260907-proactive-alarm-v2): one selector (at | after_seconds |
 * every_seconds | cron) derives the alarm type once/every/cron; a unified
 * jitter_seconds applies a random delay after every scheduled instant; the
 * wake target is decoupled from the creator via target_mode/target_session_id.
 */

import {
  canonicalizeTimeZone,
  isRecord,
  isValidSessionId,
  jitterDelay,
  nextEveryOccurrence,
  requireFuture,
  resolveAtInput,
  validateJitterSeconds,
  validatePrompt,
  inputError,
  COMPACTION_MODES,
  DEFAULT_COMPACTION,
  MIN_EVERY_SECONDS,
  type Alarm,
  type AlarmCompaction,
  type AlarmTarget,
  type AlarmTrigger,
  type AlarmType,
  type AtInput,
  type RandomSource,
  type ToolError
} from "./domain.js";
import { parseCron, nextCronOccurrence } from "./cron.js";

/** 10 years in seconds — a safe ceiling so epoch math can never escape the Date range. */
const MAX_DELAY_SECONDS = 10 * 365 * 86400;

export interface CreateSpec {
  prompt: string;
  kind: "at" | "after" | "every" | "cron";
  at?: unknown;
  afterSeconds?: number;
  everySeconds?: number;
  cron?: string;
  /** Unified per-occurrence random delay in seconds; absent/0 = exact timing. */
  jitterSeconds?: number;
  timeZone?: string;
  respectQuietHours: boolean;
  compaction: AlarmCompaction;
  target: AlarmTarget;
}

function allocateId(prefix: string): string {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Closed validation of the open parameter root shared by proactive_set and the
 * panel create action. Panels keep a payload comment on the same vocabulary so
 * the model tools and the GUI accept exactly one dialect.
 *
 * `defaultTargetSessionId` is the creator session; it becomes the wake target
 * when target_mode is resume/fork and no target_session_id was given (v1
 * behaviour — the alarm wakes its creator).
 */
export function validateCreateArgs(args: Record<string, unknown>, defaultTargetSessionId: string): CreateSpec | ToolError {
  const allowed = new Set(["prompt", "at", "after_seconds", "every_seconds", "cron", "jitter_seconds", "time_zone", "respect_quiet_hours", "target_mode", "target_session_id", "compaction"]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) return { code: "invalid_trigger", message: "proactive_set accepts only prompt, at, after_seconds, every_seconds, cron, jitter_seconds, time_zone, respect_quiet_hours, target_mode, target_session_id, compaction." };
  }
  const selectors = Number(args["at"] !== undefined) + Number(args["after_seconds"] !== undefined) + Number(args["every_seconds"] !== undefined) + Number(args["cron"] !== undefined);
  if (selectors !== 1) return { code: "invalid_trigger", message: "proactive_set requires exactly one of at, after_seconds, every_seconds, or cron." };
  let jitterSeconds: number | undefined;
  if (args["jitter_seconds"] !== undefined) {
    try {
      jitterSeconds = validateJitterSeconds(args["jitter_seconds"]);
    } catch (error) {
      return inputError(error);
    }
  }
  // The prompt is the user's instruction on every alarm; there is no
  // model-generated "heartbeat" variant anymore, so it is always required.
  let prompt: string;
  try {
    prompt = validatePrompt(args["prompt"]);
  } catch (error) {
    return inputError(error);
  }
  let respectQuietHours = false;
  if (args["respect_quiet_hours"] !== undefined) {
    if (typeof args["respect_quiet_hours"] !== "boolean") return { code: "invalid_trigger", message: "respect_quiet_hours must be a boolean." };
    respectQuietHours = args["respect_quiet_hours"];
  }
  let compaction: AlarmCompaction = DEFAULT_COMPACTION;
  if (args["compaction"] !== undefined) {
    if (typeof args["compaction"] !== "string" || !COMPACTION_MODES.includes(args["compaction"])) {
      return { code: "invalid_trigger", message: "compaction must be one of off, minimal, aggressive." };
    }
    compaction = args["compaction"] as AlarmCompaction;
  }
  let mode: AlarmTarget["mode"] = "resume";
  if (args["target_mode"] !== undefined) {
    if (typeof args["target_mode"] !== "string" || !["resume", "fork", "new"].includes(args["target_mode"])) {
      return { code: "invalid_trigger", message: "target_mode must be one of resume, fork, new." };
    }
    mode = args["target_mode"] as AlarmTarget["mode"];
  }
  let target: AlarmTarget;
  if (mode === "new") {
    if (args["target_session_id"] !== undefined) {
      return { code: "invalid_trigger", message: "target_session_id must be omitted when target_mode is new." };
    }
    target = { mode: "new" };
  } else {
    const sessionId = typeof args["target_session_id"] === "string" && args["target_session_id"].length > 0 ? args["target_session_id"] : defaultTargetSessionId;
    if (!isValidSessionId(sessionId)) return { code: "invalid_trigger", message: "target_session_id must be a valid dsh session id." };
    target = { mode, sessionId };
  }
  const timeZone = typeof args["time_zone"] === "string" && args["time_zone"].length > 0 ? args["time_zone"] : undefined;
  // Validate the zone up front regardless of selector: every/after must not let
  // a bogus zone slip into a stored alarm (only cron used to catch it).
  if (timeZone !== undefined) {
    try {
      canonicalizeTimeZone(timeZone);
    } catch (error) {
      return inputError(error);
    }
  }
  if (args["after_seconds"] !== undefined) {
    const value = args["after_seconds"];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      return { code: "invalid_trigger", message: "after_seconds must be a positive safe integer." };
    }
    if (value > MAX_DELAY_SECONDS) {
      return { code: "invalid_trigger", message: "after_seconds must not exceed " + MAX_DELAY_SECONDS + "." };
    }
    return { prompt, kind: "after", afterSeconds: value, ...(jitterSeconds !== undefined ? { jitterSeconds } : {}), respectQuietHours, compaction, target, ...(timeZone !== undefined ? { timeZone } : {}) };
  }
  if (args["every_seconds"] !== undefined) {
    const value = args["every_seconds"];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      return { code: "invalid_trigger", message: "every_seconds must be a safe integer." };
    }
    if (value > MAX_DELAY_SECONDS) {
      return { code: "invalid_trigger", message: "every_seconds must not exceed " + MAX_DELAY_SECONDS + "." };
    }
    try {
      nextEveryOccurrence(0, value, 1); // validates the floor; result unused
    } catch (error) {
      return inputError(error);
    }
    if (jitterSeconds !== undefined && jitterSeconds > value) {
      return { code: "invalid_trigger", message: "jitter_seconds must not exceed every_seconds (" + value + ")." };
    }
    return { prompt, kind: "every", everySeconds: value, ...(jitterSeconds !== undefined ? { jitterSeconds } : {}), respectQuietHours, compaction, target, ...(timeZone !== undefined ? { timeZone } : {}) };
  }
  if (args["cron"] !== undefined) {
    if (typeof args["cron"] !== "string") return { code: "invalid_trigger", message: "cron must be a five-field expression string." };
    try {
      parseCron(args["cron"]);
    } catch (error) {
      return inputError(error);
    }
    const zone = timeZone ?? "UTC";
    try {
      canonicalizeTimeZone(zone);
      const t1 = nextCronOccurrence(args["cron"], zone, 0);
      const t2 = nextCronOccurrence(args["cron"], zone, t1);
      if (t2 - t1 < MIN_EVERY_SECONDS * 1000) {
        return { code: "frequency_too_high", message: "cron occurrences must be at least " + MIN_EVERY_SECONDS + " seconds apart." };
      }
    } catch (error) {
      return inputError(error);
    }
    return { prompt, kind: "cron", cron: args["cron"], ...(jitterSeconds !== undefined ? { jitterSeconds } : {}), respectQuietHours, compaction, target, ...(timeZone !== undefined ? { timeZone } : {}) };
  }
  return { prompt, kind: "at", at: args["at"], ...(jitterSeconds !== undefined ? { jitterSeconds } : {}), respectQuietHours, compaction, target, ...(timeZone !== undefined ? { timeZone } : {}) };
}

/**
 * Resolve the canonical trigger + nextDueAt for a validated create request.
 * jitter_seconds is drawn ONCE here and baked into nextDueAt, so the scheduler
 * itself never waits: the delay is part of the plan, not of the loop.
 */
export function buildAlarm(ownerSessionId: string, spec: CreateSpec, nowStart: number, random: RandomSource = Math.random): { alarm: Alarm } | ToolError {
  const stamp = new Date(nowStart).toISOString();
  let timeZone = spec.timeZone ?? "UTC";
  let type: AlarmType;
  let trigger: AlarmTrigger;
  let epoch: number;
  if (spec.kind === "after") {
    type = "once";
    epoch = nowStart + spec.afterSeconds! * 1000;
    trigger = { at: new Date(epoch).toISOString() };
  } else if (spec.kind === "every") {
    type = "every";
    epoch = nowStart + spec.everySeconds! * 1000;
    trigger = {
      everySeconds: spec.everySeconds!,
      anchor: stamp,
      ...(spec.jitterSeconds !== undefined ? { jitterSeconds: spec.jitterSeconds } : {})
    };
  } else if (spec.kind === "cron") {
    type = "cron";
    try {
      epoch = nextCronOccurrence(spec.cron!, timeZone, nowStart);
    } catch (error) {
      return inputError(error);
    }
    trigger = {
      expr: spec.cron!,
      ...(spec.jitterSeconds !== undefined ? { jitterSeconds: spec.jitterSeconds } : {})
    };
  } else {
    if (typeof spec.at !== "string" && !isRecord(spec.at)) {
      return { code: "invalid_trigger", message: "at must be a strict RFC 3339 string or a local date/time object." };
    }
    try {
      const resolved = resolveAtInput(spec.at as AtInput);
      requireFuture(resolved.epoch, nowStart);
      type = "once";
      epoch = resolved.epoch;
      trigger = { at: new Date(epoch).toISOString() };
      // A local at object carries an explicit zone; reflect it when the caller
      // did not pass top-level time_zone (string instants are self-contained).
      if (spec.timeZone === undefined) timeZone = resolved.timeZone;
    } catch (error) {
      return inputError(error);
    }
  }
  const delayed = epoch + jitterDelay(spec.jitterSeconds, random);
  return {
    alarm: {
      id: allocateId("alarm"),
      ownerSessionId,
      target: spec.target,
      type,
      trigger,
      prompt: spec.prompt,
      respectQuietHours: spec.respectQuietHours,
      compaction: spec.compaction,
      timeZone,
      status: "scheduled",
      nextDueAt: new Date(delayed).toISOString(),
      createdAt: stamp,
      updatedAt: stamp,
      runCount: 0,
      lastRunAt: null
    }
  };
}