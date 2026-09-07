import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProactiveScheduler } from "../src/scheduler.js";
import { ProactiveStore } from "../src/store.js";
import { resolveConfig, type ProactiveConfig, type QuietHours } from "../src/config.js";
import type { Alarm, RunDecision } from "../src/domain.js";

function alarm(id: string, overrides: Partial<Alarm> = {}): Alarm {
  return {
    id,
    sessionId: "s1",
    mode: "one-shot",
    trigger: { at: "2026-09-02T00:00:00.000Z" },
    prompt: "p" + id,
    wakeReason: "alarm",
    deliveryHint: { chat: true, push: true, wechat: true },
    timeZone: "UTC",
    status: "scheduled",
    nextDueAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    runCount: 0,
    lastRunAt: null,
    ...overrides
  };
}

const BASE_NOW = Date.parse("2026-09-01T09:00:00.000Z");

/**
 * Persistent store writes are fire-and-forget in these tests; a racing
 * async persist can re-create files inside the dir while rmSync walks it,
 * surfacing as ENOTEMPTY. Retry briefly before giving up. Async so the
 * event loop can drain the pending persist completion between attempts.
 */
async function rmSyncSafe(dir: string, maxAttempts = 20): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      /* busy: an in-flight persist re-created a file; yield and retry */
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

interface Outcome {
  outcome: "ok" | "busy" | "failed";
  analysis?: { decision: RunDecision; budgetDelta: number; note?: string; reasoningSummary?: string; replySummary?: string };
}

interface Harness {
  store: ProactiveStore;
  scheduler: ProactiveScheduler;
  fired: Alarm[];
  outcomes: Outcome[];
  dir: string;
  clock: { t: number };
  config: ProactiveConfig;
  flush(cond?: () => boolean): Promise<void>;
}

async function harness(opts: { quietHours?: QuietHours; maxRetriesPerFire?: number; random?: () => number } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-sched-"));
  const config = resolveConfig(dir);
  config.quietHours = opts.quietHours ?? { start: "23:00", end: "08:00", timeZone: "UTC" };
  if (opts.maxRetriesPerFire !== undefined) config.maxRetriesPerFire = opts.maxRetriesPerFire;
  const store = new ProactiveStore(dir);
  const clock = { t: BASE_NOW };
  const fired: Alarm[] = [];
  const outcomes: Outcome[] = [];
  const scheduler = new ProactiveScheduler({
    store,
    config,
    runWake: async (alarm) => {
      fired.push(alarm);
      const first = outcomes.shift() ?? { outcome: "ok" as const, analysis: { decision: "no_reply" as const, budgetDelta: 0 } };
      return first;
    },
    now: () => clock.t,
    ...(opts.random !== undefined ? { random: opts.random } : {}),
    log: () => undefined
  });
  const flush = async (cond?: () => boolean) => {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (cond === undefined || cond()) return;
    }
  };
  return { store, scheduler, fired, outcomes, dir, clock, config, flush };
}

test("due one-shot fires and completes; run record written", async (tctx) => {
  const h = await harness();
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  h.store.addAlarm(alarm("a1"));
  h.scheduler.start();
  await h.flush(() => h.store.getAlarm("a1")?.status === "completed");
  assert.equal(h.fired.length, 1);
  assert.equal(h.store.getAlarm("a1")?.status, "completed");
  assert.equal(h.store.getAlarm("a1")?.runCount, 1);
  const runs = readFileSync(join(h.dir, "runs.jsonl"), "utf8");
  assert.match(runs, /"decision":"no_reply"/);
});

test("wake summaries round-trip from analysis to runs.jsonl and listRecentRuns", async (tctx) => {
  const h = await harness();
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  h.outcomes.push({
    outcome: "ok",
    analysis: { decision: "no_reply", budgetDelta: 0, reasoningSummary: "该提醒昨天已处理过，静默收尾。", replySummary: "" }
  });
  h.store.addAlarm(alarm("s1"));
  h.scheduler.start();
  await h.flush(() => h.store.getAlarm("s1")?.status === "completed");
  const runs = readFileSync(join(h.dir, "runs.jsonl"), "utf8");
  assert.match(runs, /"reasoningSummary":"该提醒昨天已处理过，静默收尾。"/);
  const rows = await h.store.listRecentRuns(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.reasoningSummary, "该提醒昨天已处理过，静默收尾。");
  assert.equal(rows[0]!.decision, "no_reply");
});

