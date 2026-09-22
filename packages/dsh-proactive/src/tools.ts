/**
 * Agent-scoped proactive alarm tools. Registered on every root agent's scoped
 * context (re-registration happens for resumed agents via agent/created).
 *
 *   proactive_set       create one host-level alarm for this session
 *   proactive_list      view this session's active alarms (all=true: every session's)
 *   proactive_cancel    cancel one active alarm by exact id — any owner
 *   proactive_update    replace one active alarm's spec by exact id — any owner
 *   proactive_reclaim    nothing to do this wake turn: end it and let the host reclaim the exchange
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
import { defineTool, type ParameterSchemaSpec, type ToolCallView, type ToolDefinition, type ValueSchemaSpec } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { JsonValue } from "@deepseek-ai/dsh-session";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  DEFAULT_WAKE_PROMPT,
  MAX_JITTER_SECONDS,
  MAX_MIN_IDLE_SECONDS,
  MAX_NO_REPLY_REASON_LENGTH,
  inputError,
  internalError,
  isToolError,
  targetSourceOf,
  toAlarmView,
  type Alarm,
  type ToolError
} from "./domain.js";
import type { ProactiveConfig } from "./config.js";
import { writeConfigFile, MAX_SCHEDULE_FILES } from "./config.js";
import { liveEventsOf, type LiveSessionLike } from "./workspace.js";
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
  /**
   * Create-side workspace argument wiring (target_workspace_path / default ->
   * canonical target_workspace_id). Absent on hosts without a workspace
   * registry; workspace-targeted creates then fail closed.
   */
  resolveWorkspace?: (args: Record<string, unknown>, sessionCwd: string | undefined) => Promise<Record<string, unknown> | ToolError>;
  /**
   * The live event log of any session by id (client-zone default chain for
   * updates of alarms owned by other sessions). Absent on hosts without the
   * sessions service; timezone wiring then falls back to the host zone.
   */
  sessionEvents?: (sessionId: string) => readonly unknown[] | undefined;
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
    targetMode: { type: "string", required: true, enum: ["resume", "fork", "new", "workspace"] },
    // Present only for resume/fork targets ("workspace" is a stored v2 spelling).
    targetSource: { type: "string", enum: ["session", "workspace", "preset"] },
    // The named source session; "new" never carries one.
    targetSessionId: { type: "string" },
    // Present only for workspace-sourced or workspace-configured targets.
    targetWorkspaceId: { type: "string" },
    // Present only for preset-sourced or preset-configured targets.
    targetPresetId: { type: "string" },
    // Present only for target_mode new with a model override.
    targetProvider: { type: "string" },
    targetModel: { type: "string" },
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
    jitterSeconds: { type: "integer" },
    // The alarm's canonical zone, so a list -> update round-trip can re-supply
    // the full dialect without losing at/cron alignment.
    timeZone: { type: "string" },
    // Present only for declared (file-sourced) alarms: they refuse update/cancel.
    declaredFile: { type: "string" },
    declaredEntry: { type: "string" }
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
    boot_overdue_policy: { type: "string", required: true },
    max_retries_per_fire: { type: "integer", required: true },
    max_prompt_length: { type: "integer", required: true },
    default_prompt: { type: "string", required: true },
    silent_wake_compaction: { type: "boolean", required: true },
    schedule_files: { type: "array", items: { type: "string" } }
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
 * host didn't expose one — callers then fall back to the host zone. Reads the
 * log through the cross-version compat (`.events` ≤0.1.1, `snapshotEvents()`
 * ≥0.1.2) so timezone derivation survives host upgrades.
 */
function sessionEventsOf(agent: Agent): readonly unknown[] | undefined {
  const sessions = agent.ctx.get("sessions", false) as { get?: (id: string) => LiveSessionLike | undefined } | undefined;
  const session = sessions?.get?.(agent.session.id);
  return session === undefined ? undefined : liveEventsOf(session);
}

