import { test } from "node:test";
import assert from "node:assert/strict";
import { createFramingMessage, effectiveWakePrompt, renderFraming, type FramingContext } from "../src/framing.js";
import type { Alarm } from "../src/domain.js";

const alarm: Alarm = {
  id: "alarm_abc123",
  ownerSessionId: "s1",
  target: { mode: "resume", sessionId: "s1" },
  type: "once",
  trigger: { at: "2026-09-02T00:00:00.000Z" },
  prompt: "提醒我喝水",
  respectQuietHours: false,
  timeZone: "UTC",
  status: "scheduled",
  nextDueAt: "2026-09-02T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  runCount: 0,
  lastRunAt: null
};

function ctx(overrides: Partial<FramingContext> = {}): FramingContext {
  return {
    alarm,
    budgetUsed: 0,
    budgetMax: 3,
    quiet: false,
    now: new Date("2026-09-01T09:00:00.000Z"),
    userPresence: "cold",
    configQuietHours: { start: "23:00", end: "08:00", timeZone: "Asia/Shanghai" },
    ...overrides
  };
}

test("renderFraming exposes rules, budget, and alarm facts (v2)", () => {
  const text = renderFraming(ctx());
  assert.match(text, /## PROACTIVE WAKE/);
  assert.match(text, /wake_type: once/);
  assert.match(text, /respect_quiet_hours: false/);
  assert.match(text, /no_reply/);
  assert.match(text, /0\/3 visible deliveries/);
  assert.match(text, /alarm_abc123/);
  assert.match(text, /提醒我喝水/);
  assert.match(text, /user_presence: cold/);
  assert.match(text, /outside 23:00\u201308:00/);
});

test("renderFraming names every type and honors respect_quiet_hours", () => {
  const every = renderFraming(ctx({ alarm: { ...alarm, type: "every", trigger: { everySeconds: 3600, anchor: "2026-09-01T00:00:00.000Z" } } }));
  assert.match(every, /wake_type: every/);
  const cron = renderFraming(ctx({ alarm: { ...alarm, type: "cron", trigger: { expr: "0 9 * * 1-5" }, respectQuietHours: true } }));
  assert.match(cron, /wake_type: cron/);
  assert.match(cron, /respect_quiet_hours: true/);
  assert.ok(!every.includes("undefined"));
});

test("renderFraming allows no_reply on every wake", () => {
  const text = renderFraming(ctx());
  assert.match(text, /available on EVERY wake/);
});

test("renderFraming flags quiet hours when inside the window", () => {
  const text = renderFraming(ctx({ quiet: true }));
  assert.match(text, /INSIDE 23:00\u201308:00 Asia\/Shanghai/);
});

test("createFramingMessage builds a notice-form user message", () => {
  const msg = createFramingMessage(ctx());
  assert.equal(msg.role, "user");
  assert.equal(msg.source.kind, "plugin");
  assert.equal(msg.source.plugin, "dsh-proactive");
  assert.equal(msg.source.form, "notice");
  assert.ok((msg.source.summary ?? "").length <= 120);
  const text = msg.content.filter((b) => b.type === "text").map((b) => b["text"]).join("");
  assert.ok(text.length > 0);
  assert.match(text, /## PROACTIVE WAKE/);
});

test("effectiveWakePrompt is the alarm's own prompt — no repo-wide default anymore", () => {
  assert.equal(effectiveWakePrompt(ctx()), "提醒我喝水");
  assert.equal(effectiveWakePrompt(ctx({ alarm: { ...alarm, prompt: "  关注用户的睡眠节奏  " } })), "关注用户的睡眠节奏");
});

test("renderFraming embeds the alarm prompt in the alarm_prompt_json", () => {
  const text = renderFraming(ctx());
  const jsonLine = text.split("\n").find((l) => l.includes("提醒我喝水"));
  assert.ok(jsonLine !== undefined);
  assert.ok(jsonLine.includes('"prompt": "提醒我喝水"'));
});