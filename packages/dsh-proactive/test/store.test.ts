import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProactiveStore } from "../src/store.js";
import type { Alarm, RunRecord } from "../src/domain.js";

function alarm(id: string, sessionId = "s1", nextDueAt = "2026-09-02T00:00:00.000Z"): Alarm {
  return {
    id,
    sessionId,
    mode: "one-shot",
    trigger: { at: "2026-09-02T00:00:00.000Z" },
    prompt: "跟进一下",
    wakeReason: "check_in",
    deliveryHint: { chat: true, push: true, wechat: true },
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
    assert.equal(loaded.store.getAlarm("a1")?.sessionId, "s1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt alarms.json degrades to empty store flagged corrupt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-corrupt-"));
  try {
    const { writeFileSync } = await import("node:fs");
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
