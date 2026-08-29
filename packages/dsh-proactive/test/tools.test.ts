import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { proactiveToolDefinitions, type ToolServices } from "../src/tools.js";
import type { ProactiveStore } from "../src/store.js";
import type { ProactiveScheduler } from "../src/scheduler.js";
import type { WakeDriver } from "../src/wake.js";
import type { Alarm, RunRecord } from "../src/domain.js";

const NOW = Date.parse("2026-09-01T09:00:00.000Z");

/** Minimal in-memory store with a persist-failure switch. */
class FakeStore {
  corrupt = false;
  alarms: Alarm[] = [];
  failPersist = false;
  listAlarms(): readonly Alarm[] { return this.alarms; }
  getAlarm(id: string): Alarm | undefined { return this.alarms.find((a) => a.id === id); }
  addAlarm(alarm: Alarm): void { this.alarms.push(alarm); }
  replaceAlarm(updated: Alarm): void {
    const i = this.alarms.findIndex((a) => a.id === updated.id);
    if (i >= 0) this.alarms[i] = updated;
  }
  removeAlarm(id: string): Alarm | undefined {
    const i = this.alarms.findIndex((a) => a.id === id);
    if (i < 0) return undefined;
    return this.alarms.splice(i, 1)[0];
  }
  async persist(): Promise<void> { if (this.failPersist) throw new Error("disk full"); }
  async appendRun(_record: RunRecord): Promise<void> { /* no-op */ }
  budgetFor(): number { return 0; }
  async spendBudget(): Promise<number> { return 0; }
}

function harness() {
  const store = new FakeStore();
  const activeWakes = new Set<string>();
  let requestDrives = 0;
  let concluded = false;
  const services = {
    store: store as unknown as ProactiveStore,
    config: { maxDeliveriesPerDay: 3 } as unknown as ToolServices["config"],
    driver: { isActiveWake: (id: string) => activeWakes.has(id) } as unknown as WakeDriver,
    scheduler: { requestDrive: () => { requestDrives += 1; } } as unknown as ProactiveScheduler,
    now: () => NOW
  } satisfies ToolServices;
  const agent = { session: { id: "s1" } } as unknown as Agent;
  const defs = proactiveToolDefinitions(agent, services);
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  const exec = { agent, concludeTurn: () => { concluded = true; } } as unknown as ToolRunContext;
  const run = (tool: string, args: Record<string, unknown>) => byName[tool].execute(args, exec) as Promise<unknown>;
  return { store, activeWakes, agent, byName, run, concluded: () => concluded, get requestDrives() { return requestDrives; } };
}

const code = (v: unknown): string | undefined => (v as { code?: string })["code"];
const asView = (v: unknown) => v as { id?: string; mode?: string; state?: string; wakeReason?: string };

test("proactive_set validates selectors", async () => {
  const h = harness();
  assert.equal(code(await h.run("proactive_set", { prompt: "x" })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", at: "2026-09-02T00:00:00Z", after_seconds: 5 })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_set", { prompt: "   ", after_seconds: 5 })), "invalid_prompt");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", after_seconds: 0 })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", after_seconds: 10 * 365 * 86400 + 1 })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", every_seconds: 299 })), "frequency_too_high");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", every_seconds: 10 * 365 * 86400 + 1 })), "invalid_trigger");
});

test("proactive_set creates one-shot and repeat alarms end to end", async () => {
  const h = harness();
  const one = asView(await h.run("proactive_set", { prompt: "提醒喝水", after_seconds: 3600 }));
  assert.equal(one.id, h.store.alarms[0]?.id);
  assert.equal(one.mode, "one-shot");
  assert.equal(one.state, "scheduled");
  assert.equal(h.store.alarms.length, 1);
  assert.equal(h.requestDrives, 1);
  const rep = asView(await h.run("proactive_set", { prompt: "检查 TODO", every_seconds: 300, wake_reason: "check_in" }));
  assert.equal(rep.mode, "repeat");
  assert.equal(rep.wakeReason, "check_in");
  const at = asView(await h.run("proactive_set", { prompt: "两点叫我", at: { date: "2026-09-02", time: "14:00:00", time_zone: "Asia/Shanghai" } }));
  assert.equal(at.mode, "one-shot");
  assert.equal(h.store.alarms.length, 3);
});

test("proactive_set rolls back when persistence fails", async () => {
  const h = harness();
  h.store.failPersist = true;
  assert.equal(code(await h.run("proactive_set", { prompt: "x", after_seconds: 5 })), "persistence_uncertain");
  assert.equal(h.store.alarms.length, 0);
});

test("proactive_set rejects bad at values via closed error codes", async () => {
  const h = harness();
  assert.equal(code(await h.run("proactive_set", { prompt: "x", at: "2026-09-01T09:00:00" })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", at: { date: "2026-09-02", time: "14:00:00", time_zone: "Not/AZone" } })), "invalid_time_zone");
});

test("proactive_list filters to this session's active alarms", async () => {
  const h = harness();
  h.store.alarms = [
    { id: "a", sessionId: "s1", status: "scheduled" } as Alarm,
    { id: "b", sessionId: "s1", status: "in-flight" } as Alarm,
    { id: "c", sessionId: "s1", status: "completed" } as Alarm,
    { id: "d", sessionId: "s2", status: "scheduled" } as Alarm
  ];
  const res = await h.run("proactive_list", {}) as { id?: string }[];
  assert.equal(res.length, 2);
});

test("proactive_cancel cancels and maps unknown ids to not_found", async () => {
  const h = harness();
  const created = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5 }));
  const id = created.id as string;
  const ok = await h.run("proactive_cancel", { id });
  assert.deepEqual(ok, { id, cancelled: true });
  assert.equal(h.store.alarms.length, 0);
  assert.deepEqual(code(await h.run("proactive_cancel", { id: "nope" })), "not_found");
  // other-session ids are not_found too, never { cancelled: false }
  h.store.addAlarm({ id: "foreign", sessionId: "s2", status: "scheduled" } as Alarm);
  assert.equal(code(await h.run("proactive_cancel", { id: "foreign" })), "not_found");
});

test("proactive_cancel restores the alarm when persistence fails", async () => {
  const h = harness();
  const created = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5 }));
  const id = created.id as string;
  h.store.failPersist = true;
  assert.equal(code(await h.run("proactive_cancel", { id })), "persistence_uncertain");
  assert.equal(h.store.alarms.length, 1);
});

test("proactive_no_reply requires an active wake and concludes the turn", async () => {
  const h = harness();
  assert.equal(code(await h.run("proactive_no_reply", {})), "no_active_wake");
  assert.equal(h.concluded(), false);
  h.activeWakes.add("s1");
  const res = await h.run("proactive_no_reply", { reason: "all handled" });
  assert.deepEqual(res, { accepted: true, silent: true });
  assert.equal(h.concluded(), true);
  assert.equal(code(await h.run("proactive_no_reply", { reason: "r".repeat(201) })), "invalid_trigger");
});

test("tools reject exec bound to another agent", async () => {
  const h = harness();
  const foreign = { agent: { session: { id: "s9" } }, concludeTurn: () => undefined } as unknown as ToolRunContext;
  const res = await h.byName["proactive_set"].execute({ prompt: "x", after_seconds: 5 }, foreign) as { code?: string };
  assert.equal(res.code, "internal_error");
});
