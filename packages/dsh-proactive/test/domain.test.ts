import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeTimeZone,
  ProactiveInputError,
  decodeInstant,
  instantEpoch,
  inputError,
  internalError,
  isToolError,
  jitterDelay,
  validateJitterSeconds,
  nextEveryOccurrence,
  nextJitteredOccurrence,
  nextDriftingOccurrence,
  requireFuture,
  resolveAtInput,
  toAlarmView,
  validatePrompt,
  MAX_JITTER_SECONDS,
  type Alarm
} from "../src/domain.js";

/** Assertion predicate helper: check the error code field. */
function errCode(code: string) {
  return (e: unknown) => (e as { code?: string }).code === code;
}

test("validatePrompt trims and bounds", () => {
  assert.equal(validatePrompt("  请跟进  "), "请跟进");
  assert.throws(() => validatePrompt("   "), errCode("invalid_prompt"));
  assert.throws(() => validatePrompt(42), errCode("invalid_prompt"));
  assert.throws(() => validatePrompt("x".repeat(4001)), errCode("invalid_prompt"));
  assert.equal(validatePrompt("x".repeat(4000), 4000).length, 4000);
});

test("canonicalizeTimeZone accepts IANA and UTC", () => {
  assert.equal(canonicalizeTimeZone("Asia/Shanghai"), "Asia/Shanghai");
  assert.equal(canonicalizeTimeZone("UTC"), "UTC");
  assert.throws(() => canonicalizeTimeZone("Shanghai"), errCode("invalid_time_zone"));
  assert.throws(() => canonicalizeTimeZone(""), errCode("invalid_time_zone"));
  assert.throws(() => canonicalizeTimeZone("Not/AZone"), errCode("invalid_time_zone"));
});

test("decodeInstant rejects non-canonical instants", () => {
  assert.equal(decodeInstant("2026-09-01T09:30:00.000Z"), "2026-09-01T09:30:00.000Z");
  assert.throws(() => decodeInstant("2026-09-01T09:30:00Z"), errCode("invalid_trigger"));
  assert.throws(() => decodeInstant("2026-13-01T09:30:00.000Z"), errCode("invalid_trigger"));
});

test("resolveAtInput parses Z and numeric-offset strings", () => {
  const z = resolveAtInput("2026-09-01T09:30:00.000Z");
  assert.equal(z.epoch, Date.parse("2026-09-01T09:30:00.000Z"));
  assert.equal(z.timeZone, "UTC");
  const off = resolveAtInput("2026-09-01T09:30:00+08:00");
  assert.equal(off.epoch, Date.parse("2026-09-01T01:30:00.000Z"));
});

test("resolveAtInput rejects zone-less strings and bad calendars", () => {
  assert.throws(() => resolveAtInput("2026-09-01T09:30:00"), errCode("invalid_trigger"));
  assert.throws(() => resolveAtInput("2026-09-01T09:30:00+24:00"), errCode("invalid_trigger"));
  assert.throws(() => resolveAtInput("2026-02-31T09:30:00+08:00"), errCode("invalid_trigger"));
});

test("resolveAtInput resolves local wall-clock in a zone", () => {
  const sh = resolveAtInput({ date: "2026-09-01", time: "09:30:00", time_zone: "Asia/Shanghai" });
  assert.equal(sh.epoch, Date.parse("2026-09-01T01:30:00.000Z"));
  const ny = resolveAtInput({ date: "2026-01-15", time: "12:00:00", time_zone: "America/New_York" });
  assert.equal(ny.epoch, Date.parse("2026-01-15T17:00:00.000Z"));
});

test("resolveAtInput rejects DST gaps and picks the earlier overlap instant", () => {
  // 2026-03-08 02:30 America/New_York does not exist (spring forward).
  assert.throws(
    () => resolveAtInput({ date: "2026-03-08", time: "02:30:00", time_zone: "America/New_York" }),
    errCode("invalid_time_zone")
  );
  // 2026-11-01 01:30 exists twice; the earlier (EDT, -4) instant wins.
  const overlap = resolveAtInput({ date: "2026-11-01", time: "01:30:00", time_zone: "America/New_York" });
  assert.equal(overlap.epoch, Date.parse("2026-11-01T05:30:00.000Z"));
});

