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

function harness(extra: Partial<ToolServices> = {}) {
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
    now: () => NOW,
    ...extra
  } satisfies ToolServices;
  // Agent carries a live sessions facade: its own session has one user rpc
  // message carrying the browser zone, so omitted time_zone resolves there.
  const sessionsFacade = { get: (id: string) => (id === "s1" ? { events: [{ type: "user/message", time: 100, data: { source: { kind: "user", rpcId: "r1", clientTimeZone: "Asia/Tokyo" } } }] } : undefined) };
  const agent = {
    session: { id: "s1", header: { cwd: "/work" } },
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
const asView = (v: unknown) => v as { id?: string; type?: string; targetMode?: string; targetSessionId?: string; respectQuietHours?: boolean; state?: string; everySeconds?: number; cron?: string; at?: string; nextDueAt?: string; jitterSeconds?: number; compaction?: string; prompt?: string; timeZone?: string; targetWorkspaceId?: string };

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

test("proactive_set maps target_mode workspace through the create-side resolver", async () => {
  // The resolver mirrors the real one (resolveWorkspaceArg over a registry):
  // id passes through, path normalizes to the canonical id, default derives
  // from the creator session's cwd, and its closed errors surface verbatim.
  const seen: Record<string, unknown>[] = [];
  const h = harness({
    resolveWorkspace: async (args, sessionCwd) => {
      seen.push({ ...args, __sessionCwd: sessionCwd });
      // strip the path key exactly like the real resolver (resolveWorkspaceArg)
      const { ["target_workspace_path"]: _strip, ...rest } = args;
      if (rest["target_workspace_id"] === "ws-1") return { ...rest, target_workspace_id: "ws-1" };
      if (args["target_workspace_path"] === "/repos/alpha") return { ...rest, target_workspace_id: "ws-1" };
      if (rest["target_workspace_id"] === undefined && args["target_workspace_path"] === undefined) {
        if (sessionCwd === "/work") return { ...rest, target_workspace_id: "ws-1" };
        return { code: "not_found", message: "no workspace is registered for this session's directory (/other)" };
      }
      return { code: "not_found", message: "workspace not found" };
    }
  });
  // explicit id — the legacy spelling NORMALIZES to resume + workspace source
  const byId = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5, target_mode: "workspace", target_workspace_id: "ws-1" }));
  assert.equal(byId.targetMode, "resume");
  assert.equal((byId as { targetSource?: string }).targetSource, "workspace");
  assert.equal((byId as { targetWorkspaceId?: string }).targetWorkspaceId, "ws-1");
  assert.equal(byId.targetSessionId, undefined);
  // path spelling normalizes before the closed validation
  const byPath = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5, target_mode: "workspace", target_workspace_path: "/repos/alpha" }));
  assert.equal((byPath as { targetSource?: string }).targetSource, "workspace");
  assert.equal((byPath as { targetWorkspaceId?: string }).targetWorkspaceId, "ws-1");
  // no selector: the creator session's cwd (/work from the harness agent)
  const byDefault = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5, target_mode: "workspace" }));
  assert.equal((byDefault as { targetSource?: string }).targetSource, "workspace");
  assert.equal((byDefault as { targetWorkspaceId?: string }).targetWorkspaceId, "ws-1");
  assert.equal(seen.length, 3);
  assert.equal(seen[2]["__sessionCwd"], "/work");
  // resolver error surfaces verbatim as the tool error
  const missing = await h.run("proactive_set", { prompt: "x", after_seconds: 5, target_mode: "workspace", target_workspace_id: "ws-gone" });
  assert.equal(code(missing), "not_found");
  // resolver absent (headless host): closed not_found, nothing stored
  const bare = harness();
  const unavailable = await bare.run("proactive_set", { prompt: "x", after_seconds: 5, target_mode: "workspace", target_workspace_id: "ws-1" });
  assert.equal(code(unavailable), "not_found");
  assert.ok(String((unavailable as { message?: string }).message).includes("unavailable on this host"));
  // workspace + target_session_id is rejected by the closed validator
  const mixed = harness({ resolveWorkspace: async (args) => args });
  assert.equal(code(await mixed.run("proactive_set", { prompt: "x", after_seconds: 5, target_mode: "workspace", target_workspace_id: "ws-1", target_session_id: "s9" })), "invalid_trigger");
  // v3 dialect: a bare target_workspace_id under the default resume mode
  // infers the workspace source (the old strict rejection is superseded)
  const inferred = harness({ resolveWorkspace: async (args) => args });
  const inferredView = asView(await inferred.run("proactive_set", { prompt: "x", after_seconds: 5, target_workspace_id: "ws-1" }));
  assert.equal(inferredView.targetMode, "resume");
  assert.equal((inferredView as { targetSource?: string }).targetSource, "workspace");
  // resume + target_source session still rejects a stray workspace id
  assert.equal(code(await inferred.run("proactive_set", { prompt: "x", after_seconds: 5, target_source: "session", target_session_id: "s1", target_workspace_id: "ws-1" })), "invalid_trigger");
  bare.cleanup();
  mixed.cleanup();
  inferred.cleanup();
  h.cleanup();
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

