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
import { SYSTEM_DEFAULT_TIME_ZONE } from "../src/zone.js";
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
  // Agent carries a live sessions facade: its own session has one user rpc
  // message carrying the browser zone, so omitted time_zone resolves there.
  const sessionsFacade = { get: (id: string) => (id === "s1" ? { events: [{ type: "user/message", source: { kind: "user", rpcId: "r1", clientTimeZone: "Asia/Tokyo" } }] } : undefined) };
  const agent = {
    session: { id: "s1" },
    // Cordis-shaped ctx: services resolve through get(name, false), so the
    // mock exposes the sessions facade the same way the runtime does.
    ctx: { get: (name: string) => (name === "sessions" ? sessionsFacade : undefined) }
  } as unknown as Agent;
  const defs = proactiveToolDefinitions(agent, services);
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  const exec = { agent, concludeTurn: () => { concluded = true; } } as unknown as ToolRunContext;
  const run = (tool: string, args: Record<string, unknown>) => byName[tool].execute(args, exec) as Promise<unknown>;
  const cleanup = () => { rmSync(dir, { recursive: true, force: true }); };
  return { store, activeWakes, agent, byName, run, dir, config, services, cleanup, concluded: () => concluded, get requestDrives() { return requestDrives; } };
}

const code = (v: unknown): string | undefined => (v as { code?: string })["code"];
const asView = (v: unknown) => v as { id?: string; type?: string; targetMode?: string; targetSessionId?: string; respectQuietHours?: boolean; state?: string; everySeconds?: number; cron?: string; at?: string; nextDueAt?: string; jitterSeconds?: number };

function v2Fixture(id: string, owner: string, status: Alarm["status"] = "scheduled"): Alarm {
  return {
    id,
    ownerSessionId: owner,
    target: { mode: "resume", sessionId: owner },
    type: "once",
    trigger: { at: "2026-09-02T00:00:00.000Z" },
    prompt: "p",
    respectQuietHours: false,
    timeZone: "UTC",
    status,
    nextDueAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    runCount: 0,
    lastRunAt: null
  };
}

test("proactive_set validates selectors", async () => {
  const h = harness();
  assert.equal(code(await h.run("proactive_set", { prompt: "x" })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", at: "2026-09-02T00:00:00Z", after_seconds: 5 })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_set", { prompt: "   ", after_seconds: 5 })), "invalid_prompt");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", after_seconds: 0 })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", after_seconds: 10 * 365 * 86400 + 1 })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", every_seconds: 299 })), "frequency_too_high");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", every_seconds: 10 * 365 * 86400 + 1 })), "invalid_trigger");
  // The legacy wake_reason and delivery dials are gone: both keys are rejected.
  assert.equal(code(await h.run("proactive_set", { prompt: "x", after_seconds: 5, wake_reason: "alarm" })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", after_seconds: 5, delivery: { chat: true } })), "invalid_trigger");
});

test("proactive_set validates jitter_seconds bounds and combinations", async () => {
  const h = harness();
  assert.equal(code(await h.run("proactive_set", { prompt: "x", every_seconds: 300, jitter_seconds: -1 })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", every_seconds: 300, jitter_seconds: 86401 })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", every_seconds: 300, jitter_seconds: 301 })), "invalid_trigger"); // must not exceed every_seconds
  // Schema gate blocks non-number jitter before the closed domain validation.
  await assert.rejects(h.run("proactive_set", { prompt: "x", every_seconds: 300, jitter_seconds: "0.1" }),
    (err: unknown) => (err as { code?: string })["code"] === "INVALID_ARGS");
  // Non-finite jitter is rejected at the domain gate (number type passes).
  const nan = validateCreateArgs({ prompt: "x", every_seconds: 300, jitter_seconds: Number.NaN }, "s1") as { code?: string };
  assert.equal(nan.code, "invalid_trigger");
  // All three types accept jitter (one delay drawn at build time).
  const every = asView(await h.run("proactive_set", { prompt: "x", every_seconds: 300, jitter_seconds: 120 }));
  assert.equal(every.type, "every");
  assert.equal(every.jitterSeconds, 120);
  const cron = asView(await h.run("proactive_set", { prompt: "x", cron: "0 9 * * 1-5", jitter_seconds: 120 }));
  assert.equal(cron.type, "cron");
  assert.equal(cron.jitterSeconds, 120);
  const once = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 3600, jitter_seconds: 120 }));
  assert.equal(once.type, "once");
  // Jitter is baked into nextDueAt, not echoed back as a once trigger field.
  assert.ok(once.nextDueAt !== undefined && Date.parse(once.nextDueAt) >= NOW + 3600_000 && Date.parse(once.nextDueAt) <= NOW + 3600_000 + 120_000);
  assert.equal(once.jitterSeconds, undefined);
});