test("skipped runs carry no summary fields", async (tctx) => {
  const h = await harness();
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  // Budget exhausted → non-alarm (heartbeat) wakes are skipped via recordSkip (no analysis summaries).
  h.store.addAlarm(alarm("k1", { wakeReason: "heartbeat" }));
  h.config.maxDeliveriesPerDay = 1;
  await h.store.spendBudget("2026-09-01", 1);
  h.scheduler.start();
  await h.flush(() => h.store.getAlarm("k1")?.runCount === 1);
  const rows = await h.store.listRecentRuns(10);
  assert.equal(rows[0]!.decision, "skipped");
  assert.equal(rows[0]!.reasoningSummary, undefined);
  assert.equal(rows[0]!.replySummary, undefined);
});

test("repeat advances to the next anchor", async (tctx) => {
  const h = await harness();
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  const anchor = BASE_NOW - 300_000;
  h.store.addAlarm(alarm("r1", { mode: "repeat", trigger: { everySeconds: 300, anchor: new Date(anchor).toISOString() }, nextDueAt: new Date(BASE_NOW - 1).toISOString() }));
  h.scheduler.start();
  await h.flush(() => h.fired.length >= 1 && h.store.getAlarm("r1")?.runCount === 1);
  assert.equal(h.store.getAlarm("r1")?.status, "scheduled");
  assert.equal(h.store.getAlarm("r1")?.runCount, 1);
  assert.ok(Date.parse(h.store.getAlarm("r1")!.nextDueAt) > BASE_NOW);
});

test("jittered repeat advances by a randomized interval, never before now", async (tctx) => {
  // random() = 1 -> scale 1 + jitter (longer); random() = 0 -> scale 1 - jitter (shorter).
  const h = await harness({ random: () => 1 });
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  const anchor = BASE_NOW - 3600_000;
  h.store.addAlarm(alarm("j1", { mode: "repeat", trigger: { everySeconds: 3600, anchor: new Date(anchor).toISOString(), jitter: 0.1 }, nextDueAt: new Date(BASE_NOW - 1).toISOString() }));
  h.scheduler.start();
  await h.flush(() => h.fired.length >= 1 && h.store.getAlarm("j1")?.runCount === 1);
  const next = Date.parse(h.store.getAlarm("j1")!.nextDueAt);
  // With random()=1 the interval scales up to 3600*1.1; with the strict-future walk
  // from now it lands inside (3600, 3600*1.1 + a few ms] rather than the exact grid.
  assert.ok(next > BASE_NOW, "next must be strictly after now");
  assert.ok(next <= BASE_NOW + Math.round(3600 * 1.1) * 1000 + 1, "interval must not exceed (1+jitter)*every");
});

test("busy defers and advances after maxRetriesPerFire", async (tctx) => {
  const h = await harness({ maxRetriesPerFire: 2 });
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  h.outcomes.push({ outcome: "busy" }, { outcome: "busy" });
  h.store.addAlarm(alarm("b1"));
  h.scheduler.start();
  await h.flush(() => h.fired.length >= 1 && h.store.getAlarm("b1")?.status === "scheduled" && Date.parse(h.store.getAlarm("b1")!.nextDueAt) > BASE_NOW);
  assert.equal(h.fired.length, 1); // first attempt: busy -> deferred 30s
  assert.equal(h.store.getAlarm("b1")?.status, "scheduled");
  // advance the clock past the retry window: second busy attempt hits maxRetriesPerFire=2
  h.clock.t += 31_000;
  h.scheduler.requestDrive();
  await h.flush(() => h.store.getAlarm("b1")?.status === "completed");
  assert.equal(h.fired.length, 2);
  assert.equal(h.store.getAlarm("b1")?.status, "completed"); // max retries reached -> skip+advance
});

