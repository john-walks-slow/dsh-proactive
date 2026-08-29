/**
 * Agent-scoped proactive alarm tools. Registered on every root agent's scoped
 * context (re-registration happens for resumed agents via agent/created).
 *
 *   proactive_set       create one host-level alarm for this session
 *   proactive_list      view this session's active alarms
 *   proactive_cancel    cancel one of this session's alarms
 *   proactive_no_reply  conclude the current wake turn with deep silence
 *
 * The stores they touch are host-level (the plugin singleton), so they work
 * identically in cold-wake turns and in ordinary user turns.
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolCallView, type ToolDefinition, type ValueSchemaSpec } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  MAX_NO_REPLY_REASON_LENGTH,
  WAKE_REASONS,
  inputError,
  internalError,
  isToolError,
  isRecord,
  nextEveryOccurrence,
  requireFuture,
  resolveAtInput,
  toAlarmView,
  validatePrompt,
  type Alarm,
  type AlarmTrigger,
  type AtInput,
  type DeliveryHint,
  type ToolError,
  type WakeReason
} from "./domain.js";
import type { ProactiveConfig } from "./config.js";
import type { ProactiveStore } from "./store.js";
import type { ProactiveScheduler } from "./scheduler.js";
import type { WakeDriver } from "./wake.js";

export interface ToolServices {
  store: ProactiveStore;
  config: ProactiveConfig;
  driver: WakeDriver;
  scheduler: ProactiveScheduler;
  now: () => number;
}

/** 10 years in seconds — a safe ceiling so epoch math can never escape the Date range. */
const MAX_DELAY_SECONDS = 10 * 365 * 86400;

const ERROR_SCHEMA: ValueSchemaSpec = {
  type: "object",
  additionalProperties: false,
  properties: {
    code: { type: "string", required: true },
    message: { type: "string", required: true }
  }
};

const ALARM_VIEW_SCHEMA: ValueSchemaSpec = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    mode: { type: "string", required: true, enum: ["one-shot", "repeat"] },
    wakeReason: { type: "string", required: true, enum: WAKE_REASONS },
    prompt: { type: "string", required: true },
    nextDueAt: { type: "string", required: true },
    state: { type: "string", required: true, enum: ["scheduled", "overdue", "in-flight", "completed", "cancelled", "failed"] },
    deliveryMode: { type: "string", required: true, const: "host" }
  }
};

function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: "text" as const, text: JSON.stringify(value) }] as ContentBlock[];
}

function presentCard(title: string, rawInput: string): ToolCallView {
  return { card: "generic" as const, title, kind: "other", rawInput };
}

/** A validated proactive_set request, ready to become an alarm. */
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

