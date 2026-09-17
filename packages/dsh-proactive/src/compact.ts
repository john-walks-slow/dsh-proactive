/**
 * Post-settle wake-slice compaction: after a wake turn ends with nothing
 * user-visible (deep silence via proactive_silence, or a turn that produced
 * no output),
 * rewrite the model-visible surface so the whole exchange — framing notice,
 * assistant reasoning/tool-call, tool result — collapses to a ~70-byte
 * tombstone. This is the mechanism that keeps hourly reminders from
 * polluting a long session's context: the raw session log keeps every event
 * (the GUI transcript renders append-origin events, so the wake exchange
 * stays visible to the human), while the LLM message surface — what
 * deriveMessages folds for every future request — sees only the tombstone.
 *
 * The platform's surface-replacement channel (dsh-session SurfaceOp
 * `{op:"replace", start, end}`; "any surface-replacing producer may use it")
 * is used twice per run:
 *   - the run containing the framing is replaced by a one-line user/message
 *     tombstone (distinct marker, never mistaken for a fresh framing);
 *   - every other owned run (assistant/tool events of the wake turn) is
 *     replaced by an empty-content assistant/message, whose derived LLM
 *     message is null — the platform's own "invisible node" rule.
 *
 * Runs are split around anything the wake did not author (runtime-context
 * snapshots, mnemon instructions, user messages that raced in mid-turn):
 * those stay on the surface untouched. Shadowing a runtime-context snapshot
 * would null the agent-loop's retained projection and force a full fresh
 * snapshot next turn — strictly worse than leaving it alone.
 *
 * Every append is validated by the session's SurfaceManager before it
 * commits: if a concurrent compaction already shadowed our range, the append
 * throws and we skip that run (logged, never fatal).
 */

import { boundContextSummary, createAssistantMessage, createUserMessage, type AssistantMessage, type UserMessage } from "@deepseek-ai/dsh-llm";
import { isSurfaceEvent, type SurfaceIntent } from "@deepseek-ai/dsh-session";
import { PROACTIVE_PLUGIN, type Alarm, type AlarmCompaction } from "./domain.js";
import { isFramingNotice } from "./observer.js";

/** First token of every compaction tombstone; distinct from FRAMING_MARKER. */
export const TOMBSTONE_MARKER = "[dsh-proactive silent wake ";

/** The raw events we inspect (a superset of observer's MinimalEvent: seq + surfaceOp). */
export interface CompactEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  surfaceOp?: unknown;
}

/**
 * Narrow append surface the compaction needs; the platform Session satisfies
 * this structurally. Kept interface-local so the driver stays testable with
 * fakes that only implement append.
 */
export interface CompactSession {
  append(type: "user/message", data: UserMessage, opts: SurfaceIntent): unknown;
  append(type: "assistant/message", data: { turn: number; step: number; message: AssistantMessage }, opts: SurfaceIntent): unknown;
}

/** One owned surface range to be collapsed, plus how to collapse it. */
export interface WakeCompactionRun {
  /** Seqs of the owned surface nodes, ascending; [0] and [at(-1)] bound the replace range. */
  seqs: number[];
  /** True when this run contains the framing notice (replaced by the tombstone). */
  framing: boolean;
}

