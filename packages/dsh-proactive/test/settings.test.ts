import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSettingsPatch } from "../src/settings.js";
import { MIN_EVERY_SECONDS, MAX_PROMPT_LENGTH } from "../src/domain.js";

const code = (v: unknown): string | undefined => (v as { code?: string })["code"];

test("validateSettingsPatch rejects empty and unknown keys", () => {
  assert.equal(code(validateSettingsPatch({})), "invalid_trigger");
  assert.equal(code(validateSettingsPatch({ nope: 1 })), "invalid_trigger");
});

test("validateSettingsPatch returns only the supplied keys (partial)", () => {
  const out = validateSettingsPatch({ heartbeat_every_seconds: 1800 });
  assert.ok(!("code" in out));
  assert.deepEqual(Object.keys(out.patch), ["heartbeatEverySeconds"]);
  assert.equal(out.patch.heartbeatEverySeconds, 1800);
});

test("validateSettingsPatch accepts and bounds heartbeat_jitter", () => {
  const ok = validateSettingsPatch({ heartbeat_jitter: 0.25 });
  assert.ok(!("code" in ok));
  assert.deepEqual(ok.patch, { heartbeatJitter: 0.25 });
  assert.equal(code(validateSettingsPatch({ heartbeat_jitter: -0.01 })), "invalid_trigger");
  assert.equal(code(validateSettingsPatch({ heartbeat_jitter: 1.01 })), "invalid_trigger");
  assert.equal(code(validateSettingsPatch({ heartbeat_jitter: "0.5" })), "invalid_trigger");
  assert.equal(code(validateSettingsPatch({ heartbeat_jitter: Number.NaN })), "invalid_trigger");
});

test("validateSettingsPatch normalizes quiet_hours and heartbeat_prompt", () => {
  const out = validateSettingsPatch({
    quiet_hours: { start: "22:00", end: "07:00", time_zone: "Asia/Shanghai" },
    heartbeat_prompt: "  新心跳文案  "
  });
  assert.ok(!("code" in out));
  assert.deepEqual(out.patch.quietHours, { start: "22:00", end: "07:00", timeZone: "Asia/Shanghai" });
  assert.equal(out.patch.heartbeatPrompt, "新心跳文案");
});

test("validateSettingsPatch rejects bad values with closed codes", () => {
  assert.equal(code(validateSettingsPatch({ enabled: "yes" })), "invalid_trigger");
  assert.equal(code(validateSettingsPatch({ max_deliveries_per_day: -1 })), "invalid_trigger");
  assert.equal(code(validateSettingsPatch({ quiet_hours: { start: "25:00", end: "07:00", time_zone: "UTC" } })), "invalid_trigger");
  assert.equal(code(validateSettingsPatch({ quiet_hours: { start: "22:00", end: "07:00", time_zone: "Not/AZone" } })), "invalid_time_zone");
  assert.equal(code(validateSettingsPatch({ heartbeat_prompt: "   " })), "invalid_prompt");
  assert.equal(code(validateSettingsPatch({ heartbeat_prompt: "x".repeat(MAX_PROMPT_LENGTH + 1) })), "invalid_prompt");
  assert.equal(code(validateSettingsPatch({ heartbeat_every_seconds: MIN_EVERY_SECONDS - 1 })), "invalid_trigger");
  assert.equal(code(validateSettingsPatch({ boot_overdue_policy: "explode" })), "invalid_trigger");
});