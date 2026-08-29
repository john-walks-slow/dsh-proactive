import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeWakeTurn, extractTextBlocks, type MinimalEvent } from "../src/observer.js";

const ev = (type: string, data: Record<string, unknown> = {}): MinimalEvent => ({ type, data });

// Real session event shapes (dsh-session): assistant/message carries
// { turn, step, message: { role, content: [...] } }, turn/end carries
// { turn, reason: { kind, ... } }.
const assistantText = (text: string) => ev("assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text }] } });
const toolCall = (name: string) => ev("tool/call", { turn: 1, step: 1, callId: "c1", name, arguments: "{}" });
const turnStart = (n = 1) => ev("turn/start", { turn: n });
const turnEnd = (kind = "completed", extra: Record<string, unknown> = {}) => ev("turn/end", { turn: 1, reason: { kind, ...extra } });
const framing = ev("user/message", { role: "user", content: [{ type: "text", text: "## PROACTIVE WAKE ..." }], source: { kind: "plugin", plugin: "dsh-proactive", form: "notice", summary: "wake" } });

test("extractTextBlocks handles blocks, text, and nested message shapes", () => {
  assert.deepEqual(extractTextBlocks({ blocks: [{ type: "text", text: "hi" }, { type: "text", text: "  " }, { type: "tool_use", name: "x" }] }), ["hi"]);
  assert.deepEqual(extractTextBlocks({ text: "plain" }), ["plain"]);
  assert.deepEqual(extractTextBlocks({ message: { content: [{ type: "text", text: "nested" }] } }), ["nested"]);
  assert.deepEqual(extractTextBlocks({}), []);
});

test("proactive_no_reply with no text is deep silence (free)", () => {
  const events: MinimalEvent[] = [turnStart(), toolCall("proactive_no_reply"), turnEnd()];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "no_reply");
  assert.equal(analysis.budgetDelta, 0);
  assert.equal(analysis.leaked, false);
});

test("no_reply with stray text counts as leaked reply with a leak note", () => {
  const events: MinimalEvent[] = [turnStart(), assistantText("wait, let me tell you something"), toolCall("proactive_no_reply"), turnEnd()];
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

test("push tool costs one budget unit", () => {
  const events: MinimalEvent[] = [turnStart(), toolCall("push_notify"), assistantText("已推送"), turnEnd()];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "push");
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
  const events: MinimalEvent[] = [
    turnStart(0),
    assistantText("pending turn reply, not part of this wake"),
    turnEnd(),
    framing,
    turnStart(1),
    toolCall("proactive_no_reply"),
    turnEnd()
  ];
  const analysis = analyzeWakeTurn(events, 0);
  assert.equal(analysis.decision, "no_reply");
  assert.equal(analysis.budgetDelta, 0);
});
