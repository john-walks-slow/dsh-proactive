/**
 * Host-side panel service: snapshots, closed actions, and run history for the
 * GUI panel. Mutations go through the same alarm factory as the model tools
 * and end with the same store + scheduler wiring, so the panel is a second
 * surface over one domain, never a parallel implementation.
 *
 * v2 (260907-proactive-alarm-v2): ownership moved to the alarm's creator
 * (ownerSessionId); fork/new wakes land in child sessions, so the session
 * view shows a run when it happened IN the session OR the alarm it belongs
 * to is owned BY the session.
 */

import { isRecord, isToolError, isValidSessionId, toAlarmView, instantEpoch, nextDriftingOccurrence, jitterDelay, type Alarm, type RunRecord, type ToolError } from "../domain.js";
import { nextCronOccurrence } from "../cron.js";
import { buildAlarm, validateCreateArgs, type CreateSpec } from "../alarm-factory.js";
import { wireTimeZones } from "../zone.js";
import type { ProactiveConfig } from "../config.js";
import type { ProactiveStore } from "../store.js";
import type { ProactiveScheduler } from "../scheduler.js";
import { applyHotConfig, hotSubset, validateSettingsPatch } from "../settings.js";
import { writeConfigFile } from "../config.js";
import type { AlarmRowView, PanelAction, PanelError, PanelResult, PanelSnapshot, PresetRosterRow, RunView } from "./contract.js";

const RUNS_WINDOW = 200;

export interface PanelServiceDeps {
  store: ProactiveStore;
  config: ProactiveConfig;
  scheduler: Pick<ProactiveScheduler, "requestDrive">;
  dataDir: string;
  now: () => number;
  log: (level: "info" | "warn" | "error", message: string) => void;
  /** Resolve a session id to a display title (empty = unknown). */
  sessionTitle: (sessionId: string) => string;
  /** Session-owned live event log (host in-memory store) for client-zone resolution. */
  sessionEvents: (sessionId: string) => readonly unknown[] | undefined;
  /** Create-side workspace argument normalization (the panel sends explicit ids); absent -> workspace creates fail closed. */
  resolveWorkspace?: (args: Record<string, unknown>, sessionCwd?: string) => Promise<Record<string, unknown> | ToolError>;
  /**
   * Agent preset roster rows (AgentPresets.remoteExportList projected): feeds
   * the preset pickers in the create form. Absent/failed -> empty roster, the
   * pickers degrade to free-text preset ids.
   */
  presetRoster?: () => Promise<readonly PresetRosterRow[]>;
}

export class ProactivePanelService {
  constructor(private readonly deps: PanelServiceDeps) {}

  /**
   * One snapshot. Without a sessionId this is the host-wide (settings page)
   * view. With a sessionId it is the conversation-page view: rows scoped to
   * alarms the session OWNS, runs scoped to this session plus every run of
   * the session's own alarms (so fork/new child wakes show up in the owner's
   * history).
   */
  async snapshot(sessionId?: string): Promise<PanelSnapshot> {
    const now = this.deps.now();
    const cfg = this.deps.config;
    if (sessionId !== undefined && !isValidSessionId(sessionId)) {
      throw new Error("invalid session id: " + JSON.stringify(sessionId));
    }
    const allRuns = await this.deps.store.listRecentRuns(RUNS_WINDOW);
    let rows: RunView[];
    let alarmRows: AlarmRowView[];
    if (sessionId === undefined) {
      rows = allRuns;
      alarmRows = this.deps.store.listAlarms().map((alarm) => this.rowFor(alarm, now));
    } else {
      const owned = new Set(this.deps.store.listAlarms().filter((alarm) => alarm.ownerSessionId === sessionId).map((alarm) => alarm.id));
      rows = allRuns.filter((run) => run.sessionId === sessionId || owned.has(run.alarmId));
      alarmRows = this.deps.store.listAlarms()
        .filter((alarm) => alarm.ownerSessionId === sessionId)
        .map((alarm) => this.rowFor(alarm, now));
    }
    return {
      server: { now: new Date(now).toISOString(), dataDir: this.deps.dataDir, corrupt: this.deps.store.corrupt },
      config: {
        enabled: cfg.enabled,
        maxDeliveriesPerDay: cfg.maxDeliveriesPerDay,
        quietHours: { start: cfg.quietHours.start, end: cfg.quietHours.end, timeZone: cfg.quietHours.timeZone },
        defaultPrompt: cfg.defaultPrompt,
        silentWakeCompaction: cfg.silentWakeCompaction
      },
      presets: await this.presetRows(),
      alarms: alarmRows,
      runs: rows
    };
  }

