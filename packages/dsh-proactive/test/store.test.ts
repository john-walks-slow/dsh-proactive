import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProactiveStore } from "../src/store.js";
import type { Alarm, RunRecord } from "../src/domain.js";

function alarm(id: string, ownerSessionId = "s1", nextDueAt = "2026-09-02T00:00:00.000Z"): Alarm {
  return {
    id,
    ownerSessionId,
    target: { mode: "resume", sessionId: ownerSessionId },
    type: "once",
    trigger: { at: "2026-09-02T00:00:00.000Z" },
    prompt: "跟进一下",
    respectQuietHours: true,
    timeZone: "UTC",
    status: "scheduled",
    nextDueAt,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    runCount: 0,
    lastRunAt: null
  };
}

test("store CRUD + round-trip persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-store-"));
  try {
    const store = new ProactiveStore(dir);
    store.addAlarm(alarm("a1"));
    store.addAlarm(alarm("a2"));
    store.addAlarm(alarm("a3"));
    assert.equal(store.listAlarms().length, 3);
    assert.equal(store.getAlarm("a2")?.id, "a2");
    const removed = store.removeAlarm("a2");
    assert.equal(removed?.id, "a2");
    assert.equal(store.listAlarms().length, 2);
    await store.persist();

    const loaded = await ProactiveStore.load(dir);
    assert.equal(loaded.corrupt, false);
    assert.equal(loaded.store.listAlarms().length, 2);
    assert.equal(loaded.store.getAlarm("a1")?.ownerSessionId, "s1");
    assert.equal(loaded.store.getAlarm("a1")?.target.mode, "resume");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v1 alarms.json migrates in memory to v2 (sessionId->owner+target, reasons->respect, jitter->seconds)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-migrate-"));
  try {
    const v1 = {
      version: 1,
      alarms: [
        {
          id: "a1",
          sessionId: "s1",
          mode: "one-shot",
          trigger: { at: "2026-09-02T00:00:00.000Z" },
          prompt: "p",
          wakeReason: "alarm",
          deliveryHint: { chat: true, push: false, wechat: false }, // legacy, must drop
          timeZone: "UTC",
          status: "scheduled",
          nextDueAt: "2026-09-02T00:00:00.000Z",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
          runCount: 0,
          lastRunAt: null
        },
        {
          id: "a2",
          sessionId: "s2",
          mode: "repeat",
          trigger: { everySeconds: 3600, anchor: "2026-09-01T00:00:00.000Z", jitter: 0.5 },
          prompt: "p2",
          wakeReason: "heartbeat",
          timeZone: "Asia/Shanghai",
          status: "scheduled",
          nextDueAt: "2026-09-01T01:00:00.000Z",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
          runCount: 1,
          lastRunAt: "2026-09-01T00:00:00.000Z"
        }
      ]
    };
    writeFileSync(join(dir, "alarms.json"), JSON.stringify(v1), "utf8");
    const loaded = await ProactiveStore.load(dir);
    assert.equal(loaded.corrupt, false);
    const alarms = loaded.store.listAlarms();
    assert.equal(alarms.length, 2);

    const [oneShot, repeat] = alarms;
    assert.equal(oneShot.ownerSessionId, "s1");
    assert.deepEqual(oneShot.target, { mode: "resume", sessionId: "s1" });
    assert.equal(oneShot.type, "once");
    assert.equal(oneShot.respectQuietHours, false); // legacy "alarm" reason
    assert.ok(!("deliveryHint" in oneShot));

    assert.equal(repeat.ownerSessionId, "s2");
    assert.equal(repeat.type, "every");
    assert.equal(repeat.respectQuietHours, true); // legacy "heartbeat" reason
    assert.equal((repeat.trigger as { everySeconds?: number }).everySeconds, 3600);
    assert.equal((repeat.trigger as { jitterSeconds?: number }).jitterSeconds, 1800); // round(0.5 * 3600)

    // First persist rewrites the file as version 2.
    await loaded.store.persist();
    const raw = JSON.parse(readFileSync(join(dir, "alarms.json"), "utf8"));
    assert.equal(raw.version, 2);
    assert.equal(raw.alarms[0].ownerSessionId, "s1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v1 records with unusable triggers drop and flag corrupt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-migrate-bad-"));
  try {
    const v1 = {
      version: 1,
      alarms: [
        { id: "a1", sessionId: "s1", mode: "one-shot", trigger: { at: "2026-09-02T00:00:00.000Z" }, nextDueAt: "2026-09-02T00:00:00.000Z" },
        { id: "a2", sessionId: "s2", mode: "weird", trigger: {}, nextDueAt: "2026-09-02T00:00:00.000Z" }
      ]
    };
    writeFileSync(join(dir, "alarms.json"), JSON.stringify(v1), "utf8");
    const loaded = await ProactiveStore.load(dir);
    assert.equal(loaded.corrupt, true);
    assert.equal(loaded.store.listAlarms().length, 1);
    assert.equal(loaded.store.listAlarms()[0].id, "a1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown version degrades to empty store flagged corrupt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-version-"));
  try {
    writeFileSync(join(dir, "alarms.json"), JSON.stringify({ version: 99, alarms: [] }), "utf8");
    const loaded = await ProactiveStore.load(dir);
    assert.equal(loaded.corrupt, true);
    assert.deepEqual(loaded.store.listAlarms(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt alarms.json degrades to empty store flagged corrupt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-corrupt-"));
  try {
    writeFileSync(join(dir, "alarms.json"), "{ not json", "utf8");
    const loaded = await ProactiveStore.load(dir);
    assert.equal(loaded.corrupt, true);
    assert.deepEqual(loaded.store.listAlarms(), []);
    const store = loaded.store;
    store.addAlarm(alarm("x"));
    await store.persist();
    const again = await ProactiveStore.load(dir);
    assert.equal(again.corrupt, false);
    assert.equal(again.store.listAlarms().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("budget resets on a new UTC day and persists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-budget-"));
  try {
    const store = new ProactiveStore(dir);
    assert.equal(store.budgetFor("2026-09-01"), 0);
    assert.equal(await store.spendBudget("2026-09-01", 1), 1);
    assert.equal(await store.spendBudget("2026-09-01", 2), 3);
    assert.equal(store.budgetFor("2026-09-01"), 3);
    assert.equal(store.budgetFor("2026-09-02"), 0);
    const loaded = await ProactiveStore.load(dir);
    assert.equal(loaded.store.budgetFor("2026-09-01"), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendRun appends one JSON line per record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-runs-"));
  try {
    const store = new ProactiveStore(dir);
    const rec: RunRecord = { id: "r1", alarmId: "a1", sessionId: "s1", firedAt: "2026-09-01T00:00:00.000Z", decision: "no_reply", budgetDelta: 0 };
    await store.appendRun(rec);
    await store.appendRun({ ...rec, id: "r2", decision: "reply", budgetDelta: 1 });
    const file = readFileSync(join(dir, "runs.jsonl"), "utf8");
    const lines = file.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).id, "r1");
    assert.equal(JSON.parse(lines[1]).decision, "reply");
    assert.equal(existsSync(join(dir, "alarms.json")), false); // appendRun should not create it
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});