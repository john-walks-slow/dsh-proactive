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
  jitterInterval,
  nextEveryOccurrence,
  nextJitteredOccurrence,
  requireFuture,
  resolveAtInput,
  toAlarmView,
  validatePrompt,
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

test("jitterInterval scales within (1 ± jitter) and floors at MIN_EVERY_SECONDS", () => {
  // random() = 1 -> scale 1 + jitter; 0 -> scale 1 - jitter.
  assert.equal(jitterInterval(3600, 0.1, () => 1), Math.round(3600 * 1.1));
  assert.equal(jitterInterval(3600, 0.1, () => 0), Math.round(3600 * 0.9));
  assert.equal(jitterInterval(3600, 0, () => 1), 3600); // jitter 0 -> exact
  // Heavy jitter cannot collapse below the floor.
  assert.equal(jitterInterval(300, 1, () => 0), 300); // max(300, round(300*0)) = 300
  // Out-of-range jitter is clamped to [0,1].
  assert.equal(jitterInterval(3600, 2, () => 1), Math.round(3600 * 2));
  assert.equal(jitterInterval(3600, -1, () => 0), 3600);
});

test("nextJitteredOccurrence stays strictly future and walks around now", () => {
  const anchor = Date.parse("2026-09-01T00:00:00.000Z");
  // jitter 0 degenerates to the exact grid.
  assert.equal(nextJitteredOccurrence(anchor, 300, anchor + 1, 0), nextEveryOccurrence(anchor, 300, anchor + 1));
  // The walk is based on now, not the anchor phase; always strictly in the future.
  const plus = nextJitteredOccurrence(anchor, 300, anchor + 10_000, 0.1, () => 1);
  assert.ok(plus > anchor + 10_000);
  const minus = nextJitteredOccurrence(anchor, 300, anchor + 10_000, 0.1, () => 0);
  assert.ok(minus > anchor + 10_000);
  // Validation still applies: sub-floor every_seconds rejects.
  assert.throws(() => nextJitteredOccurrence(anchor, 299, anchor + 1, 0.1), errCode("frequency_too_high"));
});

test("requireFuture rejects the past", () => {
  const now = Date.parse("2026-09-01T00:00:00.000Z");
  requireFuture(now + 1, now);
  assert.throws(() => requireFuture(now, now), errCode("not_future"));
});

test("toAlarmView marks overdue", () => {
  const alarm: Alarm = {
    id: "a1",
    sessionId: "s1",
    mode: "one-shot",
    trigger: { at: "2026-09-01T00:00:00.000Z" },
    prompt: "p",
    wakeReason: "alarm",
    deliveryHint: { chat: true, push: true, wechat: true },
    timeZone: "UTC",
    status: "scheduled",
    nextDueAt: "2026-08-31T00:00:00.000Z",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    runCount: 0,
    lastRunAt: null
  };
  const view = toAlarmView(alarm, Date.parse("2026-09-01T00:00:00.000Z"));
  assert.equal(view.state, "overdue");
  assert.equal(view.deliveryMode, "host");
});

test("toAlarmView surfaces jitter only for jittered repeats", () => {
  const base: Alarm = {
    id: "a1",
    sessionId: "s1",
    mode: "repeat",
    trigger: { everySeconds: 3600, anchor: "2026-09-01T00:00:00.000Z" },
    prompt: "p",
    wakeReason: "heartbeat",
    deliveryHint: { chat: true, push: true, wechat: true },
    timeZone: "UTC",
    status: "scheduled",
    nextDueAt: "2026-09-01T01:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    runCount: 0,
    lastRunAt: null
  };
  const nowMs = Date.parse("2026-08-31T00:00:00.000Z");
  assert.equal(toAlarmView(base, nowMs).jitter, undefined);
  const jittered: Alarm = { ...base, trigger: { everySeconds: 3600, anchor: "2026-09-01T00:00:00.000Z", jitter: 0.2 } };
  assert.equal(toAlarmView(jittered, nowMs).jitter, 0.2);
  const zeroJitter: Alarm = { ...base, trigger: { everySeconds: 3600, anchor: "2026-09-01T00:00:00.000Z", jitter: 0 } };
  assert.equal(toAlarmView(zeroJitter, nowMs).jitter, undefined);
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
