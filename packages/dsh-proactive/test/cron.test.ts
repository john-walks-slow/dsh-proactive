/**
 * Cron engine tests: five-field numeric parsing with closed error codes, plus
 * DST-correct occurrence evaluation (gap skipping, overlap picking the earlier
 * instant, zone-independent wall-clock targeting, Vixie dom/dow OR).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, nextCronOccurrence } from "../src/cron.js";

const code = (e: unknown) => (e as { code?: string }).code;
const Z = (s: string) => Date.parse(s);

test("parseCron accepts five-field numeric expressions and normalizes dow 7->0", () => {
  const p = parseCron("0 9 * * 1-5");
  assert.deepEqual([...p.minute].sort((a, b) => a - b), [0]);
  assert.deepEqual([...p.hour].sort((a, b) => a - b), [9]);
  assert.equal(p.dom.size, 31, "dom * spans the full month");
  assert.ok(p.dom.has(1) && p.dom.has(31) && !p.dom.has(0));
  assert.deepEqual([...p.dow].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  const sun = parseCron("0 0 * * 7");
  assert.ok(sun.dow.has(0) && sun.dow.has(7), "0 and 7 both mean Sunday");
  const stepped = parseCron("*/15 8-18/2 * * *");
  assert.deepEqual([...stepped.minute].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual([...stepped.hour].sort((a, b) => a - b), [8, 10, 12, 14, 16, 18]);
});

test("parseCron rejects malformed expressions with closed codes", () => {
  const bad = [
    "0 9 * *",        // four fields
    "0 9 * * * *",    // six fields
    "60 * * * *",     // minute out of range
    "* 24 * * *",     // hour out of range
    "* * 0 * *",      // dom starts at 1
    "* * 32 * *",     // dom out of range
    "* * * 0 *",      // month starts at 1
    "* * * 13 *",     // month out of range
    "* * * * 8",      // dow out of range
    "9-2 * * * *",    // inverted range
    "* * * * *-",     // dangling range end
    "*/0 * * * *",    // zero step
    "a * * * *",      // non-numeric
    "0, 9 * * *",     // empty list item
    " 0 9 * * *",     // surrounding whitespace
    "",               // empty
    "0 9 * * ?"       // '?' not in the numeric grammar
  ];
  for (const expr of bad) {
    assert.throws(() => parseCron(expr), (e: unknown) => code(e) === "invalid_trigger", "expr: " + JSON.stringify(expr));
  }
});

test("nextCronOccurrence picks the next matching wall minute (UTC)", () => {
  assert.equal(nextCronOccurrence("0 9 * * *", "UTC", Z("2026-09-01T08:00:00.000Z")), Z("2026-09-01T09:00:00.000Z"));
  // strictly after: the current minute is never returned
  assert.equal(nextCronOccurrence("0 9 * * *", "UTC", Z("2026-09-01T09:00:00.000Z")), Z("2026-09-02T09:00:00.000Z"));
  assert.equal(nextCronOccurrence("30 * * * *", "UTC", Z("2026-09-01T09:00:00.000Z")), Z("2026-09-01T09:30:00.000Z"));
  assert.equal(nextCronOccurrence("30 * * * *", "UTC", Z("2026-09-01T09:30:00.000Z")), Z("2026-09-01T10:30:00.000Z"));
  assert.equal(nextCronOccurrence("*/5 * * * *", "UTC", Z("2026-09-01T09:01:00.000Z")), Z("2026-09-01T09:05:00.000Z"));
});

test("nextCronOccurrence honors weekday, month, and dom/dow OR semantics", () => {
  // 2026-09-05 is a Saturday: the next Mon-Fri 09:00 is Monday 2026-09-07.
  assert.equal(nextCronOccurrence("0 9 * * 1-5", "UTC", Z("2026-09-05T00:00:00.000Z")), Z("2026-09-07T09:00:00.000Z"));
  // dow 7 == Sunday: from Tuesday 09-01 the next Sunday is 09-06.
  assert.equal(nextCronOccurrence("0 0 * * 7", "UTC", Z("2026-09-01T00:00:00.000Z")), Z("2026-09-06T00:00:00.000Z"));
  // Vixie OR: '13th OR Friday'. From 09-14 (the 13th was a Sunday) the next
  // Friday is 09-18, earlier than the next 13th (10-13).
  assert.equal(nextCronOccurrence("0 0 13 * 5", "UTC", Z("2026-09-14T00:00:00.000Z")), Z("2026-09-18T00:00:00.000Z"));
  // month field: Jan 1 next year.
  assert.equal(nextCronOccurrence("0 0 1 1 *", "UTC", Z("2026-09-01T00:00:00.000Z")), Z("2027-01-01T00:00:00.000Z"));
});

test("nextCronOccurrence targets local wall clock in the alarm's zone", () => {
  // 09:00 Asia/Shanghai == 01:00 UTC.
  assert.equal(nextCronOccurrence("0 9 * * *", "Asia/Shanghai", Z("2026-09-01T00:00:00.000Z")), Z("2026-09-01T01:00:00.000Z"));
  assert.equal(nextCronOccurrence("0 9 * * *", "Asia/Shanghai", Z("2026-09-01T01:00:00.000Z")), Z("2026-09-02T01:00:00.000Z"));
});

test("nextCronOccurrence skips nonexistent wall times across DST spring-forward", () => {
  // 2026-03-08 02:30 America/New_York does not exist; the next 02:30 is 03-09 in EDT (UTC-4).
  assert.equal(nextCronOccurrence("30 2 * * *", "America/New_York", Z("2026-03-07T12:00:00.000Z")), Z("2026-03-09T06:30:00.000Z"));
});

test("nextCronOccurrence picks the earlier overlap instant across DST fall-back", () => {
  // 2026-11-01 01:30 America/New_York happens twice; the earlier (EDT, -4) wins.
  assert.equal(nextCronOccurrence("30 1 * * *", "America/New_York", Z("2026-10-31T12:00:00.000Z")), Z("2026-11-01T05:30:00.000Z"));
  // One occurrence per wall minute: the repeated 01:30 (EST) is not emitted
  // again on the same day — the next one is the following day 01:30 EST.
  assert.equal(nextCronOccurrence("30 1 * * *", "America/New_York", Z("2026-11-01T05:30:00.000Z")), Z("2026-11-02T06:30:00.000Z"));
});

test("impossible dates exhaust the search window instead of looping forever", () => {
  // February 30 never exists: the 8-year crawl must terminate with a closed error.
  assert.throws(() => nextCronOccurrence("0 0 30 2 *", "UTC", 0), (e: unknown) => code(e) === "invalid_trigger");
});

test("nextCronOccurrence rejects unparsable expressions and unknown zones", () => {
  assert.throws(() => nextCronOccurrence("nope", "UTC", 0), (e: unknown) => code(e) === "invalid_trigger");
  assert.throws(() => nextCronOccurrence("0 9 * * *", "Not/AZone", 0), (e: unknown) => code(e) === "invalid_time_zone");
});