/**
 * Shared alarm factory: the single path that turns a validated create request
 * into a stored Alarm. Both the model tools (tools.ts) and the GUI panel
 * (panel/service.ts) drive it, so a nuance fixed once cannot drift between
 * the two surfaces.
 */

import {
  isRecord,
  nextEveryOccurrence,
  requireFuture,
  resolveAtInput,
  validatePrompt,
  inputError,
  WAKE_REASONS,
  type Alarm,
  type AlarmTrigger,
  type AtInput,
  type DeliveryHint,
  type ToolError,
  type WakeReason
} from "./domain.js";

/** 10 years in seconds — a safe ceiling so epoch math can never escape the Date range. */
const MAX_DELAY_SECONDS = 10 * 365 * 86400;

export interface CreateSpec {
  prompt: string;
  kind: "at" | "after" | "every";
  at?: unknown;
  afterSeconds?: number;
  everySeconds?: number;
  timeZone?: string;
  delivery: DeliveryHint;
  wakeReason: WakeReason;
}

function normalizeDelivery(value: unknown): DeliveryHint | undefined {
  if (value === undefined) return { chat: true, push: true, wechat: true };
  if (!isRecord(value)) return undefined;
  const booleans = (key: string): boolean => (typeof value[key] === "boolean" ? (value[key] as boolean) : true);
  return { chat: booleans("chat"), push: booleans("push"), wechat: booleans("wechat") };
}

function allocateId(prefix: string): string {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Closed validation of the open parameter root shared by proactive_set and the
 * panel create action. Panels keep a payload comment on the same vocabulary so
 * the model tools and the GUI accept exactly one dialect.
 */
export function validateCreateArgs(args: Record<string, unknown>): CreateSpec | ToolError {
  const allowed = new Set(["prompt", "at", "after_seconds", "every_seconds", "time_zone", "delivery", "wake_reason"]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) return { code: "invalid_trigger", message: "proactive_set accepts only prompt, at, after_seconds, every_seconds, time_zone, delivery, wake_reason." };
  }
  const selectors = Number(args["at"] !== undefined) + Number(args["after_seconds"] !== undefined) + Number(args["every_seconds"] !== undefined);
  if (selectors !== 1) return { code: "invalid_trigger", message: "proactive_set requires exactly one of at, after_seconds, or every_seconds." };
  let prompt: string;
  try {
    prompt = validatePrompt(args["prompt"]);
  } catch (error) {
    return inputError(error);
  }
  const delivery = normalizeDelivery(args["delivery"]);
  if (delivery === undefined) return { code: "invalid_trigger", message: "delivery must be an object with boolean chat/push/wechat fields." };
  let wakeReason: WakeReason = "alarm";
  if (args["wake_reason"] !== undefined) {
    if (typeof args["wake_reason"] !== "string" || !(WAKE_REASONS as readonly string[]).includes(args["wake_reason"])) {
      return { code: "invalid_trigger", message: "wake_reason must be one of " + WAKE_REASONS.join(", ") + "." };
    }
    wakeReason = args["wake_reason"] as WakeReason;
  }
  const timeZone = typeof args["time_zone"] === "string" && args["time_zone"].length > 0 ? args["time_zone"] : undefined;
  if (args["after_seconds"] !== undefined) {
    const value = args["after_seconds"];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      return { code: "invalid_trigger", message: "after_seconds must be a positive safe integer." };
    }
    if (value > MAX_DELAY_SECONDS) {
      return { code: "invalid_trigger", message: "after_seconds must not exceed " + MAX_DELAY_SECONDS + "." };
    }
    return { prompt, kind: "after", afterSeconds: value, delivery, wakeReason, ...(timeZone !== undefined ? { timeZone } : {}) };
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
    return { prompt, kind: "every", everySeconds: value, delivery, wakeReason, ...(timeZone !== undefined ? { timeZone } : {}) };
  }
  return { prompt, kind: "at", at: args["at"], delivery, wakeReason, ...(timeZone !== undefined ? { timeZone } : {}) };
}

/** Resolve the canonical trigger + nextDueAt for a validated create request. */
export function buildAlarm(sessionId: string, spec: CreateSpec, nowStart: number): { alarm: Alarm } | ToolError {
  const stamp = new Date(nowStart).toISOString();
  if (spec.kind === "after") {
    const epoch = nowStart + spec.afterSeconds! * 1000;
    const trigger: AlarmTrigger = { at: new Date(epoch).toISOString() };
    return { alarm: newAlarm(sessionId, spec, trigger, epoch, stamp) };
  }
  if (spec.kind === "every") {
    const epoch = nowStart + spec.everySeconds! * 1000;
    const trigger: AlarmTrigger = { everySeconds: spec.everySeconds!, anchor: stamp };
    return { alarm: newAlarm(sessionId, spec, trigger, epoch, stamp) };
  }
  if (typeof spec.at !== "string" && !isRecord(spec.at)) {
    return { code: "invalid_trigger", message: "at must be a strict RFC 3339 string or a local date/time object." };
  }
  try {
    const resolved = resolveAtInput(spec.at as AtInput);
    requireFuture(resolved.epoch, nowStart);
    const trigger: AlarmTrigger = { at: new Date(resolved.epoch).toISOString() };
    return { alarm: newAlarm(sessionId, spec, trigger, resolved.epoch, stamp) };
  } catch (error) {
    return inputError(error);
  }
}

export function newAlarm(
  sessionId: string,
  spec: { prompt: string; delivery: DeliveryHint; wakeReason: WakeReason; timeZone?: string },
  trigger: AlarmTrigger,
  epoch: number,
  stamp: string
): Alarm {
  return {
    id: allocateId("alarm"),
    sessionId,
    mode: "everySeconds" in trigger ? "repeat" : "one-shot",
    trigger,
    prompt: spec.prompt,
    wakeReason: spec.wakeReason,
    deliveryHint: spec.delivery,
    timeZone: spec.timeZone ?? "UTC",
    status: "scheduled",
    nextDueAt: new Date(epoch).toISOString(),
    createdAt: stamp,
    updatedAt: stamp,
    runCount: 0,
    lastRunAt: null
  };
}