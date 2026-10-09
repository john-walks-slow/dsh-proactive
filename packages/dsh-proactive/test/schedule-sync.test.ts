import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startScheduleSync, syncScheduleFiles, type ScheduleSyncDeps, type ScheduleSyncStore } from "../src/schedule-sync.js";
import { declaredAlarmId } from "../src/schedule-file.js";
import type { Alarm, ToolError } from "../src/domain.js";

const NOW = Date.parse("2026-09-01T09:00:00.000Z");
const FUTURE_AT = "2026-09-01T18:00:00+08:00"; // 10:00Z > NOW
const PAST_AT = "2026-09-01T10:00:00+08:00"; // 02:00Z < NOW

class SyncStore implements ScheduleSyncStore {
  alarms: Alarm[] = [];
  persists = 0;
  listAlarms(): readonly Alarm[] { return this.alarms; }
  getAlarm(id: string): Alarm | undefined { return this.alarms.find((a) => a.id === id); }
  addAlarm(alarm: Alarm): void { this.alarms.push(alarm); }
  replaceAlarm(alarm: Alarm): void {
    const i = this.alarms.findIndex((a) => a.id === alarm.id);
    if (i >= 0) this.alarms[i] = alarm;
  }
  removeAlarm(id: string): Alarm | undefined {
    const i = this.alarms.findIndex((a) => a.id === id);
    if (i < 0) return undefined;
    return this.alarms.splice(i, 1)[0];
  }
  async persist(): Promise<void> { this.persists++; }
}

function handle(file: string, overrides: Partial<Alarm> = {}): Alarm {
  return {
    id: "alarm_handle",
    ownerSessionId: "s-owner",
    target: { mode: "resume", sourceType: "workspace", workspaceId: "ws-yu" },
    type: "file",
    trigger: { file },
    prompt: "handle default prompt",
    respectQuietHours: false,
    timeZone: "UTC",
    status: "scheduled",
    nextDueAt: new Date(NOW).toISOString(),
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    runCount: 0,
    lastRunAt: null,
    ...overrides
  };
}

function children(store: SyncStore, handleId = "alarm_handle"): Alarm[] {
  return store.alarms.filter((a) => a.declared?.sourceId === handleId);
}

function scratch(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-sync-"));
  const file = join(dir, "ws", ".life", "wake_schedule.json");
  mkdirSync(join(dir, "ws", ".life"), { recursive: true });
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeDeps(store: SyncStore, overrides: Partial<ScheduleSyncDeps> = {}): ScheduleSyncDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    config: { schedulePollSeconds: 60 },
    store,
    now: () => NOW,
    resolveWorkspace: async (args: Record<string, unknown>): Promise<Record<string, unknown> | ToolError> => {
      const next = { ...args };
      delete next["target_workspace_path"];
      next["target_workspace_id"] = "ws-resolved";
      return next;
    },
    log: (level, message) => logs.push(level + ": " + message),
    logs,
    ...overrides
  };
}

const entry = (id: string, extra: Record<string, unknown> = {}) => ({ id, at: FUTURE_AT, ...extra });

test("sync: materializes one child per entry, owned by the handle's owner and stamped with sourceId", async () => {
  const { file, cleanup } = scratch();
  try {
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("e1"), entry("e2", { prompt: "own" })] }), "utf8");
    const store = new SyncStore();
    store.addAlarm(handle(file));
    const summary = await syncScheduleFiles(makeDeps(store));
    assert.equal(summary.created, 2);
    assert.equal(summary.handles, 1);
    const kids = children(store);
    assert.equal(kids.length, 2);
    for (const kid of kids) {
      assert.equal(kid.ownerSessionId, "s-owner");
      assert.equal(kid.declared?.sourceId, "alarm_handle");
      assert.equal(kid.declared?.file, file);
      assert.deepEqual(kid.target, { mode: "resume", sourceType: "workspace", workspaceId: "ws-yu" });
      assert.equal(kid.prompt, kid.declared?.entry === "e1" ? "handle default prompt" : "own");
    }
    assert.equal(store.persists, 1);
  } finally {
    cleanup();
  }
});