  /** Roster rows for the create form; failures degrade to an empty roster. */
  private async presetRows(): Promise<readonly PresetRosterRow[]> {
    if (this.deps.presetRoster === undefined) return [];
    try {
      return await this.deps.presetRoster();
    } catch (error) {
      this.deps.log("warn", "dsh-proactive: preset roster unavailable: " + (error instanceof Error ? error.message : String(error)));
      return [];
    }
  }

  private rowFor(alarm: Alarm, now: number): AlarmRowView {
    const view = toAlarmView(alarm, now);
    return {
      ...view,
      sessionTitle: this.deps.sessionTitle(alarm.ownerSessionId),
      createdAt: alarm.createdAt
    };
  }

  async action(input: unknown, sessionId?: string): Promise<PanelResult> {
    if (!isRecord(input) || typeof input["action"] !== "object" || input["action"] === null) {
      return { ok: false, error: { code: "bad_action", message: "expected an action envelope." } };
    }
    const action = input as { action: PanelAction };
    const outcome = await this.runAction(action.action, sessionId);
    if (!outcome.ok) return outcome;
    return { ok: true, snapshot: await this.snapshot(sessionId) };
  }

  /** Ownership guard: when a session scope is active every touched alarm must belong to it. */
  private guardOwnership(alarm: Alarm | undefined, sessionId: string | undefined): PanelError | undefined {
    if (sessionId === undefined) return undefined; // host-wide view manages any alarm
    if (alarm === undefined) return undefined; // not_found takes precedence
    if (alarm.ownerSessionId !== sessionId) {
      return { code: "forbidden", message: "alarm " + alarm.id + " belongs to another session." };
    }
    return undefined;
  }

  /**
   * Shared pre-validation wiring for create/edit args: the client-zone default
   * chain for time_zone, then workspace-id normalization (explicit ids only —
   * the panel form always sends one for workspace targets).
   */
  private async wireWorkspace(args: Record<string, unknown>, sessionEvents: readonly unknown[] | undefined): Promise<{ args: Record<string, unknown> } | { error: PanelError }> {
    let wired = wireTimeZones(args, sessionEvents);
    if (wired["target_mode"] === "workspace" || wired["target_source"] === "workspace" || wired["target_workspace_id"] !== undefined || wired["target_workspace_path"] !== undefined) {
      if (this.deps.resolveWorkspace === undefined) {
        return { error: { code: "not_found", message: "workspace targets are unavailable on this host (no workspace registry)." } };
      }
      const resolved = await this.deps.resolveWorkspace(wired);
      if (isToolError(resolved)) return { error: resolved };
      wired = resolved;
    }
    return { args: wired };
  }

  /**
   * Roll a failed mutation back in memory and surface the durable failure as
   * persistence_uncertain — the same contract the model tools follow, so the
   * panel never reports a save that a crash could silently drop.
   */
  private persistFailure(kind: string, rollback: () => void, error: unknown): { ok: false; error: PanelError } {
    rollback();
    this.deps.log("warn", "dsh-proactive: panel " + kind + " persist failed: " + (error instanceof Error ? error.message : String(error)));
    return { ok: false, error: { code: "persistence_uncertain", message: "The alarm change was not durably stored; please retry." } };
  }

