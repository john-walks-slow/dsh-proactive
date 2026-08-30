/**
 * Host-side panel service: snapshots, closed actions, and run history for the
 * GUI panel. Mutations go through the same alarm factory as the model tools
 * and end with the same store + scheduler wiring, so the panel is a second
 * surface over one domain, never a parallel implementation.
 */

import { isRecord, toAlarmView, instantEpoch, nextEveryOccurrence, nextJitteredOccurrence, type Alarm, type RunRecord } from "../domain.js";
import { buildAlarm, validateCreateArgs, type CreateSpec } from "../alarm-factory.js";
import type { ProactiveConfig } from "../config.js";
import type { ProactiveStore } from "../store.js";
import type { ProactiveScheduler } from "../scheduler.js";
import type { PanelAction, PanelError, PanelResult, PanelSnapshot, RunView } from "./contract.js";

const RUNS_WINDOW = 200;

export interface PanelServiceDeps {
  store: ProactiveStore;
  config: ProactiveConfig;
  scheduler: Pick<ProactiveScheduler, "requestDrive">;
  dataDir: string;
  now: () => number;
  log: (level: "info" | "warn" | "error", message: string) => void;
}

export class ProactivePanelService {
  constructor(private readonly deps: PanelServiceDeps) {}

  async snapshot(): Promise<PanelSnapshot> {
    const now = this.deps.now();
    const cfg = this.deps.config;
    const runs = await this.deps.store.listRecentRuns(RUNS_WINDOW);
    return {
      server: { now: new Date(now).toISOString(), dataDir: this.deps.dataDir, corrupt: this.deps.store.corrupt },
      config: {
        enabled: cfg.enabled,
        maxDeliveriesPerDay: cfg.maxDeliveriesPerDay,
        quietHours: { start: cfg.quietHours.start, end: cfg.quietHours.end, timeZone: cfg.quietHours.timeZone },
        heartbeatPrompt: cfg.heartbeatPrompt,
        heartbeatEverySeconds: cfg.heartbeatEverySeconds,
        heartbeatJitter: cfg.heartbeatJitter
      },
      alarms: this.deps.store.listAlarms().map((alarm) => toAlarmView(alarm, now)),
      runs
    };
  }

  async action(input: unknown): Promise<PanelResult> {
    if (!isRecord(input) || typeof input["action"] !== "object" || input["action"] === null) {
      return { ok: false, error: { code: "bad_action", message: "expected an action envelope." } };
    }
    const action = input as { action: PanelAction };
    const outcome = await this.runAction(action.action);
    if (!outcome.ok) return outcome;
    return { ok: true, snapshot: await this.snapshot() };
  }

  private async runAction(action: PanelAction): Promise<{ ok: false; error: PanelError } | { ok: true }> {
    const store = this.deps.store;
    const now = this.deps.now();
    if (action.kind === "create") {
      if (typeof action.sessionId !== "string" || action.sessionId === "") {
        return { ok: false, error: { code: "invalid_trigger", message: "sessionId is required." } };
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
    if (action.kind === "cancel") {
      const removed = store.removeAlarm(action.id);
      if (removed === undefined) return { ok: false, error: { code: "not_found", message: "alarm " + action.id + " not found." } };
      void store.persist().catch(() => undefined);
      this.deps.scheduler.requestDrive();
      return { ok: true };
    }
    if (action.kind === "toggle") {
      const current = store.getAlarm(action.id);
      if (current === undefined) return { ok: false, error: { code: "not_found", message: "alarm " + action.id + " not found." } };
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
      if (current.status === "in-flight" || current.status === "completed" || current.status === "cancelled" || current.status === "failed") {
        return { ok: false, error: { code: "invalid_action", message: "alarm " + action.id + " cannot fire in its current state." } };
      }
      const updated: Alarm = { ...current, status: "scheduled", nextDueAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
      store.replaceAlarm(updated);
      void store.persist().catch(() => undefined);
      this.deps.scheduler.requestDrive();
      return { ok: true };
    }
    return { ok: false, error: { code: "bad_action", message: "unknown action kind." } };
  }
}