import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProactiveScheduler } from "../src/scheduler.js";
import { WakeDriver } from "../src/wake.js";
import type { WorkspaceWakePort } from "../src/workspace.js";
import { ProactiveStore } from "../src/store.js";
import { resolveConfig, type ProactiveConfig, type QuietHours } from "../src/config.js";
import type { Alarm, RunDecision } from "../src/domain.js";

function alarm(id: string, overrides: Partial<Alarm> = {}): Alarm {
  return {
    id,
    ownerSessionId: "s1",
    target: { mode: "resume", sessionId: "s1" },
    type: "once",
    trigger: { at: "2026-09-02T00:00:00.000Z" },
    prompt: "p" + id,
    respectQuietHours: false,
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

/** every-alarm helper: type + trigger in one call. */
function everyAlarm(id: string, everySeconds: number, anchor: string, jitterSeconds?: number, overrides: Partial<Alarm> = {}): Alarm {
  return alarm(id, {
    type: "every",
    trigger: { everySeconds, anchor, ...(jitterSeconds !== undefined ? { jitterSeconds } : {}) },
    ...overrides
  });
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
  outcome: "ok" | "busy" | "failed" | "skipped";
  sessionId?: string;
  skipReason?: string;
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
  // Budget exhausted → a quiet-hours-respecting wake is skipped (no analysis summaries).
  h.store.addAlarm(alarm("k1", { respectQuietHours: true }));
  h.config.maxDeliveriesPerDay = 1;
  await h.store.spendBudget("2026-09-01", 1);
  h.scheduler.start();
  await h.flush(() => h.store.getAlarm("k1")?.runCount === 1);
  const rows = await h.store.listRecentRuns(10);
  assert.equal(rows[0]!.decision, "skipped");
  assert.equal(rows[0]!.reasoningSummary, undefined);
  assert.equal(rows[0]!.replySummary, undefined);
});

test("runWake skip outcome: once completes with the reason in the run record, never retried", async (tctx) => {
  const h = await harness();
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  // The destination resolver found nothing eligible (only archived /
  // subagent / plugin-created sessions): a legitimate no-op, not a failure.
  h.outcomes.push({
    outcome: "skipped",
    skipReason: "workspace ws-a has no eligible session to wake (only archived, subagent-owned, or this plugin's own created sessions); use target_mode new to wake a fresh session"
  });
  h.store.addAlarm(alarm("sk1"));
  h.scheduler.start();
  await h.flush(() => h.store.getAlarm("sk1")?.status === "completed");
  assert.equal(h.fired.length, 1, "a skip is terminal for the occurrence — no retry");
  assert.equal(h.store.getAlarm("sk1")?.runCount, 1);
  const runs = readFileSync(join(h.dir, "runs.jsonl"), "utf8");
  assert.match(runs, /"decision":"skipped"/);
  assert.match(runs, /"note":"workspace ws-a has no eligible session to wake/);
  const rows = await h.store.listRecentRuns(10);
  assert.equal(rows[0]!.budgetDelta, 0);
});

test("runWake skip outcome: every alarm advances to the next grid occurrence", async (tctx) => {
  const h = await harness();
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  h.outcomes.push({ outcome: "skipped", skipReason: "no session is running preset dev" });
  h.store.addAlarm(everyAlarm("sk2", 3600, "2026-09-01T08:00:00.000Z"));
  h.scheduler.start();
  await h.flush(() => h.store.getAlarm("sk2")?.runCount === 1);
  const alarmRow = h.store.getAlarm("sk2")!;
  assert.equal(alarmRow.status, "scheduled");
  assert.equal(alarmRow.nextDueAt, "2026-09-01T10:00:00.000Z"); // next grid point strictly after BASE_NOW
});

test("runWake skip outcome does not burn the hourly cap", async (tctx) => {
  const h = await harness();
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  // With a 1-per-hour cap, a skipped fire must not consume the window: the
  // next alarm's real wake still runs instead of being deflected.
  h.config.maxWakeupsPerHour = 1;
  h.outcomes.push({ outcome: "skipped", skipReason: "nothing eligible" });
  h.outcomes.push({ outcome: "ok", analysis: { decision: "no_reply", budgetDelta: 0 } });
  h.store.addAlarm(alarm("skipA"));
  h.store.addAlarm(alarm("skipB"));
  h.scheduler.start();
  await h.flush(() => h.store.getAlarm("skipB")?.runCount === 1);
  assert.equal(h.fired.length, 2, "the skipped fire leaves the hourly window intact for skipB");
  assert.equal(h.store.getAlarm("skipA")?.status, "completed");
  assert.equal(h.store.getAlarm("skipB")?.status, "completed");
});

test("every advances to the next anchor", async (tctx) => {
  const h = await harness();
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  const anchor = BASE_NOW - 300_000;
  h.store.addAlarm(everyAlarm("r1", 300, new Date(anchor).toISOString(), undefined, { nextDueAt: new Date(BASE_NOW - 1).toISOString() }));
  h.scheduler.start();
  await h.flush(() => h.fired.length >= 1 && h.store.getAlarm("r1")?.runCount === 1);
  assert.equal(h.store.getAlarm("r1")?.status, "scheduled");
  assert.equal(h.store.getAlarm("r1")?.runCount, 1);
  assert.ok(Date.parse(h.store.getAlarm("r1")!.nextDueAt) > BASE_NOW);
});

test("jittered every: pre-drawn delay lands on top of the anchor grid", async (tctx) => {
  // random()=1 -> delay = jitter_seconds*1000 fully applied; random()=0 -> the bare grid.
  const anchor = BASE_NOW - 3600_000;
  {
    const h = await harness({ random: () => 1 });
    tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
    h.store.addAlarm(everyAlarm("j1", 3600, new Date(anchor).toISOString(), 600, { nextDueAt: new Date(BASE_NOW - 1).toISOString() }));
    h.scheduler.start();
    await h.flush(() => h.fired.length >= 1 && h.store.getAlarm("j1")?.runCount === 1);
    // grid = anchor + 2*3600s = now + 3600s; plus the full 600s delay.
    assert.equal(Date.parse(h.store.getAlarm("j1")!.nextDueAt), BASE_NOW + 3600_000 + 600_000);
  }
  {
    const h = await harness({ random: () => 0 });
    tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
    h.store.addAlarm(everyAlarm("j2", 3600, new Date(anchor).toISOString(), 600, { nextDueAt: new Date(BASE_NOW - 1).toISOString() }));
    h.scheduler.start();
    await h.flush(() => h.fired.length >= 1 && h.store.getAlarm("j2")?.runCount === 1);
    assert.equal(Date.parse(h.store.getAlarm("j2")!.nextDueAt), BASE_NOW + 3600_000);
  }
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

test("failed once alarm terminates after maxRetriesPerFire", async (tctx) => {
  const h = await harness({ maxRetriesPerFire: 2 });
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  h.outcomes.push({ outcome: "failed" }, { outcome: "failed" });
  h.store.addAlarm(alarm("f1"));
  h.scheduler.start();
  await h.flush(() => h.fired.length >= 1 && h.store.getAlarm("f1")?.status === "scheduled" && Date.parse(h.store.getAlarm("f1")!.nextDueAt) > BASE_NOW);
  assert.equal(h.fired.length, 1);
  assert.equal(h.store.getAlarm("f1")?.status, "scheduled");
  h.clock.t += 31_000;
  h.scheduler.requestDrive();
  await h.flush(() => h.store.getAlarm("f1")?.status === "failed");
  assert.equal(h.fired.length, 2);
  assert.equal(h.store.getAlarm("f1")?.status, "failed");
});

test("failed repeating alarm advances to next occurrence after maxRetriesPerFire", async (tctx) => {
  const h = await harness({ maxRetriesPerFire: 2 });
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  h.outcomes.push({ outcome: "failed" }, { outcome: "failed" });
  const anchor = BASE_NOW - 7200_000;
  h.store.addAlarm(everyAlarm("fr1", 3600, new Date(anchor).toISOString(), undefined, { nextDueAt: new Date(BASE_NOW - 1).toISOString() }));
  h.scheduler.start();
  await h.flush(() => h.fired.length >= 1 && h.store.getAlarm("fr1")?.status === "scheduled" && Date.parse(h.store.getAlarm("fr1")!.nextDueAt) > BASE_NOW);
  assert.equal(h.fired.length, 1);
  assert.equal(h.store.getAlarm("fr1")?.status, "scheduled");
  h.clock.t += 31_000;
  h.scheduler.requestDrive();
  await h.flush(() => h.fired.length === 2 && h.store.getAlarm("fr1")?.status === "scheduled" && Date.parse(h.store.getAlarm("fr1")!.nextDueAt) === BASE_NOW + 31_000 + 3600_000);
  assert.equal(h.fired.length, 2);
  assert.equal(h.store.getAlarm("fr1")?.status, "scheduled");
  assert.equal(Date.parse(h.store.getAlarm("fr1")!.nextDueAt), BASE_NOW + 31_000 + 3600_000);
});

test("every alarm drifts based on actual wake time with jitter", async (tctx) => {
  // Wake occurs at BASE_NOW + 15 minutes (900s). The next due instant must be
  // computed from that actual wake time, not the original anchor.
  const wakeOffset = 900_000;
  const h = await harness({ random: () => 0.5 });
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  h.clock.t += wakeOffset; // actual wake runs at 09:15:00
  h.outcomes.push({ outcome: "ok", analysis: { decision: "no_reply", budgetDelta: 0 } });
  // every 1 hour (3600s), jitter 300s -> jitter delay = 150s (150_000ms)
  h.store.addAlarm(everyAlarm("drift1", 3600, "2026-09-01T08:00:00.000Z", 300, { nextDueAt: new Date(BASE_NOW + wakeOffset - 1).toISOString() }));
  h.scheduler.start();
  await h.flush(() => h.store.getAlarm("drift1")?.runCount === 1);
  const row = h.store.getAlarm("drift1")!;
  assert.equal(row.status, "scheduled");
  // Next due = (BASE_NOW + 900s) + 3600s + 150s
  const expected = (BASE_NOW + wakeOffset) + 3600_000 + 150_000;
  assert.equal(Date.parse(row.nextDueAt), expected);
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

test("quiet hours defer quiet-respecting alarms; user-requested alarms are exempt", async (tctx) => {
  const h = await harness({ quietHours: { start: "00:00", end: "23:59", timeZone: "UTC" } });
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  h.outcomes.push({ outcome: "ok", analysis: { decision: "no_reply", budgetDelta: 0 } });
  h.store.addAlarm(alarm("q1", { respectQuietHours: true }));
  h.store.addAlarm(alarm("q2", { respectQuietHours: false }));
  h.scheduler.start();
  await h.flush(() => h.fired.length >= 1);
  // quiet-respecting deferred, user-requested fired
  assert.equal(h.fired.length, 1);
  assert.equal(h.fired[0]?.id, "q2");
  assert.ok(Date.parse(h.store.getAlarm("q1")!.nextDueAt) > BASE_NOW);
  assert.equal(h.store.getAlarm("q1")?.runCount, 0); // deferral records no run
});

test("daily budget gate skips quiet-respecting wakes at the cap", async (tctx) => {
  const h = await harness();
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  await h.store.spendBudget("2026-09-01", h.config.maxDeliveriesPerDay);
  h.store.addAlarm(alarm("c1", { respectQuietHours: true }));
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

test("malformed every alarm fails closed without killing the drive loop", async (tctx) => {
  const h = await harness();
  tctx.after(async () => { h.scheduler.stop(); rmSyncSafe(h.dir); });
  // a corrupt every (trigger missing) next to a healthy one-shot
  h.store.addAlarm({ ...alarm("bad1", { type: "every" as const }), trigger: undefined as never });
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

test("driver.fire skipped skipReason threads through the scheduler runWake seam into the run record", async (tctx) => {
  // Guards the index.ts wiring `runWake: (alarm) => driver.fire(alarm)`: the
  // driver's skipped field name must match the scheduler's, or the note
  // silently falls back to the generic "no eligible target session".
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-seam-"));
  const config = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  const port: WorkspaceWakePort = {
    resolveTarget: async () => ({ kind: "none" }),
    attach: async () => { throw new Error("must not be called"); },
    cwdOf: async () => { throw new Error("must not be called"); }
  };
  const driver = new WakeDriver({ agents: { get: () => undefined as never, resume: async () => { throw new Error("unused"); }, create: async () => { throw new Error("unused"); } }, workspaces: port, modelSelection: () => undefined, store, config, log: () => undefined });
  const scheduler = new ProactiveScheduler({
    store, config,
    runWake: async (alarm) => driver.fire(alarm), // mirror index.ts verbatim — no field adaptation
    now: () => BASE_NOW,
    log: () => undefined
  });
  tctx.after(async () => { scheduler.stop(); rmSyncSafe(dir); });
  store.addAlarm(alarm("seam1", { target: { mode: "workspace", workspaceId: "ws-a" } }));
  scheduler.start();
  for (let i = 0; i < 100 && store.getAlarm("seam1")?.status !== "completed"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.getAlarm("seam1")?.status, "completed", "a once skip completes the occurrence");
  const runs = readFileSync(join(dir, "runs.jsonl"), "utf8");
  assert.match(runs, /"decision":"skipped"/);
  assert.match(runs, /"note":"workspace ws-a has no eligible session to wake/);
  assert.ok(!runs.includes("no eligible target session"), "the fallback string must not appear — skipReason threaded verbatim");
});