test("visible reply outcome spends budget", async (tctx) => {
  const h = await harness();
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  h.outcomes.push({ outcome: "ok", analysis: { decision: "reply", budgetDelta: 1 } });
  h.store.addAlarm(alarm("v1"));
  h.scheduler.start();
  await h.flush(() => h.store.getAlarm("v1")?.status === "completed");
  assert.equal(h.store.budgetFor("2026-09-01"), 1);
});

test("quiet hours defer non-alarm wakes; user alarms are exempt", async (tctx) => {
  const h = await harness({ quietHours: { start: "00:00", end: "23:59", timeZone: "UTC" } });
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  h.outcomes.push({ outcome: "ok", analysis: { decision: "no_reply", budgetDelta: 0 } });
  h.store.addAlarm(alarm("q1", { wakeReason: "heartbeat" }));
  h.store.addAlarm(alarm("q2", { wakeReason: "alarm" }));
  h.scheduler.start();
  await h.flush(() => h.fired.length >= 1);
  // heartbeat deferred, alarm fired
  assert.equal(h.fired.length, 1);
  assert.equal(h.fired[0]?.id, "q2");
  assert.ok(Date.parse(h.store.getAlarm("q1")!.nextDueAt) > BASE_NOW);
});

test("daily budget gate skips non-alarm wakes at the cap", async (tctx) => {
  const h = await harness();
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  await h.store.spendBudget("2026-09-01", 20);
  h.store.addAlarm(alarm("c1", { wakeReason: "heartbeat" }));
  h.scheduler.start();
  await h.flush(() => h.store.getAlarm("c1")?.runCount === 1);
  assert.equal(h.fired.length, 0);
  assert.equal(h.store.getAlarm("c1")?.status, "completed"); // skip + advance
  const runs = readFileSync(join(h.dir, "runs.jsonl"), "utf8");
  assert.match(runs, /"decision":"skipped"/);
});

test("boot overdue policy notify-only skips instead of firing", async (tctx) => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-sched-"));
  const config = resolveConfig(dir);
  config.bootOverduePolicy = "notify-only";
  const store = new ProactiveStore(dir);
  const clock = { t: BASE_NOW };
  let fired = 0;
  const scheduler = new ProactiveScheduler({
    store,
    config,
    runWake: async () => { fired += 1; return { outcome: "ok" as const, analysis: { decision: "no_reply" as const, budgetDelta: 0 } }; },
    now: () => clock.t,
    log: () => undefined
  });
  tctx.after(async () => { scheduler.stop(); rmSyncSafe(dir); });
  store.addAlarm(alarm("n1"));
  scheduler.start();
  for (let i = 0; i < 50 && store.getAlarm("n1")?.runCount !== 1; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fired, 0);
  assert.equal(store.getAlarm("n1")?.status, "completed");
});

test("arms a real timer and fires a future-due alarm", async (tctx) => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-sched-"));
  const config = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  const t0 = Date.now();
  let fired = 0;
  const scheduler = new ProactiveScheduler({
    store,
    config,
    runWake: async () => { fired += 1; return { outcome: "ok" as const, analysis: { decision: "no_reply" as const, budgetDelta: 0 } }; },
    now: () => BASE_NOW + (Date.now() - t0),
    log: () => undefined
  });
  tctx.after(async () => { scheduler.stop(); rmSyncSafe(dir); });
  store.addAlarm(alarm("t1", { nextDueAt: new Date(BASE_NOW + 150).toISOString() }));
  scheduler.start();
  // real timer fires ~150ms later; wait for the terminal state, not just the fire
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && store.getAlarm("t1")?.status !== "completed") await new Promise((r) => setTimeout(r, 25));
  assert.equal(fired, 1);
  assert.equal(store.getAlarm("t1")?.status, "completed");
});