test("proactive_set maps target_mode and target_session_id", async () => {
  const h = harness();
  // default: resume on the creator
  const resumed = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5 }));
  assert.equal(resumed.targetMode, "resume");
  assert.equal(resumed.targetSessionId, "s1");
  // explicit fork target
  const fork = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5, target_mode: "fork", target_session_id: "sParent" }));
  assert.equal(fork.targetMode, "fork");
  assert.equal(fork.targetSessionId, "sParent");
  // new: no target session id
  const fresh = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5, target_mode: "new" }));
  assert.equal(fresh.targetMode, "new");
  assert.equal(fresh.targetSessionId, undefined);
  // new + target_session_id is rejected
  assert.equal(code(await h.run("proactive_set", { prompt: "x", after_seconds: 5, target_mode: "new", target_session_id: "s9" })), "invalid_trigger");
  // bad enum is gated by the tool schema before the closed domain validation
  await assert.rejects(h.run("proactive_set", { prompt: "x", after_seconds: 5, target_mode: "sidecar" }),
    (err: unknown) => (err as { code?: string })["code"] === "INVALID_ARGS");
});

test("proactive_set respect_quiet_hours defaults to false and persists", async () => {
  const h = harness();
  const def = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5 }));
  assert.equal(def.respectQuietHours, false);
  const on = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5, respect_quiet_hours: true }));
  assert.equal(on.respectQuietHours, true);
  // non-boolean is gated by the tool schema, not the domain validator
  await assert.rejects(h.run("proactive_set", { prompt: "x", after_seconds: 5, respect_quiet_hours: "yes" }),
    (err: unknown) => (err as { code?: string })["code"] === "INVALID_ARGS");
});

test("proactive_set creates once/every/cron alarms end to end", async () => {
  const h = harness();
  const one = asView(await h.run("proactive_set", { prompt: "提醒喝水", after_seconds: 3600 }));
  assert.equal(one.id, h.store.alarms[0]?.id);
  assert.equal(one.type, "once");
  assert.equal(one.state, "scheduled");
  assert.equal(h.store.alarms.length, 1);
  assert.equal(h.requestDrives, 1);
  const rep = asView(await h.run("proactive_set", { prompt: "检查 TODO", every_seconds: 300 }));
  assert.equal(rep.type, "every");
  assert.equal(rep.everySeconds, 300);
  const cron = asView(await h.run("proactive_set", { prompt: "工作日早晨", cron: "0 9 * * 1-5", time_zone: "Asia/Shanghai" }));
  assert.equal(cron.type, "cron");
  assert.equal(cron.cron, "0 9 * * 1-5");
  const at = asView(await h.run("proactive_set", { prompt: "两点叫我", at: { date: "2026-09-02", time: "14:00:00", time_zone: "Asia/Shanghai" } }));
  assert.equal(at.type, "once");
  // A local at object's zone is reflected on the stored alarm (review P3 fix).
  assert.equal(h.store.alarms.at(-1)?.timeZone, "Asia/Shanghai");
  assert.equal(h.store.alarms.length, 4);
});

