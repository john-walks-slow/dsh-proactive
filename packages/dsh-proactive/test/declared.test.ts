import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globToRegExp, parseScheduleFile, declaredAlarmId, syncDeclaredSchedules, stableStringify, type DeclaredSyncDeps, type DeclaredSyncStore } from "../src/declared.js";
import { resolveConfig } from "../src/config.js";
import type { Alarm, ToolError } from "../src/domain.js";
import { proactiveToolDefinitions } from "../src/tools.js";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";

const NOW = Date.parse("2026-09-01T09:00:00.000Z");
const FUTURE_AT = "2026-09-01T18:00:00+08:00"; // 10:00Z > NOW
const PAST_AT = "2026-09-01T10:00:00+08:00"; // 02:00Z < NOW

function scratch(): { dir: string; workspace: string; scheduleFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-declared-"));
  const workspace = join(dir, "agents", "yu");
  mkdirSync(join(workspace, ".life"), { recursive: true });
  const scheduleFile = join(workspace, ".life", "wake_schedule.json");
  return { dir, workspace, scheduleFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** In-memory store (same shape as the real one for the sync's needs). */
class SyncStore implements DeclaredSyncStore {
  alarms: Alarm[] = [];
  persists = 0;
  listAlarms(): readonly Alarm[] { return this.alarms; }
  getAlarm(id: string): Alarm | undefined { return this.alarms.find((a) => a.id === id); }
  addAlarm(alarm: Alarm): void { this.alarms.push(alarm); }
  replaceAlarm(alarm: Alarm): void {
    const i = this.alarms.findIndex((a) => a.id === alarm.id);
    if (i >= 0) this.alarms[i] = alarm;
  }
  removeAlarm(id: string): void {
    const i = this.alarms.findIndex((a) => a.id === id);
    if (i >= 0) this.alarms.splice(i, 1);
  }
  async persist(): Promise<void> { this.persists++; }
}

function makeDeps(scheduleFile: string, store: SyncStore, overrides: Partial<DeclaredSyncDeps> = {}): DeclaredSyncDeps & { logs: string[] } {
  const logs: string[] = [];
  // A never-created dataDir: config.json load ENOENTs into defaults.
  const configDir = join(tmpdir(), "dsh-proactive-declared-cfg-" + Math.random().toString(36).slice(2));
  return {
    config: { ...resolveConfig(configDir), scheduleFiles: [scheduleFile] },
    store,
    now: () => NOW,
    resolveWorkspace: async (args: Record<string, unknown>) => {
      const next = { ...args };
      delete next["target_workspace_path"];
      next["target_workspace_id"] = "ws-yu";
      return next;
    },
    log: (level, message) => logs.push(level + ": " + message),
    logs,
    ...overrides
  };
}

test("globToRegExp: * stays in segment, ** crosses segments, ? matches one char", () => {
  const single = globToRegExp("/root/agents/*/.life/wake_schedule.json");
  assert.equal(single.test("/root/agents/yu/.life/wake_schedule.json"), true);
  assert.equal(single.test("/root/agents/yu/sub/.life/wake_schedule.json"), false);
  const cross = globToRegExp("/root/**/wake_schedule.json");
  assert.equal(cross.test("/root/a/b/c/wake_schedule.json"), true);
  assert.equal(cross.test("/root/wake_schedule.json"), true);
  const question = globToRegExp("/root/agent?/wake_schedule.json");
  assert.equal(question.test("/root/agents/wake_schedule.json"), true);
  assert.equal(question.test("/root/agentss/wake_schedule.json"), false);
  // regex metacharacters in the pattern are literal
  const literal = globToRegExp("/root/a.b+wakeup.json");
  assert.equal(literal.test("/root/a.b+wakeup.json"), true);
  assert.equal(literal.test("/root/aXb+wakeup.json"), false);
});

test("parseScheduleFile: defaults merge, entry wins, unknown keys rejected", () => {
  const text = JSON.stringify({
    version: 1,
    time_zone: "Asia/Shanghai",
    respect_quiet_hours: true,
    target: { workspace_path: "/root/agents/yu" },
    entries: [
      { id: "e1", at: FUTURE_AT, prompt: "hello", respect_quiet_hours: false },
      { id: "e2", cron: "0 9 * * *", prompt: "morning" },
      { id: "e3", at: FUTURE_AT, prompt: "x", bogus: true }
    ]
  });
  const parsed = parseScheduleFile("/w/.life/wake_schedule.json", text);
  assert.equal(parsed.fatal, false);
  // The typo'd entry is dropped whole (fail closed), not partially created.
  assert.equal(parsed.entries.length, 2);
  const e1 = parsed.entries[0];
  assert.equal(e1.args["time_zone"], "Asia/Shanghai");
  assert.equal(e1.args["respect_quiet_hours"], false); // entry override wins
  assert.equal(e1.args["target_workspace_path"], "/root/agents/yu");
  assert.equal(e1.needsWorkspaceDefault, false);
  const e2 = parsed.entries[1];
  assert.equal(e2.args["target_workspace_path"], "/root/agents/yu"); // file default target
  assert.equal(e2.args["respect_quiet_hours"], true);
  assert.equal(e2.needsWorkspaceDefault, false);
  assert.equal(parsed.errors.some((message) => message.includes("e3") && message.includes("bogus")), true);
});

test("parseScheduleFile: empty/absent target falls back to the file's own workspace", () => {
  const text = JSON.stringify({
    version: 1,
    entries: [
      { id: "a", at: FUTURE_AT, prompt: "p" },
      { id: "b", at: FUTURE_AT, prompt: "p", target: {} }
    ]
  });
  const parsed = parseScheduleFile("/w/.life/wake_schedule.json", text);
  assert.equal(parsed.fatal, false);
  assert.equal(parsed.entries.every((entry) => entry.needsWorkspaceDefault), true);
});

test("parseScheduleFile: fatal documents and per-entry errors", () => {
  const broken = parseScheduleFile("/f", "{ not json");
  assert.equal(broken.fatal, true);
  const wrongVersion = parseScheduleFile("/f", JSON.stringify({ version: 2, entries: [] }));
  assert.equal(wrongVersion.fatal, true);
  const noEntries = parseScheduleFile("/f", JSON.stringify({ version: 1 }));
  assert.equal(noEntries.fatal, true);
  const dup = parseScheduleFile("/f", JSON.stringify({ version: 1, entries: [{ id: "x", at: FUTURE_AT, prompt: "p" }, { id: "x", at: FUTURE_AT, prompt: "q" }] }));
  assert.equal(dup.fatal, false);
  assert.equal(dup.entries.length, 1);
  assert.equal(dup.errors.some((message) => message.includes("duplicate")), true);
});

test("declaredAlarmId is stable per (file, entry) and stableStringify is key-order independent", () => {
  assert.equal(declaredAlarmId("/a", "e1"), declaredAlarmId("/a", "e1"));
  assert.notEqual(declaredAlarmId("/a", "e1"), declaredAlarmId("/a", "e2"));
  assert.notEqual(declaredAlarmId("/a", "e1"), declaredAlarmId("/b", "e1"));
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
});

test("sync: future entry creates a declared alarm, past entry is skipped", async () => {
  const { scheduleFile, cleanup } = scratch();
  try {
    writeFileSync(scheduleFile, JSON.stringify({
      version: 1,
      time_zone: "Asia/Shanghai",
      entries: [
        { id: "future", at: FUTURE_AT, prompt: "go", target: { workspace_id: "ws-yu" } },
        { id: "past", at: PAST_AT, prompt: "late", target: { workspace_id: "ws-yu" } }
      ]
    }), "utf8");
    const store = new SyncStore();
    const deps = makeDeps(scheduleFile, store);
    const summary = await syncDeclaredSchedules(deps);
    assert.equal(summary.created, 1);
    assert.equal(summary.skippedPast, 1);
    assert.equal(summary.mutated, true);
    const alarm = store.alarms[0];
    assert.equal(alarm.ownerSessionId, "declared-schedule");
    assert.equal(alarm.type, "once");
    assert.equal(alarm.target.mode, "resume");
    assert.equal(alarm.respectQuietHours, false);
    assert.equal(alarm.declared?.entry, "future");
    assert.equal(typeof alarm.declared?.hash, "string");
    // nextDueAt is the resolved instant, no jitter redraw drift
    assert.equal(alarm.nextDueAt, new Date(Date.parse(FUTURE_AT)).toISOString());
  } finally {
    cleanup();
  }
});

test("sync: second pass is a no-op (no re-draw, no churn)", async () => {
  const { scheduleFile, cleanup } = scratch();
  try {
    writeFileSync(scheduleFile, JSON.stringify({
      version: 1,
      entries: [{ id: "e", every_seconds: 3600, prompt: "loop", target: { workspace_id: "ws-yu" } }]
    }), "utf8");
    const store = new SyncStore();
    const deps = makeDeps(scheduleFile, store);
    const first = await syncDeclaredSchedules(deps);
    assert.equal(first.created, 1);
    const snapshot = JSON.stringify(store.alarms);
    const second = await syncDeclaredSchedules(deps);
    assert.equal(second.created + second.updated + second.removed, 0);
    assert.equal(second.mutated, false);
    assert.equal(JSON.stringify(store.alarms), snapshot);
  } finally {
    cleanup();
  }
});

test("sync: prompt edit replaces the alarm, entry removal removes it", async () => {
  const { scheduleFile, cleanup } = scratch();
  try {
    const doc = { version: 1, entries: [{ id: "e", at: FUTURE_AT, prompt: "v1", target: { workspace_id: "ws-yu" } }] };
    writeFileSync(scheduleFile, JSON.stringify(doc), "utf8");
    const store = new SyncStore();
    const deps = makeDeps(scheduleFile, store);
    await syncDeclaredSchedules(deps);
    doc.entries[0].prompt = "v2";
    writeFileSync(scheduleFile, JSON.stringify(doc), "utf8");
    const edit = await syncDeclaredSchedules(deps);
    assert.equal(edit.updated, 1);
    assert.equal(store.alarms[0].prompt, "v2");
    writeFileSync(scheduleFile, JSON.stringify({ version: 1, entries: [] }), "utf8");
    const remove = await syncDeclaredSchedules(deps);
    assert.equal(remove.removed, 1);
    assert.equal(store.alarms.length, 0);
  } finally {
    cleanup();
  }
});

test("sync: broken JSON keeps the current alarms; deleted file removes them", async () => {
  const { scheduleFile, cleanup } = scratch();
  try {
    writeFileSync(scheduleFile, JSON.stringify({ version: 1, entries: [{ id: "e", at: FUTURE_AT, prompt: "p", target: { workspace_id: "ws-yu" } }] }), "utf8");
    const store = new SyncStore();
    const deps = makeDeps(scheduleFile, store);
    await syncDeclaredSchedules(deps);
    assert.equal(store.alarms.length, 1);
    writeFileSync(scheduleFile, "{ broken", "utf8");
    const broken = await syncDeclaredSchedules(deps);
    assert.equal(broken.removed, 0);
    assert.equal(store.alarms.length, 1);
    assert.equal(broken.errors.length > 0, true);
    rmSync(scheduleFile);
    const gone = await syncDeclaredSchedules(deps);
    assert.equal(gone.removed, 1);
    assert.equal(store.alarms.length, 0);
  } finally {
    cleanup();
  }
});

test("sync: no target + registry defaults to the file's own workspace; registry miss errors the entry but keeps an existing alarm", async () => {
  const { scheduleFile, cleanup } = scratch();
  try {
    writeFileSync(scheduleFile, JSON.stringify({ version: 1, entries: [{ id: "e", at: FUTURE_AT, prompt: "p" }] }), "utf8");
    const store = new SyncStore();
    const deps = makeDeps(scheduleFile, store);
    const ok = await syncDeclaredSchedules(deps);
    assert.equal(ok.created, 1);
    assert.deepEqual(store.alarms[0].target, { mode: "resume", sourceType: "workspace", workspaceId: "ws-yu" });
    // Now the registry can no longer resolve the file's directory: the entry
    // fails to prepare, and the existing alarm is KEPT (no removal churn).
    const failDeps = makeDeps(scheduleFile, store, {
      resolveWorkspace: async (): Promise<Record<string, unknown> | ToolError> => ({ code: "not_found", message: "no workspace is registered for path /gone" })
    });
    const miss = await syncDeclaredSchedules(failDeps);
    assert.equal(miss.errors.length, 1);
    assert.equal(miss.removed, 0);
    assert.equal(store.alarms.length, 1);
  } finally {
    cleanup();
  }
});

test("sync: feature off (empty scheduleFiles) removes declared alarms but leaves regular ones", async () => {
  const { scheduleFile, cleanup } = scratch();
  try {
    writeFileSync(scheduleFile, JSON.stringify({ version: 1, entries: [{ id: "e", at: FUTURE_AT, prompt: "p", target: { workspace_id: "ws-yu" } }] }), "utf8");
    const store = new SyncStore();
    const deps = makeDeps(scheduleFile, store);
    await syncDeclaredSchedules(deps);
    store.alarms.push({
      id: "alarm_regular",
      ownerSessionId: "s1",
      target: { mode: "resume", sessionId: "s1" },
      type: "once",
      trigger: { at: "2026-09-02T00:00:00.000Z" },
      prompt: "regular",
      respectQuietHours: false,
      timeZone: "UTC",
      status: "scheduled",
      nextDueAt: "2026-09-02T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      runCount: 0,
      lastRunAt: null
    });
    const offDeps = makeDeps(scheduleFile, store, { config: { scheduleFiles: [], schedulePollSeconds: 60 } });
    const off = await syncDeclaredSchedules(offDeps);
    assert.equal(off.removed, 1);
    assert.deepEqual(store.alarms.map((alarm) => alarm.id), ["alarm_regular"]);
  } finally {
    cleanup();
  }
});

test("sync: glob expansion matches sibling workspaces' schedule files", async () => {
  const { dir, workspace, cleanup } = scratch();
  try {
    mkdirSync(join(dir, "agents", "luna", ".life"), { recursive: true });
    writeFileSync(join(workspace, ".life", "wake_schedule.json"), JSON.stringify({ version: 1, entries: [{ id: "yu", at: FUTURE_AT, prompt: "p", target: { workspace_id: "ws-yu" } }] }), "utf8");
    writeFileSync(join(dir, "agents", "luna", ".life", "wake_schedule.json"), JSON.stringify({ version: 1, entries: [{ id: "luna", at: FUTURE_AT, prompt: "p", target: { workspace_id: "ws-luna" } }] }), "utf8");
    const store = new SyncStore();
    const deps = makeDeps(join(dir, "agents", "*", ".life", "wake_schedule.json"), store);
    const summary = await syncDeclaredSchedules(deps);
    assert.equal(summary.matchedFiles, 2);
    assert.equal(summary.created, 2);
    assert.deepEqual(store.alarms.map((alarm) => alarm.declared?.entry).sort(), ["luna", "yu"]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// tool guards: declared alarms refuse update/cancel
// ---------------------------------------------------------------------------

function toolHarness(alarms: Alarm[]) {
  const store: DeclaredSyncStore = {
    listAlarms: () => alarms,
    getAlarm: (id) => alarms.find((a) => a.id === id),
    addAlarm: (alarm) => alarms.push(alarm),
    replaceAlarm: (alarm) => {
      const i = alarms.findIndex((a) => a.id === alarm.id);
      if (i >= 0) alarms[i] = alarm;
    },
    removeAlarm: (id) => {
      const i = alarms.findIndex((a) => a.id === id);
      if (i >= 0) alarms.splice(i, 1);
    },
    persist: async () => undefined
  };
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-decl-tools-"));
  const agent = { session: { id: "s1", header: { cwd: "/work" } }, ctx: { get: () => undefined } } as unknown as Agent;
  const defs = proactiveToolDefinitions(agent, {
    store: store as never,
    config: { ...resolveConfig(dir), maxPromptLength: 4000 },
    driver: { isActiveWake: () => false } as never,
    scheduler: { requestDrive: () => undefined } as never,
    now: () => NOW
  });
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  const exec = { agent } as unknown as ToolRunContext;
  return {
    run: (tool: string, args: Record<string, unknown>) => byName[tool].execute(args, exec) as Promise<unknown>,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

function declaredFixture(id: string, status: Alarm["status"] = "scheduled"): Alarm {
  return {
    id,
    ownerSessionId: "declared-schedule",
    target: { mode: "resume", sourceType: "workspace", workspaceId: "ws-yu" },
    type: "once",
    trigger: { at: "2026-09-02T00:00:00.000Z" },
    prompt: "declared",
    respectQuietHours: false,
    timeZone: "UTC",
    status,
    nextDueAt: "2026-09-02T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    runCount: 0,
    lastRunAt: null,
    declared: { file: "/root/agents/yu/.life/wake_schedule.json", entry: "e1", hash: "abc" }
  };
}

test("tools: cancel/update on a declared alarm are refused with invalid_action", async () => {
  const alarms = [declaredFixture("decl_x")];
  const { run, cleanup } = toolHarness(alarms);
  try {
    const cancel = (await run("proactive_cancel", { id: "decl_x" })) as { code?: string };
    assert.equal(cancel.code, "invalid_action");
    assert.equal(alarms.length, 1);
    const update = (await run("proactive_update", { id: "decl_x", prompt: "new", at: "2026-09-03T00:00:00Z" })) as { code?: string };
    assert.equal(update.code, "invalid_action");
    assert.equal(alarms[0].prompt, "declared");
  } finally {
    cleanup();
  }
});

test("tools: a regular alarm is unaffected by the declared guard", async () => {
  const alarms = [declaredFixture("decl_x")];
  alarms[0].declared = undefined;
  alarms[0].ownerSessionId = "s1";
  alarms[0].target = { mode: "resume", sessionId: "s1" };
  const { run, cleanup } = toolHarness(alarms);
  try {
    const cancel = (await run("proactive_cancel", { id: "decl_x" })) as { cancelled?: boolean };
    assert.equal(cancel.cancelled, true);
    assert.equal(alarms.length, 0);
  } finally {
    cleanup();
  }
});

test("sync: min_idle_seconds flows from file defaults and entries into the alarm", async () => {
  const { scheduleFile, cleanup } = scratch();
  try {
    writeFileSync(scheduleFile, JSON.stringify({
      version: 1,
      min_idle_seconds: 300,
      entries: [
        { id: "entry-wins", every_seconds: 3600, prompt: "loop", min_idle_seconds: 600, target: { workspace_id: "ws-yu" } },
        { id: "default", every_seconds: 3600, prompt: "loop", target: { workspace_id: "ws-yu" } }
      ]
    }), "utf8");
    const store = new SyncStore();
    const deps = makeDeps(scheduleFile, store);
    const summary = await syncDeclaredSchedules(deps);
    assert.equal(summary.created, 2);
    const byEntry = new Map(store.alarms.map((alarm) => [alarm.declared?.entry, alarm]));
    assert.equal(byEntry.get("entry-wins")?.minIdleSeconds, 600); // entry override wins
    assert.equal(byEntry.get("default")?.minIdleSeconds, 300); // file-level default
  } finally {
    cleanup();
  }
});

test("sync: unchanged hash never rewrites a deferred nextDueAt (min-idle defer survives polling)", async () => {
  const { scheduleFile, cleanup } = scratch();
  try {
    writeFileSync(scheduleFile, JSON.stringify({
      version: 1,
      entries: [{ id: "e", every_seconds: 3600, prompt: "loop", min_idle_seconds: 600, target: { workspace_id: "ws-yu" } }]
    }), "utf8");
    const store = new SyncStore();
    const deps = makeDeps(scheduleFile, store);
    const first = await syncDeclaredSchedules(deps);
    assert.equal(first.created, 1);
    // Simulate the scheduler's min-idle deferral sliding nextDueAt forward.
    const deferred = new Date(NOW + 7 * 60_000).toISOString();
    store.alarms[0].nextDueAt = deferred;
    const second = await syncDeclaredSchedules(deps);
    assert.equal(second.created + second.updated + second.removed, 0);
    assert.equal(second.mutated, false);
    assert.equal(store.alarms[0].nextDueAt, deferred, "the sync must not clobber deferral state");
  } finally {
    cleanup();
  }
});