test("nextEveryOccurrence aligns to the anchor and enforces the floor", () => {
  const anchor = Date.parse("2026-09-01T00:00:00.000Z");
  assert.equal(nextEveryOccurrence(anchor, 300, anchor), anchor);
  assert.equal(nextEveryOccurrence(anchor, 300, anchor + 1), anchor + 300_000);
  assert.equal(nextEveryOccurrence(anchor, 300, anchor + 299_999), anchor + 300_000);
  assert.equal(nextEveryOccurrence(anchor, 300, anchor + 300_000), anchor + 600_000);
  assert.throws(() => nextEveryOccurrence(anchor, 299, anchor), errCode("frequency_too_high"));
  assert.throws(() => nextEveryOccurrence(anchor, 1.5, anchor), errCode("frequency_too_high"));
});

test("validateJitterSeconds bounds the unified knob", () => {
  assert.equal(validateJitterSeconds(0), 0);
  assert.equal(validateJitterSeconds(600), 600);
  assert.equal(validateJitterSeconds(MAX_JITTER_SECONDS), MAX_JITTER_SECONDS);
  assert.throws(() => validateJitterSeconds(-1), errCode("invalid_trigger"));
  assert.throws(() => validateJitterSeconds(MAX_JITTER_SECONDS + 1), errCode("invalid_trigger"));
  assert.throws(() => validateJitterSeconds(1.5), errCode("invalid_trigger"));
  assert.throws(() => validateJitterSeconds("60"), errCode("invalid_trigger"));
});

test("jitterDelay is a uniform delay in milliseconds, 0 for absent/zero", () => {
  assert.equal(jitterDelay(undefined), 0);
  assert.equal(jitterDelay(0), 0);
  // random = 1 -> 599999ms capped below jitter_seconds*1000? No: floor(1*600*1000)=600000 would equal jitter*1000; uniform(0,1) excludes 1, so the delay is in [0, j*1000).
  assert.equal(jitterDelay(600, () => 0), 0);
  assert.equal(jitterDelay(600, () => 0.5), 300_000);
  assert.equal(jitterDelay(600, () => 1), 600_000);
  const d = jitterDelay(10, () => 0.25);
  assert.ok(d >= 0 && d < 10_000);
});

test("nextJitteredOccurrence stays strictly future and adds the delay on top of the grid", () => {
  const anchor = Date.parse("2026-09-01T00:00:00.000Z");
  // jitter 0 degenerates to the exact grid.
  assert.equal(nextJitteredOccurrence(anchor, 300, anchor + 1, 0), nextEveryOccurrence(anchor, 300, anchor + 1));
  // The grid step is computed from now (anchor-aligned), then the delay lands on top.
  const planned = nextEveryOccurrence(anchor, 300, anchor + 10_000);
  assert.equal(nextJitteredOccurrence(anchor, 300, anchor + 10_000, 600, () => 0.5), planned + 300_000);
  assert.equal(nextJitteredOccurrence(anchor, 300, anchor + 10_000, 600, () => 0), planned);
  // Validation still applies: sub-floor every_seconds rejects.
  assert.throws(() => nextJitteredOccurrence(anchor, 299, anchor + 1, 600), errCode("frequency_too_high"));
});

test("nextDriftingOccurrence calculates next run from wake instant and drifts", () => {
  const wake = Date.parse("2026-09-01T09:15:20.000Z");
  const now = wake + 5000; // wake turn completed in 5 seconds
  // exact drift: wake + 3600s
  assert.equal(nextDriftingOccurrence(wake, 3600, now, undefined), wake + 3600_000);
  // with jitter: wake + 3600s + delay
  assert.equal(nextDriftingOccurrence(wake, 3600, now, 600, () => 0.5), wake + 3600_000 + 300_000);
  // sub-floor rejects
  assert.throws(() => nextDriftingOccurrence(wake, 299, now, 0), errCode("frequency_too_high"));

  // Extreme delay: if prolonged execution or system sleep caused wake + interval to be in the past
  const pastWake = Date.parse("2026-09-01T00:00:00.000Z");
  const farFutureNow = pastWake + 7200_000; // 2 hours later
  // Should re-anchor strictly in the future from now
  const next = nextDriftingOccurrence(pastWake, 3600, farFutureNow, 120, () => 0.5);
  assert.equal(next, farFutureNow + 3600_000 + 60_000);
});