/** The executor session's working directory (header first, legacy meta cast second). */
function sessionCwdOf(agent: Agent): string | undefined {
  const session = agent.session as unknown as { header?: { cwd?: string }; meta?: { cwd?: string } };
  return session.header?.cwd ?? session.meta?.cwd;
}

/**
 * The open alarm-spec dialect shared verbatim by proactive_set (create) and
 * proactive_update (replace): exactly one selector, always a prompt. The
 * model tools and the panel create/edit actions accept exactly one dialect —
 * the only sanctioned difference is each tool's description of the DEFAULT
 * target (creator session on set, owning session on update).
 */
const ALARM_SPEC_PARAMETERS: ParameterSchemaSpec = {
  prompt: {
    type: "string",
    required: true,
    description:
      "What the wake turn should do, in the user's language and context. Always required. For general heartbeat or periodic check-in alarms without custom instructions, use the recommended default prompt: '" +
      DEFAULT_WAKE_PROMPT +
      "'."
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
  min_idle_seconds: { type: "integer", description: "Resume targets only: deliver the wake only after the destination session has been idle at least this many seconds, 0.." + MAX_MIN_IDLE_SECONDS + " (0 = off, default). Any session event resets the clock — including earlier wake turns — so a self-monitoring alarm enforces its own spacing; a cold session counts as idle; fork/new targets ignore it. While the destination is not idle enough, the wake is deferred silently (no run record, no retry/budget cost) and re-checked at most once a minute." },
  respect_quiet_hours: { type: "boolean", description: "false (default) = user-requested reminder, exempt from quiet hours and the daily budget. true = model-initiated style: occurrences due inside the quiet window are skipped, not postponed (once alarms complete; repeating alarms advance to the next occurrence outside the window), and the daily budget applies." },
  target_mode: { type: "string", enum: ["resume", "fork", "new", "workspace"], description: "Where the wake lands. resume (default): wake the target session itself. fork: copy the source session's completed history into a new child session and wake it there (fails when the source has no completed turn). new: wake in a brand-new empty session every fire. workspace: legacy spelling of resume with target_source workspace (still accepted). For resume/fork the source conversation is picked by target_source." },
  target_source: { type: "string", enum: ["session", "workspace", "preset"], description: "How resume/fork name their source conversation. session (default): the exact target_session_id. workspace: the workspace's most recently active session at fire time (its blank New-Session slot when only blanks exist); sessions created by proactive's own wakes are never captured, and when nothing is eligible the fire is skipped — use target_mode new to ensure a session. preset: the most recently active session running the preset (same capture and skip rules; fork fails when nothing is eligible). Inferred when omitted: target_workspace_id alone implies workspace, target_preset_id alone implies preset, otherwise session. Must be omitted when target_mode is new or workspace." },
  target_session_id: { type: "string", description: "The source session id, for target_source session. For resume this is the wake destination; for fork the parent to branch from. Default is this session. Must be omitted for any other source." },
  target_workspace_id: { type: "string", description: "Workspace registry id (uuid), for target_source workspace (or the legacy target_mode workspace). Resolved and existence-checked host-side; alternatively pass target_workspace_path or omit both (legacy mode only) to use this session's own workspace." },
  target_workspace_path: { type: "string", description: "Absolute directory path of an existing registered workspace, for target_source workspace (or the legacy target_mode workspace); resolved to its registry id host-side. The directory must already be registered as a workspace in the GUI; no workspace is auto-created." },
  target_preset_id: { type: "string", description: "Agent preset id, for target_source preset: the alarm wakes the conversation running that preset. For target_mode new it stamps the fresh session with the preset instead. Matching folds live sessions' effective preset (later selections included) and cold sessions' creation stamp." },
  target_provider: { type: "string", description: "LLM provider for the wake turn, for target_mode new only (e.g. 'deepseek'). Both target_provider and target_model must be given together to win outright; a partial pair only fills the missing side of the fallback chain." },
  target_model: { type: "string", description: "LLM model id for the wake turn, for target_mode new only. Must be a real model id on the chosen provider." },
  time_zone: { type: "string", description: "IANA Area/Location used for at/cron/quiet-hours alignment (default UTC)." },
  compaction: { type: "string", enum: ["off", "minimal", "aggressive"], description: "Per-alarm silent-wake surface compaction. off = keep the full wake exchange on the model surface; minimal (default) = tombstone keeps the proactive_reclaim reason, erases assistant reasoning and tool results; aggressive = tombstone with id+time only. Default minimal." }
};

/** Build the six tool definitions bound to one agent + its host services. */
export function proactiveToolDefinitions(agent: Agent, services: ToolServices): ToolDefinition[] {
  return [
        defineTool({
          name: "proactive_set",
          description: "Create one host-level alarm for this session. Supply exactly one selector: a positive safe-integer after_seconds delay, an explicit-zone 'at' date-time, every_seconds of at least 300 for a fixed-rate repeat, or a five-field cron expression (minute hour day-of-month month day-of-week; occurrences at least 300 seconds apart). All selectors accept the unified jitter_seconds random delay. respect_quiet_hours=false means user-requested: fires inside quiet hours and ignores the daily budget. The prompt is the user's instruction and is always required. The alarm fires even when the target session is cold; the wake turn is framed so the model can stay silent.",
          parameters: ALARM_SPEC_PARAMETERS,
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
            let wired = wireTimeZones(args as Record<string, unknown>, sessionEventsOf(agent));
            // Workspace arguments are the async half of the same pre-validation
            // wiring: path / default-cwd spellings normalize to a canonical,
            // existence-checked target_workspace_id.
            if (wired["target_mode"] === "workspace" || wired["target_workspace_id"] !== undefined || wired["target_workspace_path"] !== undefined) {
              if (services.resolveWorkspace === undefined) {
                return { code: "not_found", message: "workspace targets are unavailable on this host (no workspace registry)." } as ToolError;
              }
              const resolved = await services.resolveWorkspace(wired, sessionCwdOf(agent));
              if (isToolError(resolved)) return resolved;
              wired = resolved;
            }
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
          description: "Cancel one active host-level alarm by its exact id from proactive_set or proactive_list — including alarms owned by other sessions (find their ids with proactive_list all=true, e.g. when the user asks you to clean up reminders made elsewhere). Unknown or already-finished ids return a not_found error.",
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
            if (alarm === undefined || alarm.status === "completed" || alarm.status === "cancelled") {
              return { code: "not_found", message: "No active alarm with id " + id + "." } as ToolError;
            }
            if (alarm.declared !== undefined) {
              return { code: "invalid_action", message: "Alarm " + id + " is declared by schedule file " + alarm.declared.file + " (entry \"" + alarm.declared.entry + "\"); edit or remove the entry in that file instead — a cancellation would be undone by the next sync." } as ToolError;
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
          name: "proactive_update",
          description: "Replace one active host-level alarm's full spec by its exact id — any owner, including alarms created by other sessions (ids via proactive_list all=true). Same dialect as proactive_set: the prompt and exactly one selector are always required, and every given field replaces the old value (a field you omit falls back to its dialect default, NOT to the old value — read the current spec from proactive_list first). The id, owning session, creation time, and run history are preserved; a paused alarm is resumed. Cannot edit in-flight, completed, cancelled, or failed alarms.",
          parameters: {
            id: { type: "string", required: true, description: "Exact alarm id to update." },
            ...ALARM_SPEC_PARAMETERS,
            target_session_id: { type: "string", description: "The source session id, for target_source session. For resume the wake destination, for fork the parent; default is the alarm's OWNING session (not necessarily this one). Must be omitted for any other source." },
            target_workspace_id: { type: "string", description: "Workspace registry id (uuid), for target_source workspace. Resolved and existence-checked host-side; alternatively pass target_workspace_path, or omit both to keep the alarm's current workspace (a non-workspace alarm being switched with none given uses this session's own workspace)." },
            target_workspace_path: { type: "string", description: "Absolute directory path of an existing registered workspace, for target_source workspace; resolved to its registry id host-side. When this and target_workspace_id are both omitted: a workspace-sourced alarm keeps its current workspace, a non-workspace alarm being switched uses this session's own workspace." },
            target_preset_id: { type: "string", description: "Agent preset id, for target_source preset or target_mode new. Omitted while keeping a preset-sourced alarm: the alarm's current preset carries over." },
            target_provider: { type: "string", description: "LLM provider for the wake turn, target_mode new only. Omitted while updating a new-mode alarm: the stored provider carries over." },
            target_model: { type: "string", description: "LLM model id for the wake turn, target_mode new only. Omitted while updating a new-mode alarm: the stored model carries over." }
          },
          output: {
            schema: { oneOf: [ALARM_VIEW_SCHEMA, ERROR_SCHEMA] },
            render: renderValue
          },
          async execute(args, exec) {
            if (exec.agent !== agent) return internalError();
            const id = typeof args["id"] === "string" ? args["id"] : "";
            const current = services.store.getAlarm(id);
            if (current === undefined) {
              return { code: "not_found", message: "No alarm with id " + id + "." } as ToolError;
            }
            if (current.status === "in-flight" || current.status === "completed" || current.status === "cancelled" || current.status === "failed") {
              return { code: "invalid_action", message: "Alarm " + id + " cannot be edited in its current state." } as ToolError;
            }
            if (current.declared !== undefined) {
              return { code: "invalid_action", message: "Alarm " + id + " is declared by schedule file " + current.declared.file + " (entry \"" + current.declared.entry + "\"); edit the entry in that file instead — an update here would be overwritten by the next sync." } as ToolError;
            }
            if (services.store.corrupt) return { code: "corrupt_store", message: "The alarm store is corrupt; fix or remove alarms.json." } as ToolError;
            // Strip the id: the create dialect validates an exact key set.
            const { id: _drop, ...spec } = args as Record<string, unknown>;
            // Zone default chain follows the OWNING session's client (the
            // alarm belongs to its owner, not to whoever happens to edit it).
            let wired = wireTimeZones(spec, services.sessionEvents?.(current.ownerSessionId));
            // v3 carryovers (full-replace dialect): a source/target field the
            // caller leaves out keeps the alarm's current spelling — an edit of
            // just the schedule must not silently retarget the conversation.
            // They only fire when NO source-naming arg is present (an explicit
            // retarget to another source must win, not collide).
            const prev = current.target;
            const noSourceNamed = wired["target_session_id"] === undefined && wired["target_workspace_id"] === undefined && wired["target_workspace_path"] === undefined && wired["target_preset_id"] === undefined;
            // "Nothing selected" = the update neither names a source/mode nor
            // any source id: a bare schedule edit keeps the conversation.
            const nothingSelected = noSourceNamed && wired["target_source"] === undefined && wired["target_mode"] === undefined;
            // The carryover injects the already-resolved workspace id; the
            // resolver gate below must then stay closed (no re-check — a
            // vanished workspace still lets the user retarget the alarm
            // instead of blocking the edit).
            let workspaceCarriedOver = false;
            if (prev.mode === "resume" || prev.mode === "fork") {
              const source = targetSourceOf(prev);
              if (source === "workspace" && noSourceNamed && (nothingSelected || wired["target_source"] === "workspace")) {
                wired = { ...wired, target_workspace_id: prev.workspaceId };
                workspaceCarriedOver = true;
              } else if (source === "preset" && noSourceNamed && (nothingSelected || wired["target_source"] === "preset")) {
                wired = { ...wired, target_preset_id: prev.presetId };
              }
              // source session: no carryover — the dialect default (the
              // owning session) IS derivable and documented, per v2.
            } else if (prev.mode === "workspace" && noSourceNamed && (nothingSelected || wired["target_mode"] === "workspace")) {
              wired = { ...wired, target_workspace_id: prev.workspaceId };
              workspaceCarriedOver = true;
            } else if (prev.mode === "new" && wired["target_mode"] === "new") {
              if (wired["target_preset_id"] === undefined && prev.presetId !== undefined) wired = { ...wired, target_preset_id: prev.presetId };
              if (wired["target_provider"] === undefined && prev.provider !== undefined) wired = { ...wired, target_provider: prev.provider };
              if (wired["target_model"] === undefined && prev.model !== undefined) wired = { ...wired, target_model: prev.model };
            }
            if (!workspaceCarriedOver && (wired["target_mode"] === "workspace" || wired["target_source"] === "workspace" || wired["target_workspace_id"] !== undefined || wired["target_workspace_path"] !== undefined)) {
              if (services.resolveWorkspace === undefined) {
                return { code: "not_found", message: "workspace targets are unavailable on this host (no workspace registry)." } as ToolError;
              }
              const resolved = await services.resolveWorkspace(wired, sessionCwdOf(agent));
              if (isToolError(resolved)) return resolved;
              wired = resolved;
            }
            const shape = validateCreateArgs(wired, current.ownerSessionId);
            if (isToolError(shape)) return shape;
            const built = buildAlarm(current.ownerSessionId, shape, services.now());
            if (isToolError(built)) return built;
            // Keep identity + run history; replace the trigger-facing fields.
            const updated: Alarm = {
              ...built.alarm,
              id: current.id,
              ownerSessionId: current.ownerSessionId,
              createdAt: current.createdAt,
              runCount: current.runCount,
              lastRunAt: current.lastRunAt,
              status: "scheduled",
              updatedAt: new Date(services.now()).toISOString()
            };
            services.store.replaceAlarm(updated);
            try {
              await services.store.persist();
            } catch {
              services.store.replaceAlarm(current);
              return { code: "persistence_uncertain", message: "The alarm change was not durably stored; please retry." } as ToolError;
            }
            services.scheduler.requestDrive();
            return toAlarmView(updated, services.now());
          },
          presentCall: (callArgs) => presentCard("Update proactive alarm", String((callArgs as { id?: unknown })["id"] ?? ""))
        }),

        defineTool({
          name: "proactive_reclaim",
          description: "Nothing to do this dsh-proactive wake turn? Call proactive_reclaim as your ONLY action with no chat text — the host reclaims the entire wake exchange, collapsing it off the model surface. Only available during an active dsh-proactive wake. If you did work but no user-facing message is needed, end the turn with no chat text instead, or use a no-reply tool if one is available on this host — that keeps your work in context. Any chat text already committed before this call still counts toward the daily budget.",
          parameters: {
            reason: { type: "string", description: "Short internal reason, at most " + MAX_NO_REPLY_REASON_LENGTH + " characters. Recorded in the run history and the compaction tombstone." }
          },
          output: {
            schema: { oneOf: [{ type: "object", additionalProperties: false, properties: { accepted: { type: "boolean", required: true, const: true }, silent: { type: "boolean", required: true, const: true } } }, ERROR_SCHEMA] },
            render: renderValue
          },
          async execute(args, exec) {
            if (exec.agent !== agent) return internalError();
            // Only meaningful inside an active wake: the reclaim/compact path
            // is a wake-turn concept. Outside a wake, surface a closed error
            // so the model can end with no text, or use a no-reply tool if
            // one is available — no hard coupling to any other plugin.
            if (!services.driver.isActiveWake(agent.session.id)) {
              return { code: "invalid_action", message: "proactive_reclaim is only available during an active dsh-proactive wake. To stay silent in an ordinary turn, produce no chat text, or use a no-reply tool if one is available." } as ToolError;
            }
            const reason = typeof args["reason"] === "string" ? args["reason"] : "";
            if (reason.length > MAX_NO_REPLY_REASON_LENGTH) {
              return { code: "invalid_trigger", message: "reason must be at most " + MAX_NO_REPLY_REASON_LENGTH + " characters." } as ToolError;
            }
            exec.concludeTurn();
            return { accepted: true, silent: true };
          },
          presentCall: (callArgs) => presentCard("Wake reclaimed (silent)", String((callArgs as { reason?: unknown })["reason"] ?? ""))
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
              description: "Quiet window; alarms that respect quiet hours skip occurrences inside it (repeating alarms advance to the next occurrence outside)."
            },
            max_wakeups_per_hour: { type: "integer", description: "Host-wide cap on proactive wake turns per rolling hour; 1..60." },
            boot_overdue_policy: { type: "string", enum: ["fire", "notify-only", "drop"], description: "How boot-time overdue alarms are treated." },
            max_retries_per_fire: { type: "integer", description: "Retry budget when a wake cannot run (busy/transient); 0..10." },
            max_prompt_length: { type: "integer", description: "Upper bound for alarm prompts; 100..20000." },
            default_prompt: { type: "string", description: "Default wake-up instruction pre-filled into the GUI create form; non-empty, at most 20000 characters. Purely a prefill — stored alarms always keep their own prompt." },
            silent_wake_compaction: { type: "boolean", description: "Master gate for silent-wake tombstone compaction (default true); a per-alarm compaction of 'off' still keeps that alarm's full exchange on the model surface." },
            schedule_files: {
              type: "array",
              items: { type: "string" },
              description: "Declared-schedule source files: absolute glob paths (supports * within a segment, ** across segments, ? one character) whose JSON entries sync into host alarms idempotently; e.g. ['/srv/agents/*/.life/wake_schedule.json']. Empty array = feature off. Takes effect within one poll cycle (schedule_poll_seconds, default 60)."
            }
          },
          output: {
            schema: { oneOf: [SETTINGS_VIEW_SCHEMA, ERROR_SCHEMA] },
            render: renderValue
          },
          async execute(args, exec) {
            if (exec.agent !== agent) return internalError();
            // schedule_files is intentionally OUTSIDE HotConfig: the settings
            // namespace schema does not declare it, so a settings watch would
            // strip it and the hot-apply would clobber it back to undefined.
            // It is validated here, persisted via config.json, and applied
            // directly onto the live config the sync loop reads each tick.
            const rawScheduleFiles = args["schedule_files"];
            const rest: Record<string, unknown> = { ...args };
            delete rest["schedule_files"];
            let scheduleFiles: string[] | undefined;
            if (rawScheduleFiles !== undefined) {
              if (!Array.isArray(rawScheduleFiles)) {
                return { code: "invalid_trigger", message: "schedule_files must be an array of absolute glob path strings." } as ToolError;
              }
              const seen: string[] = [];
              for (const entry of rawScheduleFiles) {
                if (typeof entry !== "string" || entry.length === 0 || entry.length > 512 || !entry.startsWith("/") || entry.includes("\0")) {
                  return { code: "invalid_trigger", message: "schedule_files entries must be non-empty absolute paths of at most 512 characters." } as ToolError;
                }
                if (!seen.includes(entry)) seen.push(entry);
                if (seen.length > MAX_SCHEDULE_FILES) {
                  return { code: "invalid_trigger", message: "schedule_files accepts at most " + MAX_SCHEDULE_FILES + " patterns." } as ToolError;
                }
              }
              scheduleFiles = seen;
            }
            const shape = validateSettingsPatch(rest);
            if (isToolError(shape) && scheduleFiles === undefined) return shape;
            const patch = isToolError(shape) ? {} : shape.patch;
            try {
              await writeConfigFile(services.config.dataDir, { ...patch, ...(scheduleFiles !== undefined ? { scheduleFiles } : {}) } as unknown as Partial<ProactiveConfig>);
            } catch {
              return { code: "persistence_uncertain", message: "Settings were not durably stored; please retry." } as ToolError;
            }
            if (!isToolError(shape)) {
              const next: HotConfig = { ...hotSubset(services.config), ...shape.patch };
              applyHotConfig(services.config, next);
            }
            if (scheduleFiles !== undefined) services.config.scheduleFiles = scheduleFiles;
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
    boot_overdue_policy: config.bootOverduePolicy,
    max_retries_per_fire: config.maxRetriesPerFire,
    max_prompt_length: config.maxPromptLength,
    default_prompt: config.defaultPrompt,
    silent_wake_compaction: config.silentWakeCompaction,
    schedule_files: [...config.scheduleFiles]
  };
}

/**
 * Register the six tools on an agent's scoped context; returns disposable
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