test("sync: an unchanged file never rewrites its children (anchors and defers survive)", async () => {
  const { file, cleanup } = scratch();
  try {
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ id: "e1", every_seconds: 3600 }] }), "utf8");
    const store = new SyncStore();
    store.addAlarm(handle(file));
    await syncScheduleFiles(makeDeps(store));
    const first = children(store)[0];
    assert.ok(first !== undefined);
    // Pass 2 moves the child exactly like the scheduler would (jitter anchor
    // or a min_idle deferral), pass 3 sees the very same file.
    const anchored: Alarm = { ...first, nextDueAt: "2026-09-01T12:00:00.000Z" };
    store.replaceAlarm(anchored);
    const moved = await syncScheduleFiles(makeDeps(store));
    assert.equal(moved.created + moved.updated + moved.removed, 0);
    assert.equal(children(store)[0].nextDueAt, "2026-09-01T12:00:00.000Z");
    assert.equal(children(store)[0].declared?.hash, first.declared?.hash);
    // With nothing left to derive, a third pass is a total no-op.
    const idle = await syncScheduleFiles(makeDeps(store));
    assert.equal(idle.mutated, false);
    assert.equal(store.persists, 2);
  } finally {
    cleanup();
  }
});

test("sync: editing one entry replaces only that child", async () => {
  const { file, cleanup } = scratch();
  try {
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("e1"), entry("e2")] }), "utf8");
    const store = new SyncStore();
    store.addAlarm(handle(file));
    await syncScheduleFiles(makeDeps(store));
    const e2Before = children(store).find((a) => a.declared?.entry === "e2");
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("e1", { prompt: "changed" }), entry("e2")] }), "utf8");
    const summary = await syncScheduleFiles(makeDeps(store));
    assert.equal(summary.updated, 1);
    assert.equal(children(store).length, 2);
    assert.equal(children(store).find((a) => a.declared?.entry === "e1")?.prompt, "changed");
    assert.equal(children(store).find((a) => a.declared?.entry === "e2")?.nextDueAt, e2Before?.nextDueAt);
  } finally {
    cleanup();
  }
});

test("sync: removing an entry removes its child; deleting the file removes them all but keeps the handle", async () => {
  const { file, cleanup } = scratch();
  try {
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("e1"), entry("e2")] }), "utf8");
    const store = new SyncStore();
    store.addAlarm(handle(file));
    await syncScheduleFiles(makeDeps(store));
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("e1")] }), "utf8");
    let summary = await syncScheduleFiles(makeDeps(store));
    assert.equal(summary.removed, 1);
    assert.deepEqual(children(store).map((a) => a.declared?.entry), ["e1"]);
    rmSync(file);
    summary = await syncScheduleFiles(makeDeps(store));
    assert.equal(summary.removed, 1);
    assert.equal(children(store).length, 0);
    assert.equal(store.getAlarm("alarm_handle")?.type, "file");
  } finally {
    cleanup();
  }
});

test("sync: an unparsable file keeps its children and reports the failure", async () => {
  const { file, cleanup } = scratch();
  try {
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("e1")] }), "utf8");
    const store = new SyncStore();
    store.addAlarm(handle(file));
    await syncScheduleFiles(makeDeps(store));
    writeFileSync(file, "{ half written", "utf8");
    const deps = makeDeps(store);
    const summary = await syncScheduleFiles(deps);
    assert.equal(summary.removed, 0);
    assert.equal(children(store).length, 1);
    assert.equal(deps.logs.some((line) => line.includes("could not be parsed")), true);
  } finally {
    cleanup();
  }
});

test("sync: past `at` entries are skipped, not created", async () => {
  const { file, cleanup } = scratch();
  try {
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("past", { at: PAST_AT }), entry("future")] }), "utf8");
    const store = new SyncStore();
    store.addAlarm(handle(file));
    const summary = await syncScheduleFiles(makeDeps(store));
    assert.equal(summary.skippedPast, 1);
    assert.deepEqual(children(store).map((a) => a.declared?.entry), ["future"]);
  } finally {
    cleanup();
  }
});