test("proactive_list with all=true lists active alarms across all sessions", async () => {
  const h = harness();
  h.store.alarms = [
    v2Fixture("a", "s1"),                              // s1 scheduled
    { ...v2Fixture("b", "s1"), status: "in-flight" },   // s1 in-flight
    { ...v2Fixture("c", "s1"), status: "completed" },  // s1 terminal
    v2Fixture("d", "s2"),                               // s2 scheduled
    { ...v2Fixture("e", "s2"), status: "paused" },      // s2 paused (not active for list)
    { ...v2Fixture("f", "s2"), status: "failed" }       // s2 terminal
  ];
  // Default: only this session's (s1) active alarms → a + b
  const ownRes = await h.run("proactive_list", {}) as { id?: string }[];
  assert.equal(ownRes.length, 2);
  // all=true: active alarms across all sessions → a + b + d (paused/terminal excluded)
  const allRes = await h.run("proactive_list", { all: true }) as { id?: string }[];
  assert.equal(allRes.length, 3);
  assert.deepEqual(allRes.map((r) => r.id).sort(), ["a", "b", "d"]);
});

test("proactive_cancel cancels any owner by exact id; unknown/finished map to not_found", async () => {
  const h = harness();
  const created = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5 }));
  const id = created.id as string;
  const ok = await h.run("proactive_cancel", { id });
  assert.deepEqual(ok, { id, cancelled: true });
  assert.equal(h.store.alarms.length, 0);
  assert.equal(code(await h.run("proactive_cancel", { id: "nope" })), "not_found");
  // cross-session: a foreign-owned alarm is cancellable too (ids via all=true)
  h.store.addAlarm(v2Fixture("foreign", "s2"));
  assert.deepEqual(await h.run("proactive_cancel", { id: "foreign" }), { id: "foreign", cancelled: true });
  // terminal states stay not_found, never { cancelled: false }
  h.store.addAlarm(v2Fixture("done", "s1", "completed"));
  assert.equal(code(await h.run("proactive_cancel", { id: "done" })), "not_found");
});

test("proactive_update replaces a foreign-owned alarm's spec, keeping identity and history", async () => {
  // The whole point of the tool: any session can retarget/refire-schedule any
  // alarm once it knows the id (proactive_list all=true).
  const original = v2Fixture("alarm-x", "s2");
  original.runCount = 3;
  original.lastRunAt = "2026-09-01T08:00:00.000Z";
  original.prompt = "old prompt";
  const h = harness({ sessionEvents: (sessionId) => (sessionId === "s2" ? [{ type: "user/message", time: 100, data: { source: { kind: "user", rpcId: "r1", clientTimeZone: "Asia/Tokyo" } } }] : undefined) });
  h.store.addAlarm(original);
  const view = asView(await h.run("proactive_update", { id: "alarm-x", prompt: "new prompt", every_seconds: 600 }));
  // full dialect honored: prompt + trigger replaced
  assert.equal(view.prompt, "new prompt");
  assert.equal(view.type, "every");
  assert.equal(view.everySeconds, 600);
  // zone default chain follows the OWNING session's client zone, not the editor's
  assert.equal((view as { timeZone?: string }).timeZone, "Asia/Tokyo");
  const stored = h.store.getAlarm("alarm-x") as Alarm;
  // identity + history preserved; owner unchanged (this session is s1, owner stays s2)
  assert.equal(stored.ownerSessionId, "s2");
  assert.equal(stored.createdAt, original.createdAt);
  assert.equal(stored.runCount, 3);
  assert.equal(stored.lastRunAt, original.lastRunAt);
  assert.equal(stored.status, "scheduled");
  assert.ok(stored.updatedAt > original.updatedAt);
  assert.equal(h.requestDrives, 1);
});

