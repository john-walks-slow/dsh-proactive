/**
 * Host-side panel service: snapshots, closed actions, and run history for the
 * GUI panel. Mutations go through the same alarm factory as the model tools
 * and end with the same store + scheduler wiring, so the panel is a second
 * surface over one domain, never a parallel implementation.
 */

import { isRecord, isValidSessionId, toAlarmView, instantEpoch, nextEveryOccurrence, nextJitteredOccurrence, type Alarm, type RunRecord } from "../domain.js";
import { buildAlarm, validateCreateArgs, type CreateSpec } from "../alarm-factory.js";
import type { ProactiveConfig } from "../config.js";
import type { ProactiveStore } from "../store.js";
import type { ProactiveScheduler } from "../scheduler.js";
import { applyHotConfig, hotSubset, validateSettingsPatch } from "../settings.js";
import { writeConfigFile } from "../config.js";
import type { AlarmRowView, PanelAction, PanelError, PanelResult, PanelSnapshot, RunView } from "./contract.js";

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
}

export class ProactivePanelService {
  constructor(private readonly deps: PanelServiceDeps) {}

  /**
   * One snapshot. Without a sessionId this is the host-wide (settings page)
   * view. With a sessionId it is the conversation-page view: alarms and runs
   * filtered to that session.
   */
  async snapshot(sessionId?: string): Promise<PanelSnapshot> {
    const now = this.deps.now();
    const cfg = this.deps.config;
    if (sessionId !== undefined && !isValidSessionId(sessionId)) {
      throw new Error("invalid session id: " + JSON.stringify(sessionId));
    }
    const allRuns = await this.deps.store.listRecentRuns(RUNS_WINDOW);
    const rows: RunView[] = sessionId === undefined
      ? allRuns
      : allRuns.filter((run) => run.sessionId === sessionId);
    const alarms: AlarmRowView[] = this.deps.store.listAlarms()
      .filter((alarm) => sessionId === undefined || alarm.sessionId === sessionId)
      .map((alarm) => {
        const view = toAlarmView(alarm, now);
        return {
          ...view,
          sessionTitle: this.deps.sessionTitle(alarm.sessionId),
          createdAt: alarm.createdAt,
          ...(alarm.mode === "repeat" && "everySeconds" in alarm.trigger ? { everySeconds: alarm.trigger.everySeconds as number } : {}),
          ...(alarm.mode === "one-shot" && "at" in alarm.trigger ? { at: alarm.trigger.at as string } : {})
        };
      });
    return {
      server: { now: new Date(now).toISOString(), dataDir: this.deps.dataDir, corrupt: this.deps.store.corrupt },
      config: {
        enabled: cfg.enabled,
        maxDeliveriesPerDay: cfg.maxDeliveriesPerDay,
        quietHours: { start: cfg.quietHours.start, end: cfg.quietHours.end, timeZone: cfg.quietHours.timeZone },
        heartbeatPrompt: cfg.heartbeatPrompt
      },
      alarms,
      runs: rows
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
    if (alarm.sessionId !== sessionId) {
      return { code: "forbidden", message: "alarm " + alarm.id + " belongs to another session." };
    }
    return undefined;
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
      const spec = validateCreateArgs(action.args);
      if ("code" in spec) return { ok: false, error: spec };
      const built = buildAlarm(action.sessionId, spec as CreateSpec, now);
      if ("code" in built) return { ok: false, error: built };
      store.addAlarm(built.alarm);
      void store.persist().catch(() => undefined);
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
      const spec = validateCreateArgs(action.args);
      if ("code" in spec) return { ok: false, error: spec };
      const built = buildAlarm(current.sessionId, spec as CreateSpec, now);
      if ("code" in built) return { ok: false, error: built };
      // Keep identity + run history; replace the trigger-facing fields.
      const stamped = new Date(now).toISOString();
      const updated: Alarm = {
        ...built.alarm,
        id: current.id,
        sessionId: current.sessionId,
        createdAt: current.createdAt,
        runCount: current.runCount,
        lastRunAt: current.lastRunAt,
        status: "scheduled",
        updatedAt: stamped
      };
      store.replaceAlarm(updated);
      void store.persist().catch(() => undefined);
      this.deps.scheduler.requestDrive();
      return { ok: true };
    }
    if (action.kind === "cancel") {
      const current = store.getAlarm(action.id);
      if (current === undefined) return { ok: false, error: { code: "not_found", message: "alarm " + action.id + " not found." } };
      const denied = this.guardOwnership(current, sessionId);
      if (denied !== undefined) return { ok: false, error: denied };
      store.removeAlarm(action.id);
      void store.persist().catch(() => undefined);
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
        // Resume: re-arm. Repeats move to the next anchor after the pause;
        // one-shots keep their original due instant (an expired one fires at once).
        if (current.mode === "repeat" && "everySeconds" in current.trigger) {
          const anchor = current.lastRunAt ?? current.createdAt;
          const every = current.trigger.everySeconds as number;
          const jitter = current.trigger["jitter"];
          next = new Date(typeof jitter === "number" && Number.isFinite(jitter) && jitter > 0
            ? nextJitteredOccurrence(instantEpoch(anchor), every, now, jitter)
            : nextEveryOccurrence(instantEpoch(anchor), every, now)).toISOString();
        }
      }
      const updated: Alarm = { ...current, status: current.status === "paused" ? "scheduled" : "paused", nextDueAt: next, updatedAt: stamp };
      store.replaceAlarm(updated);
      void store.persist().catch(() => undefined);
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
      void store.persist().catch(() => undefined);
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