import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeScheduleFile,
  defaultHandleTargetArgs,
  declaredAlarmId,
  findScheduleHandle,
  flattenTarget,
  hasTargetArgs,
  parseScheduleFile,
  stableStringify,
  viewWithDeclaredEntries
} from "../src/schedule-file.js";
import { buildAlarm, validateCreateArgs } from "../src/alarm-factory.js";
import type { Alarm, ToolError } from "../src/domain.js";

const NOW = Date.parse("2026-09-01T09:00:00.000Z");

function alarm(overrides: Partial<Alarm> = {}): Alarm {
  return {
    id: "alarm_1",
    ownerSessionId: "s1",
    target: { mode: "resume", sourceType: "session", sessionId: "s1" },
    type: "once",
    trigger: { at: "2026-09-02T00:00:00.000Z" },
    prompt: "p",
    respectQuietHours: false,
    timeZone: "UTC",
    status: "scheduled",
    nextDueAt: "2026-09-02T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    runCount: 0,
    lastRunAt: null,
    ...overrides
  };
}

function handle(file: string, overrides: Partial<Alarm> = {}): Alarm {
  return alarm({ id: "alarm_handle", type: "file", trigger: { file }, ...overrides });
}

test("canonicalize: collapses .. and trailing slashes, folds symlinked directories", async () => {
  assert.equal(await canonicalizeScheduleFile("/a/b/../c.json"), "/a/c.json");
  assert.equal(await canonicalizeScheduleFile("/a/b/c.json/"), "/a/b/c.json");
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-canon-"));
  try {
    const real = join(dir, "real");
    mkdirSync(join(real, ".life"), { recursive: true });
    const link = join(dir, "link");
    symlinkSync(real, link);
    // Two spellings of the same physical file must canonicalize identically —
    // otherwise one file could own two handles with two child-id families.
    assert.equal(await canonicalizeScheduleFile(join(link, ".life/w.json")), await canonicalizeScheduleFile(join(real, ".life/w.json")));
    // A directory that does not exist yet still canonicalizes to an absolute path.
    assert.equal(await canonicalizeScheduleFile(join(dir, "later/.life/w.json")), join(realpathSync(dir), "later/.life/w.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findScheduleHandle: matches one canonical file, ignores excludeId and non-file alarms", () => {
  const file = "/ws/.life/w.json";
  const alarms = [handle(file), alarm({ id: "alarm_regular" })];
  assert.equal(findScheduleHandle(alarms, file)?.id, "alarm_handle");
  assert.equal(findScheduleHandle(alarms, file, "alarm_handle"), undefined);
  assert.equal(findScheduleHandle(alarms, "/ws/.life/other.json"), undefined);
});

test("hasTargetArgs: any target_* key counts", () => {
  assert.equal(hasTargetArgs({ prompt: "p" }), false);
  assert.equal(hasTargetArgs({ prompt: "p", target_mode: "resume" }), true);
  assert.equal(hasTargetArgs({ prompt: "p", target_model: "m" }), true);
});

test("factory: schedule_file is the fifth selector and derives the file type", () => {
  const shape = validateCreateArgs({ prompt: "p", schedule_file: "/ws/.life/w.json", target_session_id: "s1" }, "");
  assert.ok(!("code" in shape), JSON.stringify(shape));
  if ("code" in shape) return;
  assert.equal(shape.kind, "file");
  assert.equal(shape.scheduleFile, "/ws/.life/w.json");
  const built = buildAlarm("s1", shape, NOW);
  assert.ok(!("code" in built));
  if ("code" in built) return;
  assert.equal(built.alarm.type, "file");
  assert.deepEqual(built.alarm.trigger, { file: "/ws/.life/w.json" });
  assert.equal(built.alarm.nextDueAt, new Date(NOW).toISOString());
});

test("factory: file kind rejects globs, relative paths, empties, and a second selector", () => {
  const cases: Array<Record<string, unknown>> = [
    { prompt: "p", schedule_file: "/ws/*/w.json", target_session_id: "s1" },
    { prompt: "p", schedule_file: "ws/.life/w.json", target_session_id: "s1" },
    { prompt: "p", schedule_file: "", target_session_id: "s1" },
    { prompt: "p", schedule_file: "/ws/.life/w.json", cron: "0 5 * * *", target_session_id: "s1" }
  ];
  for (const args of cases) {
    const shape = validateCreateArgs(args, "");
    assert.equal((shape as ToolError).code, "invalid_trigger", JSON.stringify(args));
  }
});

test("factory: a handle keeps jitter as the children's default", () => {
  const shape = validateCreateArgs({ prompt: "p", schedule_file: "/ws/.life/w.json", jitter_seconds: 120, target_session_id: "s1" }, "");
  assert.ok(!("code" in shape));
  if ("code" in shape) return;
  const built = buildAlarm("s1", shape, NOW);
  assert.ok(!("code" in built));
  if ("code" in built) return;
  assert.deepEqual(built.alarm.trigger, { file: "/ws/.life/w.json", jitterSeconds: 120 });
});

test("parse: entry target wins WHOLE over the file-level target (no key merging)", () => {
  const text = JSON.stringify({
    version: 1,
    target: { mode: "resume", workspace_id: "ws-file" },
    entries: [{ id: "e1", at: "2026-09-02T00:00:00Z", prompt: "p", target: { session_id: "s-entry" } }]
  });
  const parsed = parseScheduleFile("/ws/.life/w.json", text);
  assert.equal(parsed.fatal, false);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.entries[0].target, { target_session_id: "s-entry" });
});

test("parse: entries without their own target inherit the file-level one, else none", () => {
  const withFileTarget = parseScheduleFile("/f.json", JSON.stringify({
    version: 1,
    target: { mode: "resume", workspace_id: "ws-file" },
    entries: [{ id: "e1", every_seconds: 3600, prompt: "p" }]
  }));
  assert.deepEqual(withFileTarget.entries[0].target, { target_mode: "resume", target_workspace_id: "ws-file" });
  const bare = parseScheduleFile("/f.json", JSON.stringify({ version: 1, entries: [{ id: "e1", every_seconds: 3600, prompt: "p" }] }));
  assert.equal(bare.entries[0].target, undefined);
  const emptyObject = parseScheduleFile("/f.json", JSON.stringify({ version: 1, entries: [{ id: "e1", every_seconds: 3600, prompt: "p", target: {} }] }));
  assert.equal(emptyObject.entries[0].target, undefined);
});

test("parse: scalar layering is entry over file level, and reports bad entries without dying", () => {
  const parsed = parseScheduleFile("/f.json", JSON.stringify({
    version: 1,
    respect_quiet_hours: true,
    jitter_seconds: 60,
    entries: [
      { id: "e1", every_seconds: 3600, prompt: "p", jitter_seconds: 5 },
      { id: "e1", every_seconds: 3600, prompt: "dup" },
      { id: "bad id", every_seconds: 3600, prompt: "p" },
      { id: "e2", every_seconds: 3600, prompt: "p", nope: 1 }
    ]
  }));
  assert.equal(parsed.fatal, false);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].args["respect_quiet_hours"], true);
  assert.equal(parsed.entries[0].args["jitter_seconds"], 5);
  assert.equal(parsed.errors.length, 3);
});

test("parse: broken documents are fatal so their alarms are kept", () => {
  assert.equal(parseScheduleFile("/f.json", "{nope").fatal, true);
  assert.equal(parseScheduleFile("/f.json", JSON.stringify({ version: 2, entries: [] })).fatal, true);
  assert.equal(parseScheduleFile("/f.json", JSON.stringify({ version: 1 })).fatal, true);
  assert.equal(parseScheduleFile("/f.json", JSON.stringify({ version: 1, entries: [], extra: 1 })).fatal, false);
});

test("defaultHandleTargetArgs: only the file's grandparent workspace is accepted", async () => {
  const calls: string[] = [];
  const resolver = async (args: Record<string, unknown>): Promise<Record<string, unknown> | ToolError> => {
    calls.push(String(args["target_workspace_path"]));
    if (args["target_workspace_path"] === "/ws") {
      const next = { ...args };
      delete next["target_workspace_path"];
      next["target_workspace_id"] = "ws-id";
      return next;
    }
    return { code: "not_found", message: "no workspace is registered for path " + String(args["target_workspace_path"]) };
  };
  const hit = await defaultHandleTargetArgs("/ws/.life/w.json", resolver);
  assert.deepEqual(hit, { target_mode: "resume", target_source: "workspace", target_workspace_id: "ws-id" });
  assert.deepEqual(calls, ["/ws"]);
  // A file nested deeper (or shallower) than one directory must NOT walk up
  // to the nearest registered ancestor: /root is itself a workspace on this
  // host, and a silent match would route every wake into a wrong session.
  const miss = await defaultHandleTargetArgs("/ws/nested/deep/w.json", resolver);
  assert.equal((miss as ToolError).code, "not_found");
  assert.equal((miss as { message: string }).message.includes("target_workspace_path"), true);
  const noRegistry = await defaultHandleTargetArgs("/ws/.life/w.json", undefined);
  assert.equal((noRegistry as ToolError).code, "not_found");
});

test("declaredAlarmId: stable per (file, entry) and independent of the handle", () => {
  assert.equal(declaredAlarmId("/ws/.life/w.json", "e1"), declaredAlarmId("/ws/.life/w.json", "e1"));
  assert.notEqual(declaredAlarmId("/ws/.life/w.json", "e1"), declaredAlarmId("/ws/.life/w.json", "e2"));
  assert.equal(declaredAlarmId("/ws/.life/w.json", "e1").startsWith("decl_"), true);
});

test("flattenTarget/stableStringify: canonical shapes for hashing", () => {
  assert.deepEqual(flattenTarget({ mode: "new", preset_id: "p1" }, "t"), { target_mode: "new", target_preset_id: "p1" });
  assert.equal(typeof flattenTarget({ mode: "nope" }, "t"), "string");
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
});

test("viewWithDeclaredEntries: counts children for handles only", () => {
  const parent = handle("/ws/.life/w.json");
  const child = alarm({ id: "decl_1", declared: { file: "/ws/.life/w.json", entry: "e1", hash: "h", sourceId: parent.id } });
  const views = viewWithDeclaredEntries([parent, child], parent, NOW);
  assert.equal(views.declaredEntries, 1);
  assert.equal(views.scheduleFile, "/ws/.life/w.json");
  assert.equal(views.state, "scheduled");
  const plain = viewWithDeclaredEntries([parent, child], alarm({ id: "alarm_regular" }), NOW);
  assert.equal(plain.declaredEntries, undefined);
});

test("client form guard: only absolute, glob-free schedule paths submit", async () => {
  const { isScheduleFilePath } = await import("../src/client/sections.js");
  assert.equal(isScheduleFilePath("/ws/.life/w.json"), true);
  assert.equal(isScheduleFilePath("  /ws/w.json  "), true);
  assert.equal(isScheduleFilePath("ws/w.json"), false);
  assert.equal(isScheduleFilePath("/ws/*/w.json"), false);
  assert.equal(isScheduleFilePath("/ws/w?.json"), false);
  assert.equal(isScheduleFilePath(undefined), false);
});