test("requireFuture rejects the past", () => {
  const now = Date.parse("2026-09-01T00:00:00.000Z");
  requireFuture(now + 1, now);
  assert.throws(() => requireFuture(now, now), errCode("not_future"));
});

function v2Alarm(overrides: Partial<Alarm> = {}): Alarm {
  return {
    id: "a1",
    ownerSessionId: "s1",
    target: { mode: "resume", sessionId: "s1" },
    type: "once",
    trigger: { at: "2026-09-01T00:00:00.000Z" },
    prompt: "p",
    respectQuietHours: false,
    timeZone: "UTC",
    status: "scheduled",
    nextDueAt: "2026-08-31T00:00:00.000Z",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    runCount: 0,
    lastRunAt: null,
    ...overrides
  };
}

test("toAlarmView v2: overdue + owner + target fields", () => {
  const view = toAlarmView(v2Alarm(), Date.parse("2026-09-01T00:00:00.000Z"));
  assert.equal(view.state, "overdue");
  assert.equal(view.deliveryMode, "host");
  assert.equal(view.sessionId, "s1"); // wire keeps owner under the legacy name
  assert.equal(view.type, "once");
  assert.equal(view.targetMode, "resume");
  assert.equal(view.targetSessionId, "s1");
  assert.equal(view.respectQuietHours, false);
  assert.equal(view.at, "2026-09-01T00:00:00.000Z");
  assert.equal(view.everySeconds, undefined);
  assert.equal(view.jitterSeconds, undefined);
});

test("toAlarmView v2: every carries interval + jitter, new targets carry no targetSessionId", () => {
  const every = v2Alarm({
    type: "every",
    trigger: { everySeconds: 3600, anchor: "2026-09-01T00:00:00.000Z", jitterSeconds: 600 },
    respectQuietHours: true
  });
  const nowMs = Date.parse("2026-08-31T00:00:00.000Z");
  const view = toAlarmView(every, nowMs);
  assert.equal(view.everySeconds, 3600);
  assert.equal(view.jitterSeconds, 600);
  assert.equal(view.respectQuietHours, true);
  assert.equal(view.at, undefined);

  const bare: Alarm = { ...every, trigger: { everySeconds: 3600, anchor: "2026-09-01T00:00:00.000Z" } };
  assert.equal(toAlarmView(bare, nowMs).jitterSeconds, undefined);

  // minIdleSeconds surfaces only when > 0 (absent/0 = off, legacy records).
  assert.equal(toAlarmView(v2Alarm(), nowMs).minIdleSeconds, undefined);
  assert.equal(toAlarmView(v2Alarm({ minIdleSeconds: 0 }), nowMs).minIdleSeconds, undefined);
  assert.equal(toAlarmView(v2Alarm({ minIdleSeconds: 600 }), nowMs).minIdleSeconds, 600);

  const forkView = toAlarmView(v2Alarm({ target: { mode: "fork", sessionId: "sParent" } }), nowMs);
  assert.equal(forkView.targetMode, "fork");
  assert.equal(forkView.targetSessionId, "sParent");

  const newView = toAlarmView(v2Alarm({ target: { mode: "new" } }), nowMs);
  assert.equal(newView.targetMode, "new");
  assert.equal(newView.targetSessionId, undefined);
});

test("toAlarmView v2: cron exposes the expression", () => {
  const cron: Alarm = v2Alarm({
    type: "cron",
    trigger: { expr: "0 9 * * 1-5", jitterSeconds: 120 },
    timeZone: "Asia/Shanghai"
  });
  const view = toAlarmView(cron, Date.parse("2026-08-31T00:00:00.000Z"));
  assert.equal(view.cron, "0 9 * * 1-5");
  assert.equal(view.jitterSeconds, 120);
  assert.equal(view.everySeconds, undefined);
  assert.equal(view.at, undefined);
});

test("error helpers stay closed and stable", () => {
  const err = inputError(new Error("boom"));
  assert.equal(err.code, "internal_error");
  const custom = new ProactiveInputError("invalid_prompt", "x");
  assert.deepEqual(inputError(custom), { code: "invalid_prompt", message: "x" });
  assert.equal(internalError().code, "internal_error");
  assert.equal(isToolError({ code: "not_found", message: "m" }), true);
  assert.equal(isToolError({ ok: 1 }), false);
  assert.equal(instantEpoch("2026-09-01T00:00:00.000Z"), Date.parse("2026-09-01T00:00:00.000Z"));
});