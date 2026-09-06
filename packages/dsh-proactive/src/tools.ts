/**
 * Agent-scoped proactive alarm tools. Registered on every root agent's scoped
 * context (re-registration happens for resumed agents via agent/created).
 *
 *   proactive_set       create one host-level alarm for this session
 *   proactive_list      view this session's active alarms
 *   proactive_cancel    cancel one of this session's alarms
 *   proactive_no_reply  conclude the current wake turn with deep silence
 *   proactive_update_settings  partially update host-level settings (only the given fields)
 *
 * The stores they touch are host-level (the plugin singleton), so they work
 * identically in cold-wake turns and in ordinary user turns.
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolCallView, type ToolDefinition, type ValueSchemaSpec } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonValue } from "@deepseek-ai/dsh-session";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  MAX_NO_REPLY_REASON_LENGTH,
  MAX_PROMPT_LENGTH,
  MIN_EVERY_SECONDS,
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
import { writeConfigFile } from "./config.js";
import type { ProactiveStore } from "./store.js";
import type { ProactiveScheduler } from "./scheduler.js";
import type { WakeDriver } from "./wake.js";
import { buildAlarm, validateCreateArgs, type CreateSpec } from "./alarm-factory.js";
import { applyHotConfig, hotSubset, validateSettingsPatch, type HotConfig } from "./settings.js";

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
    deliveryMode: { type: "string", required: true, const: "host" },
    // Optional repeat randomness; only present for jittered repeats. Deliberately
    // NOT required: dsh-tools compiles required:true per-property into the top-level
    // required array, so requiring it here would break non-jittered alarms on the
    // runtime output gate (INVALID_TOOL_OUTPUT: missing required).
    jitter: { type: "number" }
  }
};

const SETTINGS_VIEW_SCHEMA: ValueSchemaSpec = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean", required: true },
    max_deliveries_per_day: { type: "integer", required: true },
    quiet_hours: {
      type: "object",
      additionalProperties: false,
      required: true,
      properties: {
        start: { type: "string", required: true },
        end: { type: "string", required: true },
        time_zone: { type: "string", required: true }
      }
    },
    max_wakeups_per_hour: { type: "integer", required: true },
    max_concurrent_per_session: { type: "integer", required: true },
    boot_overdue_policy: { type: "string", required: true },
    max_retries_per_fire: { type: "integer", required: true },
    max_prompt_length: { type: "integer", required: true },
    heartbeat_prompt: { type: "string", required: true }
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
          description: "Create one host-level alarm for this session. Supply exactly one selector: a positive safe-integer after_seconds delay, an explicit-zone 'at' date-time, or every_seconds of at least 300 for a fixed-rate repeat (optionally with jitter 0..1 for randomized intervals). The prompt is required for wake_reason alarm (the user's instruction); it is optional for wake_reason heartbeat, where the configured default heartbeat wording is always used as the base and an optional prompt adds extra direction. The alarm fires even when this session is cold; the wake turn is framed so the model can stay silent with proactive_no_reply.",
          parameters: {
            prompt: {
              type: "string",
              description: "What the wake turn should do, in the user's language and context. Plain, concrete instruction. Optional for wake_reason=heartbeat: an omitted prompt means \"just the configured default heartbeat wording\" (the wake always leads with it); supply one only for extra direction. Required for wake_reason=alarm."
            },
            at: {
              oneOf: [
                { type: "string", description: "Strict RFC 3339 date-time with explicit zone, e.g. 2026-09-01T09:30:00+08:00." },
                { type: "object", additionalProperties: false, properties: { date: { type: "string", required: true, description: "YYYY-MM-DD" }, time: { type: "string", required: true, description: "HH:mm:ss" }, time_zone: { type: "string", required: true, description: "IANA Area/Location" } } }
              ],
              description: "Absolute target with an explicit or implied time zone."
            },
            after_seconds: { type: "integer", description: "Positive delay in seconds from now." },
            every_seconds: { type: "integer", description: "Fixed rate in seconds, at least 300; without jitter, occurrences align to creation time and missed ones are skipped." },
            jitter: { type: "number", description: "Optional repeat randomness 0..1: each interval is scaled by (1 ± jitter·uniform(0,1)) so consecutive wakes are not metronomic. 0/default = fixed rate. Only meaningful with every_seconds." },
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
        }),

        defineTool({
          name: "proactive_update_settings",
          description: "Partially update host-level dsh-proactive settings: only the fields you pass are changed, the rest keep their current values. The update is persisted to config.json and hot-applied to the running scheduler immediately, so it also affects future wake gating and heartbeat framing. Supply at least one field.",
          parameters: {
            enabled: { type: "boolean", description: "Master toggle: false pauses all proactive wakes (user-requested alarms still fire)." },
            max_deliveries_per_day: { type: "integer", description: "Visible deliveries per UTC day (chat text, push_notify, send_wechat); 0..50." },
            quiet_hours: {
              type: "object",
              additionalProperties: false,
              properties: {
                start: { type: "string", required: true, description: "HH:MM wall-clock in time_zone; window start inclusive." },
                end: { type: "string", required: true, description: "HH:MM wall-clock in time_zone; window end exclusive." },
                time_zone: { type: "string", required: true, description: "IANA Area/Location." }
              },
              description: "Quiet window; only wake_reason alarm fires inside it."
            },
            max_wakeups_per_hour: { type: "integer", description: "Host-wide cap on proactive wake turns per rolling hour; 1..60." },
            max_concurrent_per_session: { type: "integer", description: "Concurrent in-flight wake turns per session; 1..4." },
            boot_overdue_policy: { type: "string", enum: ["fire", "notify-only", "drop"], description: "How boot-time overdue alarms are treated." },
            max_retries_per_fire: { type: "integer", description: "Retry budget when a wake cannot run (busy/transient); 0..10." },
            max_prompt_length: { type: "integer", description: "Upper bound for alarm prompts; 100..20000." },
            heartbeat_prompt: { type: "string", description: "Default heartbeat wording every heartbeat wake leads with (max " + MAX_PROMPT_LENGTH + " chars)." }
          },
          output: {
            schema: { oneOf: [SETTINGS_VIEW_SCHEMA, ERROR_SCHEMA] },
            render: renderValue
          },
          async execute(args, exec) {
            if (exec.agent !== agent) return internalError();
            const shape = validateSettingsPatch(args);
            if (isToolError(shape)) return shape;
            try {
              await writeConfigFile(services.config.dataDir, shape.patch as unknown as Partial<ProactiveConfig>);
            } catch {
              return { code: "persistence_uncertain", message: "Settings were not durably stored; please retry." } as ToolError;
            }
            const next: HotConfig = { ...hotSubset(services.config), ...shape.patch };
            applyHotConfig(services.config, next);
            return settingsView(services.config);
          },
          presentCall: (callArgs) => presentCard("Update proactive settings", Object.keys((callArgs as Record<string, unknown>) ?? {}).join(", "))
        })
      ];
}

/** One read-only settings view the update tool returns (mirrors HotConfig in snake_case). */
function settingsView(config: ProactiveConfig): JsonValue {
  return {
    enabled: config.enabled,
    max_deliveries_per_day: config.maxDeliveriesPerDay,
    quiet_hours: { start: config.quietHours.start, end: config.quietHours.end, time_zone: config.quietHours.timeZone },
    max_wakeups_per_hour: config.maxWakeupsPerHour,
    max_concurrent_per_session: config.maxConcurrentPerSession,
    boot_overdue_policy: config.bootOverduePolicy,
    max_retries_per_fire: config.maxRetriesPerFire,
    max_prompt_length: config.maxPromptLength,
    heartbeat_prompt: config.heartbeatPrompt
  };
}

/**
 * Register the five tools on an agent's scoped context; returns disposable
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