test("proactive_set rejects under-300s and malformed cron expressions", async () => {
  const h = harness();
  // two occurrences within 300s -> frequency_too_high
  assert.equal(code(await h.run("proactive_set", { prompt: "x", cron: "* * * * *" })), "frequency_too_high");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", cron: "*/4 * * * *" })), "frequency_too_high");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", cron: "61 * * * *" })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", cron: "0 9 * *" })), "invalid_trigger"); // four fields
  assert.equal(code(await h.run("proactive_set", { prompt: "x", cron: "0 9 * * ?" })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", cron: "0 9 * * 1-5", time_zone: "Not/AZone" })), "invalid_time_zone");
  // P3 review fix: the zone is validated for EVERY selector, not only cron.
  assert.equal(code(await h.run("proactive_set", { prompt: "x", after_seconds: 5, time_zone: "Not/AZone" })), "invalid_time_zone");
  assert.equal(code(await h.run("proactive_set", { prompt: "x", every_seconds: 300, time_zone: "Not/AZone" })), "invalid_time_zone");
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
    v2Fixture("a", "s1"), { ...v2Fixture("b", "s1"), status: "in-flight" },
    { ...v2Fixture("c", "s1"), status: "completed" },
    v2Fixture("d", "s2")
  ];
  const res = await h.run("proactive_list", {}) as { id?: string }[];
  assert.equal(res.length, 2);
});

test("proactive_cancel cancels and maps unknown/foreign ids to not_found", async () => {
  const h = harness();
  const created = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5 }));
  const id = created.id as string;
  const ok = await h.run("proactive_cancel", { id });
  assert.deepEqual(ok, { id, cancelled: true });
  assert.equal(h.store.alarms.length, 0);
  assert.deepEqual(code(await h.run("proactive_cancel", { id: "nope" })), "not_found");
  // other-session ids are not_found too, never { cancelled: false }
  h.store.addAlarm(v2Fixture("foreign", "s2"));
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

test("no_reply concludes the turn silently from any context", async () => {
  const h = harness();
  // Available outside a wake too: concludes without requiring isActiveWake.
  assert.equal(h.concluded(), false);
  const res = await h.run("no_reply", { reason: "nothing to add" });
  assert.deepEqual(res, { accepted: true, silent: true });
  assert.equal(h.concluded(), true);
  assert.equal(code(await h.run("no_reply", { reason: "r".repeat(201) })), "invalid_trigger");
});

test("proactive_set: prompt is required on every alarm; wake dials are gone", async () => {
  const h = harness();
  // Missing prompt is rejected by the tool schema (required) before the
  // domain validator even runs.
  await assert.rejects(h.run("proactive_set", { after_seconds: 3600 }),
    (err: unknown) => (err as { code?: string })["code"] === "INVALID_ARGS");
  // Whitespace-only prompts pass the schema but fail the closed domain check.
  assert.equal(code(await h.run("proactive_set", { prompt: "   ", after_seconds: 3600 })), "invalid_prompt");
  assert.equal(h.store.alarms.length, 0);
});

test("proactive_set: omitted time_zone resolves the session browser zone", async () => {
  const h = harness();
  await h.run("proactive_set", { prompt: "x", after_seconds: 3600 });
  assert.equal(h.store.alarms[0].timeZone, "Asia/Tokyo", "client zone from the session's newest user message");
  // explicit zone still wins
  await h.run("proactive_set", { prompt: "x", after_seconds: 3600, time_zone: "UTC" });
  assert.equal(h.store.alarms[1].timeZone, "UTC");
});

test("proactive_set: no user messages falls back to the host zone", async () => {
  const h = harness();
  const bare = { session: { id: "s2" }, ctx: { get: () => undefined } } as unknown as Agent; // no sessions service at all
  const bareSet = proactiveToolDefinitions(bare, h.services).find((d) => d.name === "proactive_set");
  assert.ok(bareSet !== undefined);
  await bareSet.execute({ prompt: "x", after_seconds: 60 }, { agent: bare, concludeTurn: () => undefined } as unknown as ToolRunContext);
  assert.equal(h.store.alarms[0].timeZone, SYSTEM_DEFAULT_TIME_ZONE);
});

