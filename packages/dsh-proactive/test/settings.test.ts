import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSettingsPatch } from "../src/settings.js";

const code = (v: unknown): string | undefined => (v as { code?: string })["code"];

test("validateSettingsPatch rejects empty and unknown keys", () => {
  assert.equal(code(validateSettingsPatch({})), "invalid_trigger");
  assert.equal(code(validateSettingsPatch({ nope: 1 })), "invalid_trigger");
  // The v1 heartbeat dial is gone entirely.
  assert.equal(code(validateSettingsPatch({ heartbeat_prompt: "x" })), "invalid_trigger");
});

test("validateSettingsPatch returns only the supplied keys (partial)", () => {
  const out = validateSettingsPatch({ max_deliveries_per_day: 5 });
  assert.ok(!("code" in out));
  assert.deepEqual(Object.keys(out.patch), ["maxDeliveriesPerDay"]);
  assert.equal(out.patch.maxDeliveriesPerDay, 5);
});

test("validateSettingsPatch normalizes quiet_hours", () => {
  const out = validateSettingsPatch({
    quiet_hours: { start: "22:00", end: "07:00", time_zone: "Asia/Shanghai" }
  });
  assert.ok(!("code" in out));
  assert.deepEqual(out.patch.quietHours, { start: "22:00", end: "07:00", timeZone: "Asia/Shanghai" });
});

test("validateSettingsPatch rejects bad values with closed codes", () => {
  assert.equal(code(validateSettingsPatch({ enabled: "yes" })), "invalid_trigger");
  assert.equal(code(validateSettingsPatch({ max_deliveries_per_day: -1 })), "invalid_trigger");
  assert.equal(code(validateSettingsPatch({ quiet_hours: { start: "25:00", end: "07:00", time_zone: "UTC" } })), "invalid_trigger");
  assert.equal(code(validateSettingsPatch({ quiet_hours: { start: "22:00", end: "07:00", time_zone: "Not/AZone" } })), "invalid_time_zone");
  assert.equal(code(validateSettingsPatch({ boot_overdue_policy: "explode" })), "invalid_trigger");
});