import { test } from "node:test";
import assert from "node:assert/strict";
import { createFramingMessage, effectiveWakePrompt, renderFraming, type FramingContext } from "../src/framing.js";
import { DEFAULT_CONFIG } from "../src/config.js";
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
    heartbeatPrompt: DEFAULT_CONFIG.heartbeatPrompt,
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

test("renderFraming falls back for legacy wake reasons (check_in/interval/companion)", () => {
  for (const legacy of ["check_in", "interval", "companion"]) {
    const text = renderFraming(ctx({ alarm: { ...alarm, wakeReason: legacy as Alarm["wakeReason"] } }));
    assert.ok(text.includes("wake_reason: " + legacy + " (" + legacy + ")"), "legacy: " + legacy);
    assert.ok(!text.includes("undefined"), "legacy: " + legacy);
  }
});

test("renderFraming allows no_reply on every wake reason", () => {
  const text = renderFraming(ctx());
  assert.match(text, /available on EVERY wake/);
  const alarmText = renderFraming(ctx({ alarm: { ...alarm, wakeReason: "heartbeat" } }));
  assert.match(alarmText, /available on EVERY wake/);
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

const heartbeatAlarm = (prompt: string): Alarm => ({ ...alarm, id: "hb_1", wakeReason: "heartbeat", prompt });

test("effectiveWakePrompt: heartbeat always leads with the configured default", () => {
  const base = ctx().heartbeatPrompt.trim();
  // No extra direction: default alone.
  assert.equal(effectiveWakePrompt(ctx({ alarm: heartbeatAlarm("") })), base);
  assert.equal(effectiveWakePrompt(ctx({ alarm: heartbeatAlarm("   ") })), base);
  // Extra direction: default first, custom appended after a blank line.
  const out = effectiveWakePrompt(ctx({ alarm: heartbeatAlarm("关注用户的睡眠节奏") }));
  assert.equal(out, base + "\n\n关注用户的睡眠节奏");
  assert.ok(out.startsWith(base), "default must come first");
  // Same wording as the default is deduped (panel preset prefill case).
  assert.equal(effectiveWakePrompt(ctx({ alarm: heartbeatAlarm(base) })), base);
});

test("effectiveWakePrompt: alarm keeps its prompt verbatim (no default prefix)", () => {
  assert.equal(effectiveWakePrompt(ctx({ alarm: { ...alarm, prompt: "提醒我喝水" } })), "提醒我喝水");
  assert.equal(effectiveWakePrompt(ctx({ alarm: { ...alarm, wakeReason: "check_in" as Alarm["wakeReason"], prompt: "legacy 提醒" } })), "legacy 提醒");
});

test("renderFraming embeds the effective heartbeat prompt in the alarm instruction", () => {
  const base = ctx().heartbeatPrompt.trim();
  const text = renderFraming(ctx({ alarm: heartbeatAlarm("关注用户的睡眠节奏") }));
  assert.ok(text.includes("关注用户的睡眠节奏"));
  const jsonLine = text.split("\n").find((l) => l.includes("关注用户的睡眠节奏"));
  assert.ok(jsonLine?.includes(base), "default wording must be part of the emitted prompt");
});
