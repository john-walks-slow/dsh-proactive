import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeWakeTurn, extractTextBlocks, extractReasoningBlocks, truncateSummary, RUN_SUMMARY_MAX_LENGTH, type MinimalEvent } from "../src/observer.js";

const ev = (type: string, data: Record<string, unknown> = {}): MinimalEvent => ({ type, data });

// Real session event shapes (dsh-session): assistant/message carries
// { turn, step, message: { role, content: [...] } }, turn/end carries
// { turn, reason: { kind, ... } }.
const assistantText = (text: string) => ev("assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text }] } });
const assistantBlocks = (blocks: Array<Record<string, unknown>>) => ev("assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: blocks } });
const toolCall = (name: string) => ev("tool/call", { turn: 1, step: 1, callId: "c1", name, arguments: "{}" });
const toolCallWithArgs = (name: string, args: Record<string, unknown>) => ev("tool/call", { turn: 1, step: 1, callId: "c1", name, arguments: JSON.stringify(args) });
const turnStart = (n = 1) => ev("turn/start", { turn: n });
const turnEnd = (kind = "completed", extra: Record<string, unknown> = {}) => ev("turn/end", { turn: 1, reason: { kind, ...extra } });
const framing = ev("user/message", { role: "user", content: [{ type: "text", text: "[dsh-proactive wake alarm_x once cold] ..." }], source: { kind: "plugin", plugin: "dsh-proactive", form: "notice", summary: "wake" } });
const tombstone = ev("user/message", { role: "user", content: [{ type: "text", text: "[dsh-proactive silent wake alarm_x 2026-09-01T09:00:00.000Z]" }], source: { kind: "plugin", plugin: "dsh-proactive", form: "notice", summary: "silent wake" } });

test("extractTextBlocks handles blocks, text, and nested message shapes", () => {
  assert.deepEqual(extractTextBlocks({ blocks: [{ type: "text", text: "hi" }, { type: "text", text: "  " }, { type: "tool_use", name: "x" }] }), ["hi"]);
  assert.deepEqual(extractTextBlocks({ text: "plain" }), ["plain"]);
  assert.deepEqual(extractTextBlocks({ message: { content: [{ type: "text", text: "nested" }] } }), ["nested"]);
  assert.deepEqual(extractTextBlocks({}), []);
});

test("extractReasoningBlocks collects reasoning text with the same shapes", () => {
  assert.deepEqual(extractReasoningBlocks({ blocks: [{ type: "reasoning", text: "think" }, { type: "reasoning", text: " " }, { type: "text", text: "out" }] }), ["think"]);
  assert.deepEqual(extractReasoningBlocks({ message: { content: [{ type: "reasoning", text: "deep" }] } }), ["deep"]);
  assert.deepEqual(extractReasoningBlocks({ text: "plain" }), []);
  assert.deepEqual(extractReasoningBlocks({}), []);
});

test("truncateSummary caps at the run-history limit", () => {
  assert.equal(truncateSummary("  short  "), "short");
  const long = "x".repeat(RUN_SUMMARY_MAX_LENGTH + 50);
  const out = truncateSummary(long);
  assert.equal(out.length, RUN_SUMMARY_MAX_LENGTH + 1); // + ellipsis
  assert.ok(out.endsWith("…"));
});

test("truncateSummary does not split surrogate pairs (emoji)", () => {
  const emoji = "🚀"; // one code point, two UTF-16 units
  const text = emoji.repeat(RUN_SUMMARY_MAX_LENGTH + 1); // 201 intact code points
  const out = truncateSummary(text);
  assert.ok(!out.includes("\uFFFD")); // no replacement char from a half pair
  // Every emoji before the ellipsis is intact: 200 code points, never a lone surrogate.
  const body = out.slice(0, -1); // drop "…"
  assert.strictEqual(Array.from(body).length, RUN_SUMMARY_MAX_LENGTH);
  assert.ok(Array.from(body).every((ch) => ch === emoji));
});

test("analysis carries reasoning and reply summaries from the wake turn", () => {
  const reasoning = "用户昨天提到要在 9 点前完成报告，现在正好是 9 点，应该提醒他检查。";
  // Real log order: the turn that claims the framing starts BEFORE it (the
  // agent loop appends turn/start before draining the inbox).
  const events: MinimalEvent[] = [
    turnStart(),
    framing,
    assistantBlocks([{ type: "reasoning", text: reasoning }, { type: "text", text: "到点啦：报告截止，记得提交。" }]),
    turnEnd()
  ];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "reply");
  assert.equal(analysis.replySummary, "到点啦：报告截止，记得提交。");
  assert.equal(analysis.reasoningSummary, reasoning);
  assert.ok(analysis.reasoningSummary!.startsWith("用户昨天提到"));
});

test("reasoning summary is truncated while reply stays short", () => {
  const longReasoning = "步骤" + "思考".repeat(RUN_SUMMARY_MAX_LENGTH + 40);
  const events: MinimalEvent[] = [
    turnStart(),
    assistantBlocks([{ type: "reasoning", text: longReasoning }, { type: "text", text: "好的" }]),
    toolCall("no_reply"),
    turnEnd()
  ];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "reply"); // leaked
  assert.equal(analysis.leaked, true);
  assert.equal(analysis.replySummary, "好的");
  assert.equal(analysis.reasoningSummary!.length, RUN_SUMMARY_MAX_LENGTH + 1);
  assert.ok(analysis.reasoningSummary!.endsWith("…"));
});

