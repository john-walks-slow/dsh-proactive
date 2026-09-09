/**
 * Agent-scoped proactive alarm tools. Registered on every root agent's scoped
 * context (re-registration happens for resumed agents via agent/created).
 *
 *   proactive_set       create one host-level alarm for this session
 *   proactive_list      view this session's active alarms
 *   proactive_cancel    cancel one of this session's alarms
 *   no_reply             conclude the current turn with deep silence
 *   proactive_update_settings  partially update host-level settings (only the given fields)
 *
 * The stores they touch are host-level (the plugin singleton), so they work
 * identically in cold-wake turns and in ordinary user turns.
 *
 * v2 (260907-proactive-alarm-v2): the wake_reason dial is gone; proactive_set
 * now takes exactly one of at | after_seconds | every_seconds | cron (the
 * alarm type falls out of it) plus the unified jitter_seconds, the
 * respect_quiet_hours switch (default false) and the target_mode /
 * target_session_id destination (default: this session, i.e. resume).
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolCallView, type ToolDefinition, type ValueSchemaSpec } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonValue } from "@deepseek-ai/dsh-session";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  MAX_JITTER_SECONDS,
  MAX_NO_REPLY_REASON_LENGTH,
  inputError,
  internalError,
  isToolError,
  toAlarmView,
  type Alarm,
  type ToolError
} from "./domain.js";
import type { ProactiveConfig } from "./config.js";
import { writeConfigFile } from "./config.js";
import type { ProactiveStore } from "./store.js";
import type { ProactiveScheduler } from "./scheduler.js";
import type { WakeDriver } from "./wake.js";
import { buildAlarm, validateCreateArgs } from "./alarm-factory.js";
import { effectiveTimeZone, wireTimeZones } from "./zone.js";
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
    sessionId: { type: "string", required: true },
    type: { type: "string", required: true, enum: ["once", "every", "cron"] },
    targetMode: { type: "string", required: true, enum: ["resume", "fork", "new"] },
    // Present only for resume/fork targets; "new" never carries one.
    targetSessionId: { type: "string" },
    respectQuietHours: { type: "boolean", required: true },
    prompt: { type: "string", required: true },
    nextDueAt: { type: "string", required: true },
    state: { type: "string", required: true, enum: ["scheduled", "overdue", "in-flight", "completed", "cancelled", "failed", "paused"] },
    deliveryMode: { type: "string", required: true, const: "host" },
    compaction: { type: "string", required: true, enum: ["off", "minimal", "aggressive"] },
    // Optional trigger specifics; present only for the matching alarm type.
    // Deliberately NOT required: dsh-tools compiles required:true per-property
    // into the top-level required array, so requiring these here would break
    // the runtime output gate (INVALID_TOOL_OUTPUT: missing required).
    everySeconds: { type: "integer" },
    cron: { type: "string" },
    at: { type: "string" },
    jitterSeconds: { type: "integer" }
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
    default_prompt: { type: "string", required: true }
  }
};

function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: "text" as const, text: JSON.stringify(value) }] as ContentBlock[];
}

function presentCard(title: string, rawInput: string): ToolCallView {
  return { card: "generic" as const, title, kind: "other", rawInput };
}


/**
 * The executor's session events (live in-memory store), or undefined when the
 * host didn't expose one — callers then fall back to the host zone.
 */
function sessionEventsOf(agent: Agent): readonly unknown[] | undefined {
  const sessions = agent.ctx.get("sessions", false) as { get?: (id: string) => { events?: readonly unknown[] } | undefined } | undefined;
  return sessions?.get?.(agent.session.id)?.events;
}

