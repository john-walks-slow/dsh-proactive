import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { proactiveToolDefinitions, type ToolServices } from "../src/tools.js";
import { validateCreateArgs } from "../src/alarm-factory.js";
import { resolveConfig } from "../src/config.js";
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
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-tools-"));
  const config = resolveConfig(dir);
  const services = {
    store: store as unknown as ProactiveStore,
    config,
    driver: { isActiveWake: (id: string) => activeWakes.has(id) } as unknown as WakeDriver,
    scheduler: { requestDrive: () => { requestDrives += 1; } } as unknown as ProactiveScheduler,
    now: () => NOW
  } satisfies ToolServices;
  const agent = { session: { id: "s1" } } as unknown as Agent;
  const defs = proactiveToolDefinitions(agent, services);
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  const exec = { agent, concludeTurn: () => { concluded = true; } } as unknown as ToolRunContext;
  const run = (tool: string, args: Record<string, unknown>) => byName[tool].execute(args, exec) as Promise<unknown>;
  const cleanup = () => { rmSync(dir, { recursive: true, force: true }); };
  return { store, activeWakes, agent, byName, run, dir, config, services, cleanup, concluded: () => concluded, get requestDrives() { return requestDrives; } };
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
  // push-delivery coupling was removed: the delivery key is no longer accepted.
  assert.equal(code(await h.run("proactive_set", { prompt: "x", after_seconds: 5, delivery: { chat: true, push: true } })), "invalid_trigger");
});

test("proactive_set validates jitter bounds and only with every_seconds", async () => {
  const h = harness();
  assert.equal(code(await h.run("proactive_set", { prompt: "x", every_seconds: 300, jitter: -0.1 })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", every_seconds: 300, jitter: 1.1 })), "invalid_trigger");
  // Schema gate blocks non-number jitter before the closed domain validation.
  await assert.rejects(h.run("proactive_set", { prompt: "x", every_seconds: 300, jitter: "0.1" }),
    (err: unknown) => (err as { code?: string })["code"] === "INVALID_ARGS");
  const ok = asView(await h.run("proactive_set", { prompt: "x", every_seconds: 300, jitter: 0.15 }));
  assert.equal(ok.mode, "repeat");
  assert.equal((h.store.alarms[0]?.trigger as { jitter?: number }).jitter, 0.15);
  // jitter without every_seconds is rejected (unknown-key surface) at validation level:
  const res = validateCreateArgs({ prompt: "x", after_seconds: 60, jitter: 0.1 }) as { code?: string };
  assert.equal(res.code, "invalid_trigger");
  // Non-finite jitter is rejected at the domain gate (number type passes). NaN serializes
  // to null through the runner, so exercise validateCreateArgs directly for the NaN case.
  const nan = validateCreateArgs({ prompt: "x", every_seconds: 300, jitter: Number.NaN }) as { code?: string };
  assert.equal(nan.code, "invalid_trigger");
});

test("proactive_set rejects the merged wake_reason values", async () => {
  const h = harness();
  // The tool schema enum is the first gate: invalid values throw INVALID_ARGS
  // before the closed domain validation (which the panel path still uses).
  for (const legacy of ["check_in", "interval", "companion"]) {
    await assert.rejects(h.run("proactive_set", { prompt: "x", after_seconds: 3600, wake_reason: legacy }),
      (err: unknown) => (err as { code?: string })["code"] === "INVALID_ARGS");
  }
  const ok = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 3600, wake_reason: "alarm" }));
  assert.equal(ok.state, "scheduled");
  assert.equal(ok.wakeReason, "alarm");
});

test("validateCreateArgs rejects legacy wake reasons with a closed code (P2)", () => {
  for (const legacy of ["check_in", "interval", "companion"]) {
    const res = validateCreateArgs({ prompt: "x", after_seconds: 3600, wake_reason: legacy }) as { code?: string };
    assert.equal(res.code, "invalid_trigger", "legacy: " + legacy);
  }
  const ok = validateCreateArgs({ prompt: "x", after_seconds: 3600, wake_reason: "heartbeat" });
  assert.ok(!("code" in ok));
});

test("P1 regression: alarm view output schema admits legacy wake reasons", () => {
  const h = harness();
  const listDef = h.byName["proactive_list"];
  // The array branch of the output oneOf carries the alarm view items schema.
  const viewSchema = (listDef.output!.schema as { oneOf: Array<{ type: string; items: unknown }> }).oneOf[0].items as Parameters<typeof validateJsonSchemaValue>[0];
  const base = { id: "a", mode: "repeat", prompt: "p", nextDueAt: "2026-09-02T00:00:00.000Z", state: "scheduled", deliveryMode: "host" };
  for (const wakeReason of ["heartbeat", "alarm", "check_in", "interval", "companion"]) {
    const violations = validateJsonSchemaValue(viewSchema, { ...base, wakeReason }, "value");
    assert.deepEqual(violations, [], "wakeReason " + wakeReason + " must validate");
  }
});