test("no-reply turns with reasoning still expose the thinking summary", () => {
  const events: MinimalEvent[] = [
    turnStart(),
    assistantBlocks([{ type: "reasoning", text: "这个提醒昨天已经处理过，静默收尾。" }]),
    toolCall("no_reply"),
    turnEnd()
  ];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "no_reply");
  assert.equal(analysis.budgetDelta, 0);
  assert.equal(analysis.reasoningSummary, "这个提醒昨天已经处理过，静默收尾。");
  assert.equal(analysis.replySummary, undefined);
});

test("no_reply with no text is deep silence (free)", () => {
  const events: MinimalEvent[] = [turnStart(), toolCall("no_reply"), turnEnd()];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "no_reply");
  assert.equal(analysis.budgetDelta, 0);
  assert.equal(analysis.leaked, false);
});

test("no_reply with stray text counts as leaked reply with a leak note", () => {
  const events: MinimalEvent[] = [turnStart(), assistantText("wait, let me tell you something"), toolCall("no_reply"), turnEnd()];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "reply");
  assert.equal(analysis.leaked, true);
  assert.equal(analysis.budgetDelta, 1);
  assert.ok(analysis.note?.includes("leak"));
});

test("visible chat reply costs one budget unit", () => {
  const events: MinimalEvent[] = [turnStart(), assistantText("好的，已记住"), turnEnd()];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "reply");
  assert.equal(analysis.budgetDelta, 1);
});

test("unsettled turn is failed", () => {
  const events: MinimalEvent[] = [turnStart(), toolCall("proactive_list")];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "failed");
  assert.equal(analysis.budgetDelta, 0);
});

for (const kind of ["error", "aborted", "max-tokens"] as const) {
  test("turn/end reason kind " + kind + " is failed", () => {
    const events: MinimalEvent[] = [turnStart(), turnEnd(kind, { error: { code: "X", message: "boom" } })];
    const analysis = analyzeWakeTurn(events, 0);
    assert.equal(analysis.decision, "failed");
    assert.equal(analysis.budgetDelta, 0);
    assert.ok(analysis.note?.includes("abnormally"));
  });
}

test("completed reason with no output is failed with a clear note", () => {
  const events: MinimalEvent[] = [turnStart(), turnEnd()];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "failed");
  assert.ok(analysis.note?.includes("no visible output"));
});

