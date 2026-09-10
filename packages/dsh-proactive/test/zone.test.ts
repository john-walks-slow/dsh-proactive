/**
 * Default time-zone resolution tests: explicit time_zone wins, otherwise the
 * session's newest client-reported browser zone, otherwise the host zone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveTimeZone, wireTimeZones, SYSTEM_DEFAULT_TIME_ZONE } from "../src/zone.js";

const userMsg = (zone: string) => ({ type: "user/message", time: 100, data: { source: { kind: "user", rpcId: "r1", clientTimeZone: zone } } });

test("explicit non-empty zone wins over everything", () => {
  assert.equal(effectiveTimeZone("Asia/Shanghai", [userMsg("America/New_York")]), "Asia/Shanghai");
  assert.equal(effectiveTimeZone("UTC", undefined), "UTC");
});

test("omitted zone resolves from the newest user rpc message (newest first)", () => {
  const events = [
    { type: "assistant/message", data: {} },
    userMsg("America/New_York"),
    userMsg("Asia/Tokyo"),
    { type: "user/message", time: 100, data: { source: { kind: "user", rpcId: "r2" } } } // no zone on this one
  ];
  assert.equal(effectiveTimeZone(undefined, events), "Asia/Tokyo");
  // Empty string counts as omitted (the tool schema allows "", the domain treats it as absent).
  assert.equal(effectiveTimeZone("", events), "Asia/Tokyo");
});

test("invalid zones, non-user events, and empty logs all fall back to the host zone", () => {
  assert.equal(effectiveTimeZone(undefined, [userMsg("Not/AZone")]), SYSTEM_DEFAULT_TIME_ZONE);
  assert.equal(effectiveTimeZone(undefined, [{ type: "tool/call", time: 1, data: {} }]), SYSTEM_DEFAULT_TIME_ZONE);
  assert.equal(effectiveTimeZone(undefined, [{ type: "user/message", time: 1, data: { source: { kind: "user", rpcId: "r" } } }]), SYSTEM_DEFAULT_TIME_ZONE);
  assert.equal(effectiveTimeZone(undefined, []), SYSTEM_DEFAULT_TIME_ZONE);
  assert.equal(effectiveTimeZone(undefined, undefined), SYSTEM_DEFAULT_TIME_ZONE);
});

test("wireTimeZones fills empty top-level and at slots from the chain", () => {
  const events = [userMsg("Asia/Tokyo")];
  const filled = wireTimeZones({ prompt: "p", after_seconds: 5 }, events);
  assert.equal(filled["time_zone"], "Asia/Tokyo");
  const atFilled = wireTimeZones({ prompt: "p", at: { date: "2026-09-02", time: "14:00:00", time_zone: "" } }, events);
  assert.deepEqual(atFilled["at"], { date: "2026-09-02", time: "14:00:00", time_zone: "Asia/Tokyo" });
  assert.equal(atFilled["time_zone"], "Asia/Tokyo");
});

test("wireTimeZones never overrides explicit zones", () => {
  const events = [userMsg("Asia/Tokyo")];
  const topExplicit = wireTimeZones({ prompt: "p", after_seconds: 5, time_zone: "UTC" }, events);
  assert.equal(topExplicit["time_zone"], "UTC");
  // A zone-bearing at object IS the explicit intent: no slot gets rewired, so
  // buildAlarm reflects the at zone on the stored alarm.
  const atExplicit = wireTimeZones({ prompt: "p", at: { date: "2026-09-02", time: "14:00:00", time_zone: "Asia/Shanghai" } }, events);
  assert.deepEqual(atExplicit["at"], { date: "2026-09-02", time: "14:00:00", time_zone: "Asia/Shanghai" });
  assert.ok(!("time_zone" in atExplicit), "no top-level zone is synthesized over an explicit at zone");
});