/** Build the five tool definitions bound to one agent + its host services. */
export function proactiveToolDefinitions(agent: Agent, services: ToolServices): ToolDefinition[] {
  return [
        defineTool({
          name: "proactive_set",
          description: "Create one host-level alarm for this session. Supply exactly one selector: a positive safe-integer after_seconds delay, an explicit-zone 'at' date-time, every_seconds of at least 300 for a fixed-rate repeat, or a five-field cron expression (minute hour day-of-month month day-of-week; occurrences at least 300 seconds apart). All selectors accept the unified jitter_seconds random delay. respect_quiet_hours=false means user-requested: fires inside quiet hours and ignores the daily budget. The prompt is the user's instruction and is always required. The alarm fires even when the target session is cold; the wake turn is framed so the model can stay silent with no_reply.",
          parameters: {
            prompt: {
              type: "string",
              required: true,
              description: "What the wake turn should do, in the user's language and context. Plain, concrete instruction; always required."
            },
            at: {
              oneOf: [
                { type: "string", description: "Strict RFC 3339 date-time with explicit zone, e.g. 2026-09-01T09:30:00+08:00." },
                { type: "object", additionalProperties: false, properties: { date: { type: "string", required: true, description: "YYYY-MM-DD" }, time: { type: "string", required: true, description: "HH:mm:ss" }, time_zone: { type: "string", required: true, description: "IANA Area/Location" } } }
              ],
              description: "Absolute target with an explicit or implied time zone."
            },
            after_seconds: { type: "integer", description: "Positive delay in seconds from now." },
            every_seconds: { type: "integer", description: "Fixed rate in seconds, at least 300; occurrences align to creation time and missed ones are skipped." },
            cron: { type: "string", description: "Five-field numeric cron expression, e.g. '0 9 * * 1-5' (minute hour day-of-month month day-of-week; 0 and 7 = Sunday; dom/dow OR rule; no names, '?' or seconds)." },
            jitter_seconds: { type: "integer", description: "Unified per-occurrence random delay in seconds, 0.." + MAX_JITTER_SECONDS + " (0 = exact timing). Each fire is delayed by a uniform random amount drawn from (0, jitter_seconds]; absent/0 = no jitter." },
            respect_quiet_hours: { type: "boolean", description: "false (default) = user-requested reminder, exempt from quiet hours and the daily budget. true = model-initiated style: defers inside the quiet window and is skipped when the daily budget is exhausted." },
            target_mode: { type: "string", enum: ["resume", "fork", "new"], description: "resume (default): wake the target session itself. fork: copy the target session's completed history into a new child session and wake it there. new: wake in a brand-new empty session. Fork/new children are real sessions that stay in the sidebar." },
            target_session_id: { type: "string", description: "Wake destination (any dsh session id). For resume/fork the target session; default is this session. Must be omitted when target_mode is new." },
            time_zone: { type: "string", description: "IANA Area/Location used for at/cron/quiet-hours alignment (default UTC)." },
            compaction: { type: "string", enum: ["off", "minimal", "aggressive"], description: "Per-alarm silent-wake surface compaction. off = keep the full wake exchange on the model surface; minimal (default) = tombstone keeps the no_reply reason, erases assistant reasoning and tool results; aggressive = tombstone with id+time only. Default minimal." }
          },
          output: {
            schema: { oneOf: [ALARM_VIEW_SCHEMA, ERROR_SCHEMA] },
            render: renderValue
          },
          async execute(args, exec) {
            if (exec.agent !== agent) return internalError();
            // time_zone is optional: resolve the caller's zone (explicit wins —
            // including a zone-bearing at object — else the session's browser
            // zone, else the host zone) before the closed validation sees an
            // empty slot.
            const wired = wireTimeZones(args as Record<string, unknown>, sessionEventsOf(agent));
            const shape = validateCreateArgs(wired, agent.session.id);
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
          description: "List this session's active host-level alarms (scheduled, overdue, in-flight) in creation order with exact ids and states. Pass all=true to list active alarms across ALL sessions, not just this one — useful when the user asks to enumerate every alarm or you need to manage alarms owned by other sessions.",
          parameters: {
            all: { type: "boolean", description: "When true, list active alarms across all sessions instead of only this session's. Default false." }
          },
          output: {
            schema: { oneOf: [{ type: "array", items: ALARM_VIEW_SCHEMA }, ERROR_SCHEMA] },
            render: renderValue
          },
          async execute(args, exec) {
            if (exec.agent !== agent) return internalError();
            const now = services.now();
            const all = args["all"] === true;
            const alarms = services.store
              .listAlarms()
              .filter((alarm) => (all || alarm.ownerSessionId === agent.session.id) && (alarm.status === "scheduled" || alarm.status === "in-flight"))
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
            if (alarm === undefined || alarm.ownerSessionId !== agent.session.id || alarm.status === "completed" || alarm.status === "cancelled") {
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
          name: "no_reply",
          description: "Conclude the current turn in complete silence: call it as the ONLY action with no chat text, so nothing is visible to the user. Available in any turn; during a dsh-proactive wake it also records a no_reply run entry with your reason. Any chat text already committed before this call still counts toward the daily budget.",
          parameters: {
            reason: { type: "string", description: "Short internal reason, at most " + MAX_NO_REPLY_REASON_LENGTH + " characters. Only recorded during a dsh-proactive wake." }
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
            exec.concludeTurn();
            return { accepted: true, silent: true };
          },
          presentCall: (callArgs) => presentCard("Silent turn acknowledgment", String((callArgs as { reason?: unknown })["reason"] ?? ""))
        }),

        defineTool({
          name: "proactive_update_settings",
          description: "Partially update host-level dsh-proactive settings: only the fields you pass are changed, the rest keep their current values. The update is persisted to config.json and hot-applied to the running scheduler immediately. Supply at least one field.",
          parameters: {
            enabled: { type: "boolean", description: "Master toggle: false pauses all proactive wakes (user-requested alarms still fire)." },
            max_deliveries_per_day: { type: "integer", description: "Visible chat-text deliveries per UTC day; 0..50." },
            quiet_hours: {
              type: "object",
              additionalProperties: false,
              properties: {
                start: { type: "string", required: true, description: "HH:MM wall-clock in time_zone; window start inclusive." },
                end: { type: "string", required: true, description: "HH:MM wall-clock in time_zone; window end exclusive." },
                time_zone: { type: "string", required: true, description: "IANA Area/Location." }
              },
              description: "Quiet window; alarms that respect quiet hours defer inside it."
            },
            max_wakeups_per_hour: { type: "integer", description: "Host-wide cap on proactive wake turns per rolling hour; 1..60." },
            max_concurrent_per_session: { type: "integer", description: "Concurrent in-flight wake turns per session; 1..4." },
            boot_overdue_policy: { type: "string", enum: ["fire", "notify-only", "drop"], description: "How boot-time overdue alarms are treated." },
            max_retries_per_fire: { type: "integer", description: "Retry budget when a wake cannot run (busy/transient); 0..10." },
            max_prompt_length: { type: "integer", description: "Upper bound for alarm prompts; 100..20000." },
            default_prompt: { type: "string", description: "Default wake-up instruction pre-filled into the GUI create form; non-empty, at most 20000 characters. Purely a prefill — stored alarms always keep their own prompt." }
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
    default_prompt: config.defaultPrompt
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

export type { Alarm };