test("P0 regression: jittered alarm view passes the runtime output schema gate", () => {
  const h = harness();
  const listDef = h.byName["proactive_list"];
  const viewSchema = (listDef.output!.schema as { oneOf: Array<{ type: string; items: unknown }> }).oneOf[0].items as Parameters<typeof validateJsonSchemaValue>[0];
  const base = { id: "a", mode: "repeat", prompt: "p", nextDueAt: "2026-09-02T00:00:00.000Z", state: "scheduled", deliveryMode: "host", wakeReason: "heartbeat" };
  // A jittered view must validate (schema declares jitter, optional).
  const jittered = validateJsonSchemaValue(viewSchema, { ...base, jitter: 0.15 }, "value");
  assert.deepEqual(jittered, [], "jittered view must validate against the output schema");
  // A non-jittered view must still validate (jitter optional, not required).
  const plain = validateJsonSchemaValue(viewSchema, { ...base }, "value");
  assert.deepEqual(plain, [], "non-jittered view must validate against the output schema");
});

test("proactive_set creates one-shot and repeat alarms end to end", async () => {
  const h = harness();
  const one = asView(await h.run("proactive_set", { prompt: "提醒喝水", after_seconds: 3600 }));
  assert.equal(one.id, h.store.alarms[0]?.id);
  assert.equal(one.mode, "one-shot");
  assert.equal(one.state, "scheduled");
  assert.equal(h.store.alarms.length, 1);
  assert.equal(h.requestDrives, 1);
  const rep = asView(await h.run("proactive_set", { prompt: "检查 TODO", every_seconds: 300, wake_reason: "heartbeat" }));
  assert.equal(rep.mode, "repeat");
  assert.equal(rep.wakeReason, "heartbeat");
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

test("proactive_set: prompt is optional for heartbeat, still required for alarm", async () => {
  const h = harness();
  // Heartbeat without prompt: accepted, empty prompt stored.
  const hb = asView(await h.run("proactive_set", { after_seconds: 3600, wake_reason: "heartbeat" }));
  assert.equal(hb.state, "scheduled");
  assert.equal(hb.wakeReason, "heartbeat");
  assert.equal(h.store.alarms[0]?.prompt, "");
  assert.equal(h.store.alarms[0]?.wakeReason, "heartbeat");
  // Heartbeat with an explicit empty prompt: also accepted.
  const hb2 = asView(await h.run("proactive_set", { prompt: "   ", after_seconds: 7200, wake_reason: "heartbeat" }));
  assert.equal(hb2.state, "scheduled");
  assert.equal(h.store.alarms.length, 2);
  // Alarm (default wake reason) without prompt: still rejected.
  assert.equal(code(await h.run("proactive_set", { after_seconds: 5 })), "invalid_prompt");
  assert.equal(h.store.alarms.length, 2);
});

test("proactive_update_settings: partial update changes only the given field", async () => {
  const h = harness();
  const before = h.config.maxDeliveriesPerDay;
  const snapshot = structuredClone({
    enabled: h.config.enabled,
    maxDeliveriesPerDay: h.config.maxDeliveriesPerDay,
    quietHours: h.config.quietHours,
    heartbeatPrompt: h.config.heartbeatPrompt
  });
  const out = await h.run("proactive_update_settings", { max_deliveries_per_day: before + 2 }) as Record<string, unknown>;
  assert.equal(out.max_deliveries_per_day, before + 2);
  // Only the requested field changed in the live config; every other field is
  // bit-identical to the pre-update snapshot (not trivially self-referential).
  assert.equal(h.config.maxDeliveriesPerDay, before + 2);
  assert.deepEqual(h.config.enabled, snapshot.enabled);
  assert.deepEqual(h.config.quietHours, snapshot.quietHours);
  assert.deepEqual(h.config.heartbeatPrompt, snapshot.heartbeatPrompt);
  // Persisted to config.json (merged over the file, other keys intact).
  const file = JSON.parse(readFileSync(join(h.dir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.equal(file["maxDeliveriesPerDay"], before + 2);
  assert.ok(!("enabled" in file), "unrelated keys must not be persisted");
});

test("proactive_update_settings: rejects unknown keys and out-of-range values", async () => {
  const h = harness();
  assert.equal(code(await h.run("proactive_update_settings", {})), "invalid_trigger");
  assert.equal(code(await h.run("proactive_update_settings", { nope: 1 })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_update_settings", { heartbeat_prompt: "   " })), "invalid_prompt");
  assert.equal(code(await h.run("proactive_update_settings", { quiet_hours: { start: "25:00", end: "07:00", time_zone: "UTC" } })), "invalid_trigger");
  // Nothing was applied or persisted.
  assert.equal(h.config.heartbeatPrompt, h.services.config.heartbeatPrompt);
  let exists = true;
  try { readFileSync(join(h.dir, "config.json"), "utf8"); } catch { exists = false; }
  assert.equal(exists, false);
});

test("tools reject exec bound to another agent", async () => {
  const h = harness();
  const foreign = { agent: { session: { id: "s9" } }, concludeTurn: () => undefined } as unknown as ToolRunContext;
  const res = await h.byName["proactive_set"].execute({ prompt: "x", after_seconds: 5 }, foreign) as { code?: string };
  assert.equal(res.code, "internal_error");
});