test("proactive_update: full-dialect validation and state guards", async () => {
  const h = harness();
  h.store.addAlarm(v2Fixture("gone", "s2"));
  assert.equal(code(await h.run("proactive_update", { id: "missing", prompt: "x", after_seconds: 5 })), "not_found");
  // the dialect is full-replace: exactly one selector always required
  // (prompt itself is schema-required, so its absence is caught by the tool
  // runtime before the closed dialect sees it)
  assert.equal(code(await h.run("proactive_update", { id: "gone", prompt: "x" })), "invalid_trigger");
  assert.equal(code(await h.run("proactive_update", { id: "gone", prompt: "x", every_seconds: 299 })), "frequency_too_high");
  // unknown keys stay closed (id itself is stripped by the tool)
  assert.equal(code(await h.run("proactive_update", { id: "gone", prompt: "x", after_seconds: 5, wake_reason: "y" })), "invalid_trigger");
  // non-editable states are invalid_action, not not_found (the alarm exists)
  for (const status of ["in-flight", "completed", "cancelled", "failed"] as const) {
    h.store.addAlarm(v2Fixture("st-" + status, "s1", status));
    assert.equal(code(await h.run("proactive_update", { id: "st-" + status, prompt: "x", after_seconds: 5 })), "invalid_action");
  }
  // paused is editable and comes back scheduled
  h.store.addAlarm(v2Fixture("paused-one", "s1", "paused"));
  const view = asView(await h.run("proactive_update", { id: "paused-one", prompt: "x", after_seconds: 5 }));
  assert.equal(view.state, "scheduled");
});

test("proactive_update: workspace target keeps the alarm's workspace unless given a new one", async () => {
  // No resolver wired: an explicit path/new-id arm would fail closed, but the
  // carryover of the already-resolved id must not need one.
  const h = harness();
  const wsAlarm: Alarm = { ...v2Fixture("ws-alarm", "s2"), target: { mode: "workspace", workspaceId: "ws-9" } };
  h.store.addAlarm(wsAlarm);
  const view = asView(await h.run("proactive_update", { id: "ws-alarm", prompt: "x", after_seconds: 5, target_mode: "workspace" }));
  // the legacy spelling re-normalizes to resume + workspace source
  assert.equal(view.targetMode, "resume");
  assert.equal((view as { targetSource?: string }).targetSource, "workspace");
  assert.equal((view as { targetWorkspaceId?: string }).targetWorkspaceId, "ws-9");
  // a new explicit id routes through the resolver (unavailable here → closed error)
  assert.equal(code(await h.run("proactive_update", { id: "ws-alarm", prompt: "x", after_seconds: 5, target_mode: "workspace", target_workspace_id: "ws-other" })), "not_found");
  // switching a non-workspace alarm to workspace with no args uses the editor's cwd default → resolver → closed error
  h.store.addAlarm(v2Fixture("plain", "s2"));
  assert.equal(code(await h.run("proactive_update", { id: "plain", prompt: "x", after_seconds: 5, target_mode: "workspace" })), "not_found");
});

test("proactive_update restores the old alarm when persistence fails", async () => {
  const h = harness();
  h.store.addAlarm(v2Fixture("keep", "s2"));
  h.store.failPersist = true;
  assert.equal(code(await h.run("proactive_update", { id: "keep", prompt: "x", after_seconds: 5 })), "persistence_uncertain");
  const stored = h.store.getAlarm("keep") as Alarm;
  assert.equal(stored.prompt, "p"); // rolled back, not the half-updated spec
  assert.equal(stored.type, "once");
});

test("proactive_cancel restores the alarm when persistence fails", async () => {
  const h = harness();
  const created = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5 }));
  const id = created.id as string;
  h.store.failPersist = true;
  assert.equal(code(await h.run("proactive_cancel", { id })), "persistence_uncertain");
  assert.equal(h.store.alarms.length, 1);
});

