import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, isInQuietHours, localClockMinutes, parseClockTime, resolveConfig } from "../src/config.js";
import { DEFAULT_WAKE_PROMPT } from "../src/domain.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("invalid quietHours.start/end fall back to defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-cfg-"));
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ quietHours: { start: "9:00", end: "08:00", timeZone: "UTC" } }), "utf8");
    const config = resolveConfig(dir);
    assert.equal(config.quietHours.start, DEFAULT_CONFIG.quietHours.start);
    assert.equal(config.quietHours.end, DEFAULT_CONFIG.quietHours.end);
    // the scheduler hot path must no longer be able to throw on this config
    assert.equal(isInQuietHours(Date.parse("2026-09-01T09:00:00.000Z"), config), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseClockTime validates HH:MM", () => {
  assert.equal(parseClockTime("23:00", "start"), "23:00");
  assert.throws(() => parseClockTime("25:00", "start"));
  assert.throws(() => parseClockTime("9:00", "start"));
});

test("localClockMinutes reports zone wall clock and UTC date", () => {
  const epoch = Date.parse("2026-09-01T16:30:00.000Z");
  const sh = localClockMinutes(epoch, "Asia/Shanghai");
  assert.equal(sh.minutes, 0 * 60 + 30); // 00:30 next day? no: 16:30Z = 00:30+08
  assert.equal(sh.minutes, 30);
  const { minutes, utcDate } = localClockMinutes(epoch, "UTC");
  assert.equal(minutes, 16 * 60 + 30);
  assert.equal(utcDate, "2026-09-01");
});

test("quiet hours wrap midnight in the configured zone", () => {
  const cfg = { quietHours: { start: "23:00", end: "08:00", timeZone: "Asia/Shanghai" } };
  // 2026-09-01T15:00:00Z == 23:00 CST (start inclusive)
  assert.equal(isInQuietHours(Date.parse("2026-09-01T15:00:00.000Z"), cfg), true);
  // 14:59:59Z == 22:59:59 CST
  assert.equal(isInQuietHours(Date.parse("2026-09-01T14:59:59.000Z"), cfg), false);
  // 16:00:00Z == 00:00 CST
  assert.equal(isInQuietHours(Date.parse("2026-09-01T16:00:00.000Z"), cfg), true);
  // 2026-09-01T23:59:59Z == 07:59:59 CST (still quiet, approaching 08:00)
  assert.equal(isInQuietHours(Date.parse("2026-09-01T23:59:59.000Z"), cfg), true);
  // 2026-09-02T00:00:00Z == 08:00 CST (end exclusive)
  assert.equal(isInQuietHours(Date.parse("2026-09-02T00:00:00.000Z"), cfg), false);
});

test("resolveConfig merges file overrides and defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ maxDeliveriesPerDay: 5, quietHours: { start: "22:00", end: "07:00", timeZone: "America/New_York" } }));
  try {
    const cfg = resolveConfig(dir);
    assert.equal(cfg.maxDeliveriesPerDay, 5);
    assert.equal(cfg.quietHours.start, "22:00");
    assert.equal(cfg.quietHours.timeZone, "America/New_York");
    assert.equal(cfg.dataDir, dir);
    assert.equal(cfg.maxWakeupsPerHour, DEFAULT_CONFIG.maxWakeupsPerHour);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveConfig honors env overrides", () => {
  process.env["DSH_PROACTIVE_MAX_DELIVERIES_PER_DAY"] = "7";
  try {
    const cfg = resolveConfig("/tmp/dsh-proactive-envtest");
    assert.equal(cfg.maxDeliveriesPerDay, 7);
  } finally {
    delete process.env["DSH_PROACTIVE_MAX_DELIVERIES_PER_DAY"];
  }
});

test("a leftover v1 heartbeatPrompt in config.json is ignored (dial deleted in v2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-hb-"));
  try {
    const cfg = resolveConfig(dir);
    assert.ok(!("heartbeatPrompt" in cfg), "v2 config has no heartbeatPrompt field");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ heartbeatPrompt: "ping" }));
    const over = resolveConfig(dir);
    assert.ok(!("heartbeatPrompt" in over), "legacy heartbeatPrompt must not resurface");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultPrompt: file value wins (trimmed), blank falls back to the repo default, oversized clamped", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-dp-"));
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ defaultPrompt: "  自定义预设  " }));
    assert.equal(resolveConfig(dir).defaultPrompt, "自定义预设");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ defaultPrompt: "   " }));
    assert.equal(resolveConfig(dir).defaultPrompt, DEFAULT_WAKE_PROMPT);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ maxPromptLength: 100, defaultPrompt: "x".repeat(500) }));
    assert.equal(resolveConfig(dir).defaultPrompt.length, 100);
    writeFileSync(join(dir, "config.json"), JSON.stringify({}));
    assert.equal(resolveConfig(dir).defaultPrompt, DEFAULT_WAKE_PROMPT);
    assert.equal(DEFAULT_CONFIG.defaultPrompt, DEFAULT_WAKE_PROMPT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