/** The full compaction plan for one settled wake turn. */
export interface WakeCompactionPlan {
  runs: WakeCompactionRun[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The tombstone text that replaces the framing run. Under `minimal` compaction
 * the proactive_silence reason is appended so later turns can see why the wake
 * stayed silent; `aggressive` (and a reason-less `minimal`) keep only id + time.
 */
export function tombstoneText(alarm: Alarm, firedAt: Date, compaction: AlarmCompaction, reason?: string): string {
  const base = TOMBSTONE_MARKER + alarm.id + " " + firedAt.toISOString();
  if (compaction === "minimal" && typeof reason === "string" && reason.length > 0) {
    return base + " silence: " + reason + "]";
  }
  return base + "]";
}

/**
 * Plan the compaction of the wake turn that starts at or after startIndex:
 * partition the turn's OWNED surface nodes (framing + assistant/tool events,
 * up to the wake turn's turn/end) into surface-contiguous runs. Anything the
 * wake did not author breaks a run and is left untouched. Returns undefined
 * when no framing notice is found in the slice.
 */
export function planWakeCompaction(events: readonly CompactEvent[], startIndex: number): WakeCompactionPlan | undefined {
  const framingAt = events.findIndex((event, index) => index >= startIndex && isFramingNotice(event));
  if (framingAt === -1) return undefined;
  // Region bounds mirror the observer's anchoring exactly: the turn that
  // claimed the framing starts BEFORE it (the agent loop appends turn/start
  // before draining the inbox, so turn/start precedes the framing), and the
  // wake turn ends at the FIRST turn/end after the framing. Consistency with
  // the observer matters more than anything else here: the decision that
  // authorized compaction was judged over this very region. Without a settled
  // turn/end the region collapses to the framing alone.
  let regionEnd = framingAt;
  for (let i = framingAt + 1; i < events.length; i++) {
    if (events[i].type === "turn/end") {
      regionEnd = i;
      break;
    }
  }
  const runs: WakeCompactionRun[] = [];
  let current: number[] = [];
  let currentIsFraming = false;
  const closeRun = () => {
    if (current.length > 0) runs.push({ seqs: current, framing: currentIsFraming });
    current = [];
    currentIsFraming = false;
  };
  for (let i = framingAt; i <= regionEnd; i++) {
    const event = events[i];
    if (!isSurfaceEvent(event as never)) continue;
    const owned = i === framingAt || event.type === "assistant/message" || event.type === "tool/result";
    if (owned) {
      if (current.length === 0 && i === framingAt) currentIsFraming = true;
      current.push(event.seq);
    } else {
      closeRun();
    }
  }
  closeRun();
  return runs.length > 0 ? { runs } : undefined;
}

/**
 * Apply one compaction plan to the live session. Each run becomes a single
 * surface replacement appended after the settled turn; an empty-content
 * assistant/message eraser derives no LLM message at all. Any validation
 * failure (range no longer on the surface) skips that run with a warn.
 * @returns true when at least the framing run was collapsed.
 */
export function applyWakeCompaction(
  session: CompactSession,
  plan: WakeCompactionPlan,
  events: readonly CompactEvent[],
  alarm: Alarm,
  firedAt: Date,
  compaction: AlarmCompaction,
  reason: string | undefined,
  log: (level: "info" | "warn" | "error", message: string) => void
): boolean {
  let framingCollapsed = false;
  for (const run of plan.runs) {
    const opts: SurfaceIntent = {
      surfaceOp: { op: "replace", start: run.seqs[0], end: run.seqs[run.seqs.length - 1] },
      sourceEventSeqs: [...run.seqs]
    };
    try {
      if (run.framing) {
        session.append("user/message", createTombstoneMessage(alarm, firedAt, compaction, reason), opts);
        framingCollapsed = true;
      } else {
        const eraser = eraserMessage(eraserProvenance(events, run.seqs));
        if (eraser !== undefined) {
          session.append("assistant/message", eraser, opts);
        } else {
          session.append("user/message", createTombstoneMessage(alarm, firedAt, compaction, reason), opts);
        }
      }
    } catch (error) {
      log("warn", "wake compaction skipped for alarm " + alarm.id + " (range no longer on the surface): " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return framingCollapsed;
}

/** Build the tombstone user message that replaces the framing run. */
export function createTombstoneMessage(alarm: Alarm, firedAt: Date, compaction: AlarmCompaction, reason?: string): UserMessage {
  return createUserMessage({
    content: [{ type: "text", text: tombstoneText(alarm, firedAt, compaction, reason) }],
    source: {
      kind: "plugin",
      plugin: PROACTIVE_PLUGIN,
      form: "notice",
      summary: boundContextSummary(PROACTIVE_PLUGIN + " silent wake " + alarm.id)
    }
  });
}

/**
 * Build the invisible eraser for an assistant/tool run: an empty-content
 * assistant/message derives no LLM message. Provider/model provenance is
 * taken from the shadowed assistant message so the event stays honest about
 * its origin; without it the caller falls back to a tombstone.
 */
export function eraserMessage(provenance: { turn: number; step: number; provider: string; model: string } | undefined):
  | { turn: number; step: number; message: AssistantMessage }
  | undefined {
  if (provenance === undefined) return undefined;
  return {
    turn: provenance.turn,
    step: provenance.step,
    message: createAssistantMessage({
      content: [],
      source: { provider: provenance.provider, model: provenance.model }
    })
  };
}

/**
 * Extract the eraser provenance (turn/step/provider/model) from the first
 * assistant/message event of a run.
 */
export function eraserProvenance(events: readonly CompactEvent[], seqs: readonly number[]): { turn: number; step: number; provider: string; model: string } | undefined {
  const wanted = new Set(seqs);
  for (const event of events) {
    if (!wanted.has(event.seq) || event.type !== "assistant/message") continue;
    const message = isRecord(event.data["message"]) ? event.data["message"] : undefined;
    const source = message !== undefined && isRecord(message["source"]) ? message["source"] : undefined;
    const provider = source !== undefined && typeof source["provider"] === "string" ? source["provider"] : undefined;
    const model = source !== undefined && typeof source["model"] === "string" ? source["model"] : undefined;
    const turn = typeof event.data["turn"] === "number" ? event.data["turn"] : 0;
    const step = typeof event.data["step"] === "number" ? event.data["step"] : 0;
    if (provider !== undefined && model !== undefined) return { turn, step, provider, model };
    continue;
  }
  return undefined;
}