test("persists in-flight while the wake runs, then completes", async (tctx) => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-sched-"));
  const config = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  const observed: string[] = [];
  const scheduler = new ProactiveScheduler({
    store,
    config,
    runWake: async (a) => {
      // The scheduler must have marked the alarm in-flight before calling us.
      observed.push(store.getAlarm(a.id)?.status ?? "missing");
      return { outcome: "ok" as const, analysis: { decision: "no_reply" as const, budgetDelta: 0 } };
    },
    now: () => BASE_NOW,
    log: () => undefined
  });
  tctx.after(async () => { scheduler.stop(); rmSyncSafe(dir); });
  store.addAlarm(alarm("w1"));
  // snapshot what a crash would leave on disk mid-wake
  const crashView: string[] = [];
  scheduler.start();
  await (async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && store.getAlarm("w1")?.status !== "completed") await new Promise((r) => setTimeout(r, 20));
  })();
  assert.equal(observed[0], "in-flight");
  assert.equal(store.getAlarm("w1")?.status, "completed");
  // a new scheduler booting against the same store recovers an in-flight residue
  store.replaceAlarm({ ...(store.getAlarm("w1") as Alarm), status: "in-flight" });
  const booted = new ProactiveScheduler({
    store,
    config,
    runWake: async () => ({ outcome: "ok" as const, analysis: { decision: "no_reply" as const, budgetDelta: 0 } }),
    now: () => BASE_NOW,
    log: () => undefined
  });
  booted.start();
  await (async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && store.getAlarm("w1")?.status !== "completed") await new Promise((r) => setTimeout(r, 20));
  })();
  assert.notEqual(store.getAlarm("w1")?.status, "in-flight");
  booted.stop();
});

test("malformed repeat alarm fails closed without killing the drive loop", async (tctx) => {
  const h = await harness();
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  // a corrupt repeat (trigger missing) next to a healthy one-shot
  h.store.addAlarm({ ...alarm("bad1", { mode: "repeat" as const }), trigger: undefined as never });
  h.store.addAlarm(alarm("good1"));
  h.scheduler.start();
  await h.flush(() => h.store.getAlarm("good1")?.status === "completed");
  assert.equal(h.store.getAlarm("good1")?.status, "completed"); // healthy alarm still fired
  assert.equal(h.store.getAlarm("bad1")?.status, "failed");     // corrupt alarm failed closed
  assert.equal(h.fired.length, 2);                              // both were attempted, none crashed the loop
  // the chain must still accept later drives (not permanently rejected)
  h.clock.t += 31_000;
  h.scheduler.requestDrive();
  await h.flush(() => h.store.getAlarm("good1")?.status === "completed");
});

test("a throwing runWake is contained and logged without killing later alarms", async (tctx) => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-sched-"));
  const config = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  const scheduler = new ProactiveScheduler({
    store,
    config,
    runWake: async (a) => {
      if (a.id === "badX") throw new Error("boom in the agent world");
      return { outcome: "ok" as const, analysis: { decision: "no_reply" as const, budgetDelta: 0 } };
    },
    now: () => BASE_NOW,
    log: () => undefined
  });
  tctx.after(async () => { scheduler.stop(); rmSyncSafe(dir); });
  store.addAlarm(alarm("badX"));
  store.addAlarm(alarm("okY"));
  scheduler.start();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && store.getAlarm("okY")?.status !== "completed") await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.getAlarm("badX")?.status, "failed"); // contained: recorded + advanced out
  assert.equal(store.getAlarm("okY")?.status, "completed"); // the next alarm still ran
  const runs = readFileSync(join(dir, "runs.jsonl"), "utf8");
  assert.match(runs, /exception in drive/);
  // loop survives: a later drive still processes work
  scheduler.requestDrive();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store.getAlarm("okY")?.status, "completed");
});

test("recovers in-flight alarms on boot as scheduled", async (tctx) => {
  const h = await harness();
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  h.store.addAlarm(alarm("i1", { status: "in-flight" }));
  h.scheduler.start();
  await h.flush(() => h.store.getAlarm("i1")?.status !== "in-flight");
  assert.notEqual(h.store.getAlarm("i1")?.status, "in-flight");
});