  private async runAction(action: PanelAction, sessionId?: string): Promise<{ ok: false; error: PanelError } | { ok: true }> {
    const store = this.deps.store;
    const now = this.deps.now();
    if (action.kind === "create") {
      if (typeof action.sessionId !== "string" || action.sessionId === "") {
        return { ok: false, error: { code: "invalid_trigger", message: "sessionId is required." } };
      }
      // Scope rule: under an active session scope the alarm must belong to it;
      // the host-wide settings view chooses an explicit target session.
      if (sessionId !== undefined && action.sessionId !== sessionId) {
        return { ok: false, error: { code: "scope_mismatch", message: "create.sessionId must match the session scope." } };
      }
      if (!isRecord(action.args)) return { ok: false, error: { code: "bad_action", message: "create.args must be an object." } };
      // time_zone is optional: wire through the one default chain (a zone-bearing
      // at object is the explicit intent; otherwise client zone -> host zone).
      // Workspace ids normalize through the shared resolver (existence check).
      const wiredCreate = await this.wireWorkspace(action.args, this.deps.sessionEvents(action.sessionId));
      if ("error" in wiredCreate) return { ok: false, error: wiredCreate.error };
      const spec = validateCreateArgs(wiredCreate.args, action.sessionId);
      if ("code" in spec) return { ok: false, error: spec };
      const built = buildAlarm(action.sessionId, spec as CreateSpec, now);
      if ("code" in built) return { ok: false, error: built };
      store.addAlarm(built.alarm);
      try {
        await store.persist();
      } catch (error) {
        return this.persistFailure("create", () => store.removeAlarm(built.alarm.id), error);
      }
      this.deps.scheduler.requestDrive();
      return { ok: true };
    }
    if (action.kind === "edit") {
      const current = store.getAlarm(action.id);
      if (current === undefined) return { ok: false, error: { code: "not_found", message: "alarm " + action.id + " not found." } };
      const denied = this.guardOwnership(current, sessionId);
      if (denied !== undefined) return { ok: false, error: denied };
      if (current.status === "in-flight" || current.status === "completed" || current.status === "cancelled" || current.status === "failed") {
        return { ok: false, error: { code: "invalid_action", message: "alarm " + action.id + " cannot be edited in its current state." } };
      }
      if (!isRecord(action.args)) return { ok: false, error: { code: "bad_action", message: "edit.args must be an object." } };
      const wiredEdit = await this.wireWorkspace(action.args, this.deps.sessionEvents(current.ownerSessionId));
      if ("error" in wiredEdit) return { ok: false, error: wiredEdit.error };
      const spec = validateCreateArgs(wiredEdit.args, current.ownerSessionId);
      if ("code" in spec) return { ok: false, error: spec };
      const built = buildAlarm(current.ownerSessionId, spec as CreateSpec, now);
      if ("code" in built) return { ok: false, error: built };
      // Keep identity + run history; replace the trigger-facing fields.
      const stamped = new Date(now).toISOString();
      const updated: Alarm = {
        ...built.alarm,
        id: current.id,
        ownerSessionId: current.ownerSessionId,
        createdAt: current.createdAt,
        runCount: current.runCount,
        lastRunAt: current.lastRunAt,
        status: "scheduled",
        updatedAt: stamped
      };
      store.replaceAlarm(updated);
      try {
        await store.persist();
      } catch (error) {
        return this.persistFailure("edit", () => store.replaceAlarm(current), error);
      }
      this.deps.scheduler.requestDrive();
      return { ok: true };
    }
    if (action.kind === "cancel") {
      const current = store.getAlarm(action.id);
      if (current === undefined) return { ok: false, error: { code: "not_found", message: "alarm " + action.id + " not found." } };
      const denied = this.guardOwnership(current, sessionId);
      if (denied !== undefined) return { ok: false, error: denied };
      store.removeAlarm(action.id);
      try {
        await store.persist();
      } catch (error) {
        return this.persistFailure("cancel", () => store.addAlarm(current), error);
      }
      this.deps.scheduler.requestDrive();
      return { ok: true };
    }
    if (action.kind === "toggle") {
      const current = store.getAlarm(action.id);
      if (current === undefined) return { ok: false, error: { code: "not_found", message: "alarm " + action.id + " not found." } };
      const denied = this.guardOwnership(current, sessionId);
      if (denied !== undefined) return { ok: false, error: denied };
      if (current.status === "cancelled" || current.status === "completed" || current.status === "failed" || current.status === "in-flight") {
        return { ok: false, error: { code: "invalid_action", message: "alarm " + action.id + " cannot be paused or resumed in its current state." } };
      }
      const stamp = new Date(now).toISOString();
      let next = current.nextDueAt;
      if (current.status === "paused") {
        // Resume: re-arm. Repeats/cron move to the next occurrence after the
        // pause; once alarms keep their original due instant (an expired one
        // fires at once).
        if (current.type === "every" && "everySeconds" in current.trigger) {
          const every = current.trigger.everySeconds as number;
          const jitterSeconds = typeof current.trigger["jitterSeconds"] === "number" && current.trigger["jitterSeconds"] > 0 ? current.trigger["jitterSeconds"] : undefined;
          next = new Date(nextDriftingOccurrence(now, every, now, jitterSeconds)).toISOString();
        } else if (current.type === "cron" && "expr" in current.trigger) {
          try {
            const base = nextCronOccurrence(current.trigger["expr"], current.timeZone, now);
            const jitterSeconds = typeof current.trigger["jitterSeconds"] === "number" && current.trigger["jitterSeconds"] > 0 ? current.trigger["jitterSeconds"] : undefined;
            next = new Date(base + jitterDelay(jitterSeconds)).toISOString();
          } catch {
            // corrupt expression: leave the stored due instant untouched
          }
        }
      }
      const updated: Alarm = { ...current, status: current.status === "paused" ? "scheduled" : "paused", nextDueAt: next, updatedAt: stamp };
      store.replaceAlarm(updated);
      try {
        await store.persist();
      } catch (error) {
        return this.persistFailure("toggle", () => store.replaceAlarm(current), error);
      }
      this.deps.scheduler.requestDrive();
      return { ok: true };
    }
    if (action.kind === "fire") {
      const current = store.getAlarm(action.id);
      if (current === undefined) return { ok: false, error: { code: "not_found", message: "alarm " + action.id + " not found." } };
      const denied = this.guardOwnership(current, sessionId);
      if (denied !== undefined) return { ok: false, error: denied };
      if (current.status === "in-flight" || current.status === "completed" || current.status === "cancelled" || current.status === "failed") {
        return { ok: false, error: { code: "invalid_action", message: "alarm " + action.id + " cannot fire in its current state." } };
      }
      const updated: Alarm = { ...current, status: "scheduled", nextDueAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
      store.replaceAlarm(updated);
      try {
        await store.persist();
      } catch (error) {
        return this.persistFailure("fire", () => store.replaceAlarm(current), error);
      }
      this.deps.scheduler.requestDrive();
      return { ok: true };
    }
    if (action.kind === "update_config") {
      if (!isRecord(action.patch)) {
        return { ok: false, error: { code: "bad_action", message: "update_config.patch must be an object." } };
      }
      const shape = validateSettingsPatch(action.patch);
      if ("code" in shape) return { ok: false, error: shape };
      try {
        await writeConfigFile(this.deps.dataDir, shape.patch as unknown as Partial<ProactiveConfig>);
      } catch {
        return { ok: false, error: { code: "persistence_uncertain", message: "The configuration was not durably stored; please retry." } };
      }
      const next = { ...hotSubset(this.deps.config), ...shape.patch };
      applyHotConfig(this.deps.config, next);
      this.deps.log("info", "dsh-proactive: panel update_config applied: " + Object.keys(shape.patch).join(", "));
      return { ok: true };
    }
    return { ok: false, error: { code: "bad_action", message: "unknown action kind." } };
  }
}