test("sync: pausing the handle removes its children; resuming recreates them", async () => {
  const { file, cleanup } = scratch();
  try {
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("e1")] }), "utf8");
    const store = new SyncStore();
    const parent = handle(file);
    store.addAlarm(parent);
    await syncScheduleFiles(makeDeps(store));
    assert.equal(children(store).length, 1);
    store.replaceAlarm({ ...parent, status: "paused" });
    const paused = await syncScheduleFiles(makeDeps(store));
    assert.equal(paused.removed, 1);
    assert.equal(children(store).length, 0);
    store.replaceAlarm(parent);
    const resumed = await syncScheduleFiles(makeDeps(store));
    assert.equal(resumed.created, 1);
    assert.equal(children(store).length, 1);
  } finally {
    cleanup();
  }
});

test("sync: a pre-261009 record for the same (file, entry) is adopted, not dropped", async () => {
  const { file, cleanup } = scratch();
  try {
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("e1")] }), "utf8");
    const store = new SyncStore();
    store.addAlarm(handle(file));
    // The 0.2.x shape: the child id is already the (file, entry) hash, but the
    // record predates both `declared` provenance and `sourceId`.
    const id = declaredAlarmId(file, "e1");
    const legacy: Alarm = {
      ...handle(file),
      id,
      ownerSessionId: "declared-schedule",
      type: "once",
      trigger: { at: FUTURE_AT },
      nextDueAt: FUTURE_AT
    };
    delete (legacy as { declared?: unknown }).declared;
    store.addAlarm(legacy);
    const summary = await syncScheduleFiles(makeDeps(store));
    assert.equal(summary.removed, 0);
    const adopted = store.getAlarm(id);
    assert.equal(adopted?.declared?.sourceId, "alarm_handle");
    assert.equal(adopted?.declared?.entry, "e1");
    // A record with a child-shaped id owned by a REAL session is never
    // clobbered: it can only be a user alarm that happens to collide.
    const foreign: Alarm = { ...legacy, ownerSessionId: "s-real" };
    store.replaceAlarm(foreign);
    const again = await syncScheduleFiles(makeDeps(store));
    assert.equal(again.updated, 0);
    assert.equal(store.getAlarm(id)?.declared, undefined);
  } finally {
    cleanup();
  }
});

test("sync: children of a deleted handle (and pre-261009 records with no sourceId) are orphans", async () => {
  const { file, cleanup } = scratch();
  try {
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("e1")] }), "utf8");
    const store = new SyncStore();
    store.addAlarm(handle(file));
    await syncScheduleFiles(makeDeps(store));
    const child = children(store)[0];
    // pre-261009 shape: declared provenance without a parent handle
    store.addAlarm({ ...child, id: "decl_legacy", status: "scheduled", declared: { file, entry: "legacy", hash: "h" } });
    store.removeAlarm("alarm_handle");
    const summary = await syncScheduleFiles(makeDeps(store));
    assert.equal(summary.removed, 2);
    assert.equal(store.alarms.length, 0);
  } finally {
    cleanup();
  }
});

test("sync: a handle's session target is projected whole for entries that name none", async () => {
  const { file, cleanup } = scratch();
  try {
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("e1")] }), "utf8");
    const store = new SyncStore();
    store.addAlarm(handle(file, { target: { mode: "resume", sourceType: "session", sessionId: "s-dest" } }));
    await syncScheduleFiles(makeDeps(store));
    assert.deepEqual(children(store)[0].target, { mode: "resume", sourceType: "session", sessionId: "s-dest" });
  } finally {
    cleanup();
  }
});