test("P1 regression: alarm view output schema admits v2 fields only", () => {
  const h = harness();
  const listDef = h.byName["proactive_list"];
  // The array branch of the output oneOf carries the alarm view items schema.
  const viewSchema = (listDef.output!.schema as { oneOf: Array<{ type: string; items: unknown }> }).oneOf[0].items as Parameters<typeof validateJsonSchemaValue>[0];
  const base = {
    id: "a", sessionId: "s1", type: "once", targetMode: "resume", targetSessionId: "s1",
    respectQuietHours: false, prompt: "p", nextDueAt: "2026-09-02T00:00:00.000Z",
    state: "scheduled", deliveryMode: "host", at: "2026-09-02T00:00:00.000Z"
  };
  assert.deepEqual(validateJsonSchemaValue(viewSchema, base, "value"), []);
  // Legacy fields are rejected by the schema now (they are no longer in the view).
  const legacy = validateJsonSchemaValue(viewSchema, { ...base, mode: "one-shot", wakeReason: "alarm", jitter: 0.15 }, "value");
  assert.notDeepEqual(legacy, []);
});

test("P0 regression: every/cron alarm views pass the runtime output schema gate", () => {
  const h = harness();
  const listDef = h.byName["proactive_list"];
  const viewSchema = (listDef.output!.schema as { oneOf: Array<{ type: string; items: unknown }> }).oneOf[0].items as Parameters<typeof validateJsonSchemaValue>[0];
  const base = { id: "a", sessionId: "s1", prompt: "p", nextDueAt: "2026-09-02T00:00:00.000Z", state: "scheduled", deliveryMode: "host" };
  // A jittered every view must validate (optional fields, no extras).
  const jittered = validateJsonSchemaValue(viewSchema, { ...base, type: "every", targetMode: "resume", targetSessionId: "s1", respectQuietHours: true, everySeconds: 300, jitterSeconds: 120 }, "value");
  assert.deepEqual(jittered, [], "jittered every view must validate");
  // A plain cron view (no jitter, no targetSessionId for new) must validate too.
  const cron = validateJsonSchemaValue(viewSchema, { ...base, type: "cron", targetMode: "new", respectQuietHours: false, cron: "0 9 * * 1-5" }, "value");
  assert.deepEqual(cron, [], "new-target cron view must validate");
});

test("proactive_update_settings: partial update changes only the given field", async () => {
  const h = harness();
  const before = h.config.maxDeliveriesPerDay;
  const snapshot = structuredClone({
    enabled: h.config.enabled,
    maxDeliveriesPerDay: h.config.maxDeliveriesPerDay,
    quietHours: h.config.quietHours
  });
  const out = await h.run("proactive_update_settings", { max_deliveries_per_day: before + 2 }) as Record<string, unknown>;
  assert.equal(out.max_deliveries_per_day, before + 2);
  // Only the requested field changed in the live config; every other field is
  // bit-identical to the pre-update snapshot (not trivially self-referential).
  assert.equal(h.config.maxDeliveriesPerDay, before + 2);
  assert.deepEqual(h.config.enabled, snapshot.enabled);
  assert.deepEqual(h.config.quietHours, snapshot.quietHours);
  // Persisted to config.json (merged over the file, other keys intact).
  const file = JSON.parse(readFileSync(join(h.dir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.equal(file["maxDeliveriesPerDay"], before + 2);
  assert.ok(!("enabled" in file), "unrelated keys must not be persisted");
});

test("proactive_update_settings: rejects unknown keys and out-of-range values", async () => {
  const h = harness();
  assert.equal(code(await h.run("proactive_update_settings", {})), "invalid_trigger");
  assert.equal(code(await h.run("proactive_update_settings", { nope: 1 })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_update_settings", { heartbeat_prompt: "deleted in v2" })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_update_settings", { quiet_hours: { start: "25:00", end: "07:00", time_zone: "UTC" } })), "invalid_trigger");
  // Nothing was applied or persisted.
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
test("proactive_update_settings: default_prompt updates, persists, and shows in the settings view", async () => {
  const h = harness();
  const out = await h.run("proactive_update_settings", { default_prompt: "  新的默认预设  " }) as Record<string, unknown>;
  assert.equal(out["default_prompt"], "新的默认预设");
  assert.equal(h.config.defaultPrompt, "新的默认预设");
  const file = JSON.parse(readFileSync(join(h.dir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.equal(file["defaultPrompt"], "新的默认预设");
  // Invalid shapes stay closed.
  assert.equal(code(await h.run("proactive_update_settings", { default_prompt: "   " })), "invalid_trigger");
});