test("analysis skips earlier unrelated events from the slice", () => {
  const events: MinimalEvent[] = [assistantText("old text before the wake"), turnStart(0), assistantText("wake reply"), turnEnd()];
  const analysis = analyzeWakeTurn(events, 1);
  assert.equal(analysis.decision, "reply");
  assert.equal(analysis.budgetDelta, 1);
});

test("slice anchors on the framing notice, ignoring a pending pre-wake turn", () => {
  // A pending user turn (queued before the wake) lands in the slice; the
  // analysis must anchor on our framing notice and only judge the wake turn.
  // Real order: the wake turn's turn/start precedes its framing.
  const events: MinimalEvent[] = [
    turnStart(0),
    assistantText("pending turn reply, not part of this wake"),
    turnEnd(),
    turnStart(1),
    framing,
    toolCall("no_reply"),
    turnEnd()
  ];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "no_reply");
  assert.equal(analysis.budgetDelta, 0);
});

test("compaction tombstones are never mistaken for a fresh framing notice", () => {
  const events: MinimalEvent[] = [
    tombstone,
    turnStart(1),
    framing,
    toolCall("no_reply"),
    turnEnd()
  ];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "no_reply");
});

test("raced user turn after a visible wake reply is NOT judged (reply keeps its budget accounting)", () => {
  // Real-order regression (P1 fix): the wake turn produced a visible reply;
  // a user turn raced in within the same whenIdle window and ended with no
  // text. Judging the raced turn would say "failed" and authorize compaction
  // that erases a reply the user already saw.
  const events: MinimalEvent[] = [
    turnStart(1),
    framing,
    assistantText("到点了，该喝水了！"),
    turnEnd(),
    turnStart(2),
    turnEnd("error", { error: { code: "X", message: "boom" } })
  ];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "reply");
  assert.equal(analysis.budgetDelta, 1);
  assert.equal(analysis.replySummary, "到点了，该喝水了！");
});

test("raced user turn with text after a SILENT wake is NOT judged (no mischarge, no lost compaction)", () => {
  // Real-order regression (P1 fix): the wake itself was silent; the raced
  // user turn carries text. Judging the raced turn would mischarge one budget
  // unit and skip compaction of the silent wake exchange.
  const events: MinimalEvent[] = [
    turnStart(1),
    framing,
    toolCall("no_reply"),
    turnEnd(),
    turnStart(2),
    assistantText("这是竞态用户回合的回复，不属于唤醒"),
    turnEnd()
  ];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "no_reply");
  assert.equal(analysis.budgetDelta, 0);
});

test("no_reply reason is extracted from the tool/call arguments", () => {
  const events: MinimalEvent[] = [
    turnStart(),
    toolCallWithArgs("no_reply", { reason: "用户已离线，无需打扰" }),
    turnEnd()
  ];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "no_reply");
  assert.equal(analysis.noReplyReason, "用户已离线，无需打扰");
});

test("no_reply reason is truncated to the run-history limit", () => {
  const longReason = "理由".repeat(RUN_SUMMARY_MAX_LENGTH + 40);
  const events: MinimalEvent[] = [
    turnStart(),
    toolCallWithArgs("no_reply", { reason: longReason }),
    turnEnd()
  ];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "no_reply");
  assert.equal(analysis.noReplyReason!.length, RUN_SUMMARY_MAX_LENGTH + 1);
  assert.ok(analysis.noReplyReason!.endsWith("…"));
});

test("no_reply without a reason argument yields undefined noReplyReason", () => {
  const events: MinimalEvent[] = [turnStart(), toolCall("no_reply"), turnEnd()];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "no_reply");
  assert.equal(analysis.noReplyReason, undefined);
});

test("malformed no_reply arguments JSON yields undefined noReplyReason", () => {
  const events: MinimalEvent[] = [
    turnStart(),
    ev("tool/call", { turn: 1, step: 1, callId: "c1", name: "no_reply", arguments: "{not json" }),
    turnEnd()
  ];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "no_reply");
  assert.equal(analysis.noReplyReason, undefined);
});