test("sync: a bad entry keeps its existing child instead of churning it away", async () => {
  const { file, cleanup } = scratch();
  try {
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("e1")] }), "utf8");
    const store = new SyncStore();
    store.addAlarm(handle(file));
    await syncScheduleFiles(makeDeps(store));
    const before = children(store)[0];
    // An unresolvable workspace target: preparation fails, the child survives.
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("e1", { target: { mode: "resume", workspace_path: "/gone" } })] }), "utf8");
    const deps = makeDeps(store, {
      resolveWorkspace: async (): Promise<Record<string, unknown> | ToolError> => ({ code: "not_found", message: "no workspace is registered for path /gone" })
    });
    const summary = await syncScheduleFiles(deps);
    assert.equal(summary.errors.length, 1);
    assert.equal(summary.removed, 0);
    assert.equal(summary.updated, 0);
    assert.equal(children(store)[0].nextDueAt, before.nextDueAt);
    assert.equal(children(store)[0].declared?.hash, before.declared?.hash);
  } finally {
    cleanup();
  }
});

test("sync: the handle's nextDueAt tracks the earliest child wake, in-flight included", async () => {
  const { file, cleanup } = scratch();
  try {
    writeFileSync(file, JSON.stringify({
      version: 1,
      entries: [
        { id: "late", at: "2026-09-01T20:00:00+08:00", prompt: "p" },
        { id: "soon", at: "2026-09-01T19:00:00+08:00", prompt: "p" }
      ]
    }), "utf8");
    const store = new SyncStore();
    store.addAlarm(handle(file));
    await syncScheduleFiles(makeDeps(store));
    const soon = children(store).find((a) => a.declared?.entry === "soon");
    assert.equal(store.getAlarm("alarm_handle")?.nextDueAt, soon?.nextDueAt);
    // An in-flight child still owns the earliest wake: excluding it would
    // flip the handle's derived value back and forth every pass.
    store.replaceAlarm({ ...soon!, status: "in-flight" });
    store.replaceAlarm({ ...store.getAlarm("alarm_handle")!, nextDueAt: new Date(NOW).toISOString() });
    await syncScheduleFiles(makeDeps(store));
    assert.equal(store.getAlarm("alarm_handle")?.nextDueAt, soon?.nextDueAt);
  } finally {
    cleanup();
  }
});

test("sync: a handle cancelled while entries are being prepared is never resurrected", async () => {
  const { file, cleanup } = scratch();
  try {
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("e1")] }), "utf8");
    const store = new SyncStore();
    store.addAlarm(handle(file));
    // The await inside entry preparation is the race window: cancel the
    // handle from inside the resolver, exactly like a concurrent tool call.
    const deps = makeDeps(store, {
      resolveWorkspace: async (args: Record<string, unknown>): Promise<Record<string, unknown> | ToolError> => {
        store.removeAlarm("alarm_handle");
        const next = { ...args };
        delete next["target_workspace_path"];
        next["target_workspace_id"] = "ws-resolved";
        return next;
      }
    });
    // The entry names a workspace_path, so preparation really awaits the
    // resolver — that await is the race window under test.
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("e1", { target: { mode: "resume", workspace_path: "/ws" } })] }), "utf8");
    const summary = await syncScheduleFiles(deps);
    assert.equal(summary.created, 0);
    assert.equal(store.alarms.length, 0);
    assert.equal(deps.logs.some((line) => line.includes("disappeared or was paused")), true);
  } finally {
    cleanup();
  }
});

test("startScheduleSync: concurrent passes never duplicate a child", async () => {
  const { file, cleanup } = scratch();
  let sync: ReturnType<typeof startScheduleSync> | undefined;
  try {
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry("e1")] }), "utf8");
    const store = new SyncStore();
    store.addAlarm(handle(file));
    let drives = 0;
    sync = startScheduleSync({ ...makeDeps(store), scheduler: { requestDrive: () => { drives += 1; } } });
    // The immediate boot tick and both requests all run through one chain:
    // an unserialized implementation would add the same child twice.
    await Promise.all([sync.enqueueSync(), sync.enqueueSync()]);
    assert.equal(children(store).length, 1);
    assert.equal(sync.lastSummary()?.handles, 1);
    assert.equal(drives >= 1, true);
  } finally {
    sync?.dispose();
    cleanup();
  }
});