test("proactive_update_settings: silentWakeCompaction gate updates, persists, and appears in the settings view", async () => {
  const h = harness();
  const out = await h.run("proactive_update_settings", { silent_wake_compaction: true }) as Record<string, unknown>;
  assert.equal(out["silent_wake_compaction"], true);
  assert.equal(h.config.silentWakeCompaction, true);
  const file = JSON.parse(readFileSync(join(h.dir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.equal(file["silentWakeCompaction"], true);
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
    state: "scheduled", deliveryMode: "host", compaction: "minimal", at: "2026-09-02T00:00:00.000Z"
  };
  assert.deepEqual(validateJsonSchemaValue(viewSchema, base, "value"), []);
  // Legacy fields are rejected by the schema now (they are no longer in the view).
  const legacy = validateJsonSchemaValue(viewSchema, { ...base, mode: "one-shot", wakeReason: "alarm", jitter: 0.15 }, "value");
  assert.notDeepEqual(legacy, []);
  // compaction is required: a view missing it is rejected by the schema gate.
  const { compaction: _omit, ...noCompaction } = base;
  void _omit;
  assert.notDeepEqual(validateJsonSchemaValue(viewSchema, noCompaction, "value"), []);
});

test("P0 regression: every/cron alarm views pass the runtime output schema gate", () => {
  const h = harness();
  const listDef = h.byName["proactive_list"];
  const viewSchema = (listDef.output!.schema as { oneOf: Array<{ type: string; items: unknown }> }).oneOf[0].items as Parameters<typeof validateJsonSchemaValue>[0];
  const base = { id: "a", sessionId: "s1", prompt: "p", nextDueAt: "2026-09-02T00:00:00.000Z", state: "scheduled", deliveryMode: "host", compaction: "minimal" };
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
  const out = await h.run("proactive_update_settings", { max_deliveries_per_day: before - 1 }) as Record<string, unknown>;
  assert.equal(out.max_deliveries_per_day, before - 1);
  // Only the requested field changed in the live config; every other field is
  // bit-identical to the pre-update snapshot (not trivially self-referential).
  assert.equal(h.config.maxDeliveriesPerDay, before - 1);
  assert.deepEqual(h.config.enabled, snapshot.enabled);
  assert.deepEqual(h.config.quietHours, snapshot.quietHours);
  // Persisted to config.json (merged over the file, other keys intact).
  const file = JSON.parse(readFileSync(join(h.dir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.equal(file["maxDeliveriesPerDay"], before - 1);
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

test("proactive_set compaction defaults to minimal and accepts all modes", async () => {
  const h = harness();
  const def = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5 }));
  assert.equal(def.compaction, "minimal");
  const off = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5, compaction: "off" }));
  assert.equal(off.compaction, "off");
  const agg = asView(await h.run("proactive_set", { prompt: "x", after_seconds: 5, compaction: "aggressive" }));
  assert.equal(agg.compaction, "aggressive");
});

test("validateCreateArgs rejects an invalid compaction value", () => {
  const bad = validateCreateArgs({ prompt: "x", after_seconds: 5, compaction: "bogus" }, "s1") as { code?: string };
  assert.equal(bad.code, "invalid_trigger");
});

test("proactive_silence concludes the turn during an active wake and records a reason", async () => {
  const h = harness();
  h.activeWakes.add("s1"); // the wake driver marks the session inflight
  assert.equal(h.concluded(), false);
  const res = await h.run("proactive_silence", { reason: "nothing to do" });
  assert.deepEqual(res, { accepted: true, silent: true });
  assert.equal(h.concluded(), true);
  // reason over the cap is a closed invalid_trigger
  assert.equal(code(await h.run("proactive_silence", { reason: "r".repeat(201) })), "invalid_trigger");
  h.cleanup();
});

test("proactive_silence is closed outside an active wake (no hard fallback)", async () => {
  const h = harness();
  // No active wake for s1 — the inflight guard surfaces a closed error so the
  // model can self-correct (e.g. end with no text, or use a no-reply tool).
  const res = await h.run("proactive_silence", { reason: "x" }) as { code?: string; message?: string };
  assert.equal(res.code, "invalid_action");
  assert.ok(String(res.message).includes("only available during an active dsh-proactive wake"));
  assert.equal(h.concluded(), false); // did NOT conclude the turn
  h.cleanup();
});
