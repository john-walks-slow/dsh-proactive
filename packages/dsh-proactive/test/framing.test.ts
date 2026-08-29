import { test } from "node:test";
import assert from "node:assert/strict";
import { createFramingMessage, renderFraming, type FramingContext } from "../src/framing.js";
import type { Alarm } from "../src/domain.js";

const alarm: Alarm = {
  id: "alarm_abc123",
  sessionId: "s1",
  mode: "one-shot",
  trigger: { at: "2026-09-02T00:00:00.000Z" },
  prompt: "提醒我喝水",
  wakeReason: "alarm",
  deliveryHint: { chat: true, push: true, wechat: true },
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

test("renderFraming exposes rules, budget, and alarm facts", () => {
  const text = renderFraming(ctx());
  assert.match(text, /## PROACTIVE WAKE/);
  assert.match(text, /wake_reason: alarm/);
  assert.match(text, /proactive_no_reply/);
  assert.match(text, /0\/3 visible deliveries/);
  assert.match(text, /alarm_abc123/);
  assert.match(text, /提醒我喝水/);
  assert.match(text, /user_presence: cold/);
  assert.match(text, /outside 23:00\u201308:00/);
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
