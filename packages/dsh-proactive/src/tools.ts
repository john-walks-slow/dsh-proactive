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
import { buildAlarm, validateCreateArgs, type CreateSpec } from "./alarm-factory.js";

export interface ToolServices {
  store: ProactiveStore;
  config: ProactiveConfig;
  driver: WakeDriver;
  scheduler: ProactiveScheduler;
  now: () => number;
}


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
    // Deliberately no enum: persisted alarms may still carry legacy wake
    // reasons ("interval"/"companion" from before the merge). dsh-tools
    // validates tool OUTPUT against this schema at runtime, so an enum here
    // would make proactive_list throw INVALID_TOOL_OUTPUT for such alarms.
    // Creation stays closed: proactive_set's parameter enum is the gate.
    wakeReason: { type: "string", required: true },
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
            wake_reason: { type: "string", enum: WAKE_REASONS, description: "heartbeat: model-initiated periodic check-in (gated by quiet hours and daily budget) | alarm: user-requested reminder (quiet-hours and budget exempt). Default alarm." }
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
          description: "Conclude the current proactive wake turn in complete silence (available on every wake reason, including user-requested alarms): call it as the ONLY action with no chat text so the wake stays invisible to the user. Any visible output already committed before this call still counts toward the delivery budget.",
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
