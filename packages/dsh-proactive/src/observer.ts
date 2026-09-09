/**
 * Wake-turn observer: after a wake turn settles, derive its decision from the
 * committed session log so the budget and the persistent run record are
 * grounded in durable evidence, not in the driver's assumptions.
 *
 * Analysis is log-slice based: the driver records the event index before
 * follow-up, then scans the appended slice for the turn boundary, tool calls,
 * and the final assistant message. The slice is anchored to the wake framing
 * notice (user/message with source.kind=plugin) so a pending pre-wake turn is
 * never misattributed. A model that called no_reply and produced no
 * chat text is "no_reply" (deep silence); visible chat text is charged one
 * budget unit.
 */

import { isRecord, type RunDecision } from "./domain.js";
import { FRAMING_MARKER } from "./framing.js";

/** The subset of a session event we inspect. */
export interface MinimalEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface WakeAnalysis {
  decision: RunDecision;
  budgetDelta: number;
  leaked: boolean;
  toolNames: string[];
  hasText: boolean;
  note?: string;
  /** Truncated reasoning (thinking) summary of the turn, for the run history. */
  reasoningSummary?: string;
  /** Truncated visible-reply summary of the turn, for the run history. */
  replySummary?: string;
  /** The no_reply reason the model gave for staying silent, for the run history. */
  noReplyReason?: string;
}

const NO_REPLY_TOOL = "no_reply";

/** Per-field summary cap for the run history (reasoning + reply are stored truncated). */
export const RUN_SUMMARY_MAX_LENGTH = 200;

/** Collapse one summary field to at most RUN_SUMMARY_MAX_LENGTH characters. */
export function truncateSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= RUN_SUMMARY_MAX_LENGTH) return trimmed;
  // Code-point slicing: avoids splitting a surrogate pair (e.g. emoji) mid-way.
  return Array.from(trimmed).slice(0, RUN_SUMMARY_MAX_LENGTH).join("") + "…";
}

export function extractTextBlocks(data: Record<string, unknown>): string[] {
  const blocks = Array.isArray(data["blocks"]) ? data["blocks"] : undefined;
  if (blocks !== undefined) {
    const texts: string[] = [];
    for (const block of blocks) {
      if (typeof block === "object" && block !== null && block["type"] === "text") {
        const text = block["text"];
        if (typeof text === "string" && text.trim().length > 0) texts.push(text);
      }
    }
    return texts;
  }
  if (typeof data["text"] === "string" && data["text"].trim().length > 0) return [data["text"]];
  const nested = data["message"];
  if (isRecord(nested) && Array.isArray(nested["content"])) {
    return extractTextBlocks({ blocks: nested["content"] as unknown[] });
  }
  return [];
}

/** Reasoning (thinking) block texts from one assistant/message event, same shapes as text. */
export function extractReasoningBlocks(data: Record<string, unknown>): string[] {
  const blocks = Array.isArray(data["blocks"]) ? data["blocks"] : undefined;
  if (blocks !== undefined) {
    const texts: string[] = [];
    for (const block of blocks) {
      if (typeof block === "object" && block !== null && block["type"] === "reasoning") {
        const text = block["text"];
        if (typeof text === "string" && text.trim().length > 0) texts.push(text);
      }
    }
    return texts;
  }
  const nested = data["message"];
  if (isRecord(nested) && Array.isArray(nested["content"])) {
    return extractReasoningBlocks({ blocks: nested["content"] as unknown[] });
  }
  return [];
}

/** The no_reply tool's reason argument from one tool/call event's JSON arguments field, truncated. */
function extractNoReplyReason(data: Record<string, unknown>): string | undefined {
  const raw = data["arguments"];
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    const reason = parsed["reason"];
    if (typeof reason !== "string") return undefined;
    const trimmed = reason.trim();
    return trimmed.length > 0 ? truncateSummary(trimmed) : undefined;
  } catch {
    return undefined;
  }
}

/** turn/end reason kinds that mean the wake turn did not settle normally. */
const FAILURE_KINDS = new Set(["error", "aborted", "max-tokens"]);

/**
 * True when one session event is our wake framing notice. Anchors on the
 * plugin source AND the framing marker so compaction tombstones (same plugin,
 * different marker) are never mistaken for a fresh framing.
 */