/** Closed validation of the open parameter root. */
function validateCreateArgs(args: Record<string, unknown>): CreateSpec | ToolError {
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

function normalizeDelivery(value: unknown): DeliveryHint | undefined {
  if (value === undefined) return { chat: true, push: true, wechat: true };
  if (!isRecord(value)) return undefined;
  const booleans = (key: string): boolean => (typeof value[key] === "boolean" ? (value[key] as boolean) : true);
  return { chat: booleans("chat"), push: booleans("push"), wechat: booleans("wechat") };
}

function allocateId(prefix: string): string {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Resolve the canonical trigger + nextDueAt for a validated create request. */
function buildAlarm(sessionId: string, spec: CreateSpec, nowStart: number): { alarm: Alarm } | ToolError {
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

function newAlarm(
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

/** Build the four tool definitions bound to one agent + its host services. */
export function proactiveToolDefinitions(agent: Agent, services: ToolServices): ToolDefinition[] {
  return [
        defineTool({
          name: "proactive_set",
          description: "Create one host-level alarm for this session. Supply a non-empty prompt and exactly one selector: a positive safe-integer after_seconds delay, an explicit-zone 'at' date-time, or every_seconds of at least 300 for a fixed-rate repeat. The alarm fires even when this session is cold; the wake turn is framed so the model can stay silent with proactive_no_reply.",
          parameters: {
            prompt: { type: "string", required: true, description: "What the wake turn should do, in the user's language and context. Plain, concrete instruction." },
            at: {
              oneOf: [
                { type: "string", description: "Strict RFC 3339 date-time with explicit zone, e.g. 2026-09-01T09:30:00+08:00." },
                { type: "object", additionalProperties: false, properties: { date: { type: "string", required: true, description: "YYYY-MM-DD" }, time: { type: "string", required: true, description: "HH:mm:ss" }, time_zone: { type: "string", required: true, description: "IANA Area/Location" } } }
              ],
              description: "Absolute target with an explicit or implied time zone."
            },
            after_seconds: { type: "integer", description: "Positive delay in seconds from now." },
            every_seconds: { type: "integer", description: "Fixed rate in seconds, at least 300; occurrences align to creation time and missed ones are skipped." },
            time_zone: { type: "string", description: "IANA Area/Location used for at alignment and quiet-hours reporting (default UTC)." },
            delivery: { type: "object", additionalProperties: false, properties: { chat: { type: "boolean", description: "Chat text allowed (default true)" }, push: { type: "boolean", description: "push_notify allowed (default true)" }, wechat: { type: "boolean", description: "send_wechat allowed (default true)" } }, description: "Allowed delivery channels for the wake turn." },
            wake_reason: { type: "string", enum: WAKE_REASONS, description: "check_in: habit-coach follow-up | alarm: user-requested reminder (quiet-hours exempt) | interval: periodic follow-up | companion: companion interaction. Default alarm." }
          },
          output: {
            schema: { oneOf: [ALARM_VIEW_SCHEMA, ERROR_SCHEMA] },
            render: renderValue
          },
          async execute(args, exec) {
            if (exec.agent !== agent) return internalError();
            const shape = validateCreateArgs(args as Record<string, unknown>);
            if (isToolError(shape)) return shape;
            if (services.store.corrupt) return { code: "corrupt_store", message: "The alarm store is corrupt; fix or remove alarms.json." } as ToolError;
            const built = buildAlarm(agent.session.id, shape, services.now());
            if (isToolError(built)) return built;
            const { alarm } = built;
            services.store.addAlarm(alarm);
            try {
              await services.store.persist();
            } catch {
              services.store.removeAlarm(alarm.id);
              return { code: "persistence_uncertain", message: "The alarm was not durably stored; please retry." } as ToolError;
            }
            services.scheduler.requestDrive();
            return toAlarmView(alarm, services.now());
          },
          presentCall: (callArgs) => presentCard("Create proactive alarm", String((callArgs as { prompt?: unknown })["prompt"] ?? ""))
        }),

        defineTool({
          name: "proactive_list",
          description: "List this session's active host-level alarms (scheduled, overdue, in-flight) in creation order with exact ids and states.",
          parameters: {},
          output: {
            schema: { oneOf: [{ type: "array", items: ALARM_VIEW_SCHEMA }, ERROR_SCHEMA] },
            render: renderValue
          },
          async execute(_args, exec) {
            if (exec.agent !== agent) return internalError();
            const now = services.now();
            const alarms = services.store
              .listAlarms()
              .filter((alarm) => alarm.sessionId === agent.session.id && (alarm.status === "scheduled" || alarm.status === "in-flight"))
              .map((alarm) => toAlarmView(alarm, now));
            return alarms;
          },
          presentCall: () => presentCard("List proactive alarms", "")
        }),

        defineTool({
          name: "proactive_cancel",
          description: "Cancel one active host-level alarm in this session by its exact id from proactive_set or proactive_list. Unknown or already-finished ids return a not_found error.",
          parameters: {
            id: { type: "string", required: true, description: "Exact alarm id." }
          },
          output: {
            schema: { oneOf: [{ type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, cancelled: { type: "boolean", required: true, const: true } } }, ERROR_SCHEMA] },
            render: renderValue
          },
          async execute(args, exec) {
            if (exec.agent !== agent) return internalError();
            const id = typeof args["id"] === "string" ? args["id"] : "";
            const alarm = services.store.getAlarm(id);
            if (alarm === undefined || alarm.sessionId !== agent.session.id || alarm.status === "completed" || alarm.status === "cancelled") {
              return { code: "not_found", message: "No active alarm with id " + id + " in this session." } as ToolError;
            }
            services.store.removeAlarm(id);
            try {
              await services.store.persist();
            } catch {
              services.store.addAlarm(alarm);
              return { code: "persistence_uncertain", message: "The cancellation was not durably stored; please retry." } as ToolError;
            }
            services.scheduler.requestDrive();
            return { id, cancelled: true };
          },
          presentCall: (callArgs) => presentCard("Cancel proactive alarm", String((callArgs as { id?: unknown })["id"] ?? ""))
        }),

        defineTool({
          name: "proactive_no_reply",
          description: "Conclude the current proactive wake turn in complete silence: call it as the ONLY action with no chat text so the wake stays invisible to the user. Any visible output already committed before this call still counts toward the delivery budget.",
          parameters: {
            reason: { type: "string", description: "Short internal reason for the run log, at most " + MAX_NO_REPLY_REASON_LENGTH + " characters." }
          },
          output: {
            schema: { oneOf: [{ type: "object", additionalProperties: false, properties: { accepted: { type: "boolean", required: true, const: true }, silent: { type: "boolean", required: true, const: true } } }, ERROR_SCHEMA] },
            render: renderValue
          },
          async execute(args, exec) {
            if (exec.agent !== agent) return internalError();
            const reason = typeof args["reason"] === "string" ? args["reason"] : "";
            if (reason.length > MAX_NO_REPLY_REASON_LENGTH) {
              return { code: "invalid_trigger", message: "reason must be at most " + MAX_NO_REPLY_REASON_LENGTH + " characters." } as ToolError;
            }
            if (!services.driver.isActiveWake(agent.session.id)) {
              return { code: "no_active_wake", message: "proactive_no_reply is only available during a dsh-proactive wake turn." } as ToolError;
            }
            exec.concludeTurn();
            return { accepted: true, silent: true };
          },
          presentCall: (callArgs) => presentCard("Silent wake acknowledgment", String((callArgs as { reason?: unknown })["reason"] ?? ""))
        })
      ];
}

/**
 * Register the four tools on an agent's scoped context; returns disposable
 * tools. The definitions themselves live in {@link proactiveToolDefinitions}
 * so they can be unit-tested without a cordis context.
 */
export function registerProactiveTools(agentCtx: Context, agent: Agent, services: ToolServices): { disposer: () => void } {
  return {
    disposer: agentCtx.effect(() => {
      const definitions = proactiveToolDefinitions(agent, services);
      const disposers = definitions.map((definition) => agentCtx.tools.register(definition));
      return () => {
        for (const disposer of disposers) disposer();
      };
    }, "dsh-proactive:tools")
  };
}

export type { Alarm, WakeReason };
