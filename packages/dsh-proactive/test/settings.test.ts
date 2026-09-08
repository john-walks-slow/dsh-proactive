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
test("validateSettingsPatch accepts and trims default_prompt", () => {
  const out = validateSettingsPatch({ default_prompt: "  自定义预设  " });
  assert.ok(!("code" in out));
  assert.equal(out.patch.defaultPrompt, "自定义预设");
});

test("validateSettingsPatch rejects empty and oversized default_prompt with closed codes", () => {
  assert.equal(code(validateSettingsPatch({ default_prompt: "" })), "invalid_trigger");
  assert.equal(code(validateSettingsPatch({ default_prompt: "   " })), "invalid_trigger");
  assert.equal(code(validateSettingsPatch({ default_prompt: 42 })), "invalid_trigger");
  // The cap is the hard ALARM prompt limit: a longer default would pre-fill a
  // prompt the alarm validator itself rejects (create-form dead end).
  const atCap = validateSettingsPatch({ default_prompt: "x".repeat(4000) });
  assert.ok(!("code" in atCap));
  assert.equal(code(validateSettingsPatch({ default_prompt: "x".repeat(4001) })), "invalid_trigger");
  assert.equal(code(validateSettingsPatch({ default_prompt: "x".repeat(20001) })), "invalid_trigger");
});