export function isFramingNotice(event: MinimalEvent): boolean {
  if (event.type !== "user/message") return false;
  const source = isRecord(event.data["source"]) ? event.data["source"] : undefined;
  if (source === undefined || source["kind"] !== "plugin" || source["plugin"] !== "dsh-proactive") return false;
  const blocks = Array.isArray(event.data["content"]) ? event.data["content"] : [];
  const first = blocks[0];
  return isRecord(first) && first["type"] === "text" && typeof first["text"] === "string" && first["text"].startsWith(FRAMING_MARKER);
}

/**
 * Analyze the event slice that starts at startIndex (inclusive) and covers the
 * wake turn. Returns a stable decision with the budget delta applied.
 */
export function analyzeWakeTurn(events: readonly MinimalEvent[], startIndex: number): WakeAnalysis {
  const slice = events.slice(startIndex);
  // Anchor on our framing notice when present: the wake turn is the turn that
  // CLAIMED the framing — its turn/start precedes the framing (the agent loop
  // appends turn/start before draining the inbox), and the turn ends at the
  // FIRST turn/end after the framing. Skipping ahead to a later turn/start
  // here would judge a raced user turn instead of the wake turn (mischarging
  // the budget or, worse, authorizing compaction of a wake reply the user
  // already saw). Without a notice (tests, replayed slices) fall back to the
  // first turn boundary in the slice.
  const framingAt = slice.findIndex(isFramingNotice);
  let effective = slice;
  if (framingAt >= 0) {
    effective = slice.slice(framingAt);
  } else {
    const firstTurnStart = slice.findIndex((event) => event.type === "turn/start");
    if (firstTurnStart >= 0) effective = slice.slice(firstTurnStart);
  }

  const turnEndIndex = effective.findIndex((event) => event.type === "turn/end");
  const turnSegment = turnEndIndex >= 0 ? effective.slice(0, turnEndIndex + 1) : effective;

  let hasText = false;
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolNames: string[] = [];
  let noReply = false;
  let noReplyReason: string | undefined;
  for (const event of turnSegment) {
    if (event.type === "assistant/message") {
      const texts = extractTextBlocks(event.data);
      if (texts.length > 0) {
        hasText = true;
        textParts.push(...texts);
      }
      const reasoning = extractReasoningBlocks(event.data);
      if (reasoning.length > 0) reasoningParts.push(...reasoning);
    }
    if (event.type === "tool/call") {
      const name = typeof event.data["name"] === "string" ? event.data["name"] : "";
      if (name.length > 0) toolNames.push(name);
      if (name === NO_REPLY_TOOL) {
        noReply = true;
        if (noReplyReason === undefined) noReplyReason = extractNoReplyReason(event.data);
      }
    }
  }
  const turnEnded = turnEndIndex >= 0;
  const errorEnd = turnEnded && isErrorEnd(effective[turnEndIndex]?.data);

  let decision: RunDecision;
  let note: string | undefined;
  const leaked = noReply && hasText;
  if (noReply && !hasText) {
    decision = "no_reply";
  } else if (hasText) {
    decision = "reply";
    if (noReply) note = "leak: no_reply called after visible text (charged 1)";
  } else if (!turnEnded || errorEnd) {
    decision = "failed";
    note = errorEnd ? "wake turn ended abnormally" : "wake turn did not settle cleanly";
  } else {
    decision = "failed";
    note = "wake turn produced no visible output without no_reply";
  }
  return {
    decision,
    budgetDelta: decision === "reply" ? 1 : 0,
    leaked,
    toolNames,
    hasText,
    ...(reasoningParts.length > 0 ? { reasoningSummary: truncateSummary(reasoningParts.join("\n")) } : {}),
    ...(textParts.length > 0 ? { replySummary: truncateSummary(textParts.join("\n")) } : {}),
    ...(noReplyReason !== undefined ? { noReplyReason } : {}),
    ...(note !== undefined ? { note } : {})
  };
}

function isErrorEnd(data: Record<string, unknown> | undefined): boolean {
  // Real turn/end data is { turn, reason: TurnEndReason }; failure shapes are
  // reason.kind 'error' | 'aborted' | 'max-tokens' (dsh-session types).
  if (data === undefined || !isRecord(data["reason"])) return false;
  const kind = (data["reason"] as Record<string, unknown>)["kind"];
  return typeof kind === "string" && FAILURE_KINDS.has(kind);
}
