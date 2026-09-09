/**
 * Wake driver: the agent-world mechanics behind one alarm fire.
 *
 *   target resume -> reuse the live agent handle (follow-up queued politely)
 *                    or ctx.agents.resume() on the same session id when cold.
 *   target fork   -> copy the parent's completed-turn prefix (host session.fork
 *                    semantics: last `turn/end` boundary, seedLength metadata,
 *                    parentSession lineage) into a brand-new child session and
 *                    drive the wake there.
 *   target new    -> drive the wake in a brand-new empty session.
 *                    Fork/new children are real persisted sessions and stay in
 *                    the sidebar once created.
 *
 * Every created/resumed agent gets a model-selection installed on its scope
 * (mirroring the web host's selectionFor), so its first buildRequest resolves
 * provider/model even when AgentOptions are empty: the session's own committed
 * request header wins, agentDefaultModel is the fallback.
 *
 *   busy agent    -> runMaintenance throws; caller retries after a short delay
 *   deep silence  -> the framing + no_reply contract; the observer
 *                    derives the decision from the committed session log
 *
 * The handle is always disposed when this driver created it (a resumed/created
 * agent is a process-local runtime; the persisted session itself stays intact).
 */

import type { Agent, AgentOptions, AgentSetup, ModelSelection, ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { EpochHeader, SessionEvent } from "@deepseek-ai/dsh-session";
import { randomUUID } from "node:crypto";
import type { Alarm, RunDecision } from "./domain.js";
import type { ProactiveStore } from "./store.js";
import type { ProactiveConfig } from "./config.js";
import { analyzeWakeTurn, type MinimalEvent } from "./observer.js";
import { createFramingMessage, type FramingContext } from "./framing.js";
import type { UserPresence } from "./framing.js";
import { isInQuietHours } from "./config.js";
import { applyWakeCompaction, planWakeCompaction, type CompactEvent, type CompactSession } from "./compact.js";

export interface WakeAnalysisResult {
  decision: RunDecision;
  budgetDelta: number;
  /** True when no_reply was called after visible text was committed. */
  leaked?: boolean;
  note?: string;
}

export type WakeFireResult =
  | { outcome: "ok"; analysis: WakeAnalysisResult; /** The session the wake actually ran in. */ sessionId: string }
  | { outcome: "busy" }
  | { outcome: "failed"; error: string; sessionId?: string };

/** Narrow facade over the pieces of AgentRegistry / agents we actually use. */
export interface AgentsFacade {
  get(sessionId: string): Agent | undefined;
  resume(options: ResumeFacadeOptions): Promise<AgentHandleLike>;
  create(options: CreateFacadeOptions): Promise<AgentHandleLike>;
}

/**
 * Read-only view of one persisted session, used to fork from a cold parent.
 * The plugin wires this to ctx.sessionPersistence.inspect; the narrow shape
 * keeps the driver independent of dsh-session-persistence internals.
 */
export interface SessionInspectLike {
  inspect(sessionId: string): Promise<{ meta?: { cwd?: string }; events: readonly SessionEvent[] }>;
}

/**
 * Resume-time composition hook, handed the resumed agent's scoped context.
 * Reuses dsh-agent's own `AgentSetup` type so upstream contract drift in the
 * setup signature surfaces as a compile error here too.
 */
export type WakeResumeSetup = AgentSetup;

export interface ResumeFacadeOptions {
  resumeSessionId: string;
  agentOptions?: AgentOptions;
  setup?: WakeResumeSetup;
}

export interface CreateFacadeOptions {
  sessionId: string;
  seed?: readonly SessionEvent[];
  agentOptions?: AgentOptions;
  setup?: AgentSetup;
  meta?: { cwd?: string; parentSession?: string; seedLength?: number };
}

/** The handle surface we consume (dsh-agent AgentHandle). */
export interface AgentHandleLike {
  agent: Agent;
  dispose(): Promise<void>;
}

export interface WakeDriverDeps {
  agents: AgentsFacade;
  /** Persisted-session reader for forking from cold parents (optional: fork degrades to failed when absent). */
  sessionPersistence?: SessionInspectLike;
  /** Provider/model override for resumed/created agents (from ctx.agentDefaultModel or config). */
  modelSelection: () => { provider?: string; model?: string } | undefined;
  store: ProactiveStore;
  config: ProactiveConfig;
  now?: () => number;
  log: (level: "info" | "warn" | "error", message: string) => void;
}

/**
 * Host session.fork seed cut, mirrored verbatim: the seed is the balanced
 * completed-turn prefix ending at the LAST `turn/end` (extended over trailing
 * non-turn events up to the next `turn/start`), contiguous from seq 0. 0 when
 * the parent has no completed turn (fork unavailable).
 */
export function completedTurnCut(events: readonly { seq: number; type: string }[]): number {
  let boundary = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "turn/end") {
      boundary = i;
      break;
    }
  }
  if (boundary === -1) return 0;
  let cut = events[boundary].seq + 1;
  while (cut < events.length && events[cut]?.type !== "turn/start") cut++;
  return cut;
}

export class WakeDriver {
  private readonly deps: WakeDriverDeps;
  /** Re-fire guard per alarm id. */
  private readonly inflightByAlarm = new Set<string>();
  /** Wake-turn guard per session (kept for inflight/busy semantics). */
  private readonly inflightBySession = new Set<string>();

  constructor(deps: WakeDriverDeps) {
    this.deps = deps;
  }

  /** Whether a wake for this session is currently in flight. */
  isActiveWake(sessionId: string): boolean {
    return this.inflightBySession.has(sessionId);
  }

  /**
   * Collapse the settled wake turn on the model surface (tombstone + invisible
   * erasers). Best-effort by design: a session without the platform's
   * append/surface split (test fakes) or a range a concurrent compaction
   * already shadowed just skips with a warn.
   */
  private compactWake(agent: Agent, startIndex: number, alarm: Alarm, firedAt: Date): void {
    try {
      const session = agent.session as unknown as {
        append: CompactSession["append"];
      };
      if (typeof session.append !== "function") return;
      const events = agent.session.events as unknown as CompactEvent[];
      const plan = planWakeCompaction(events, startIndex);
      if (plan === undefined) return;
      if (applyWakeCompaction(session as CompactSession, plan, events, alarm, firedAt, this.deps.log)) {
        this.deps.log("info", "wake exchange compacted for alarm " + alarm.id + " (no visible output; model surface collapsed to a tombstone)");
      }
    } catch (error) {
      this.deps.log("warn", "wake compaction failed for alarm " + alarm.id + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }

  /**
   * Model selection for a resumed/created agent: the session's own committed
   * request header wins (the same model the live session last used),
   * agentDefaultModel is the fallback for sessions without any header.
   * Installed on the agent's scope so the first buildRequest resolves
   * provider/model even when AgentOptions are empty — the web host's exact
   * pattern (selectionFor).
   */
  private createWakeSelection(agent: Agent): ModelSelectionRef {
    return createWakeSelectionRef(agent.session.requestHeader(), this.deps.modelSelection, this.deps.log);
  }

  private agentOptions(): AgentOptions | undefined {
    const model = this.deps.modelSelection();
    if (model === undefined || (model.provider === undefined && model.model === undefined)) return undefined;
    const options: AgentOptions = {};
    if (model.provider !== undefined) options.provider = model.provider;
    if (model.model !== undefined) options.model = model.model;
    return options;
  }

  private installSelection(agentCtx: unknown): void {
    const agent = (agentCtx as unknown as { agent: Agent }).agent;
    // react-loop installs `agent` on the scoped ctx before setup runs;
    // absence means the setup contract drifted — fail loudly instead of
    // silently reproducing the original "no provider/model" error
    if (agent === undefined) {
      throw new Error("wake resume: resumed agent has no scoped .agent (dsh-agent setup contract drift)");
    }
    installModelSelection(agentCtx as Parameters<typeof installModelSelection>[0], this.createWakeSelection(agent));
  }

  /** Events + workspace cwd of a parent session, live agent first, then persistence. */
  private async parentLog(parentId: string): Promise<{ events: readonly SessionEvent[]; cwd?: string } | undefined> {
    const live = this.deps.agents.get(parentId);
    if (live !== undefined) {
      return {
        events: live.session.events as unknown as SessionEvent[],
        cwd: (live.session as unknown as { meta?: { cwd?: string } }).meta?.cwd
      };
    }
    if (this.deps.sessionPersistence === undefined) return undefined;
    try {
      const inspected = await this.deps.sessionPersistence.inspect(parentId);
      return { events: inspected.events, cwd: inspected.meta?.cwd };
    } catch {
      return undefined;
    }
  }

  async fire(alarm: Alarm): Promise<WakeFireResult> {
    if (this.inflightByAlarm.has(alarm.id)) return { outcome: "busy" };
    this.inflightByAlarm.add(alarm.id);
    let ownedHandle: AgentHandleLike | null = null;
    let agent: Agent | undefined;
    let presence: UserPresence = "live";
    // The session the wake will actually run in (differs from the owner for fork/new).
    let actualSessionId = "";
    const drive = async (): Promise<WakeFireResult> => {
      const now = this.deps.now?.() ?? Date.now();
      const firedAt = new Date(now);
      const startIndex = agent!.session.events.length;
      const context: FramingContext = {
        alarm,
        quiet: isInQuietHours(now, this.deps.config),
        now: firedAt,
        userPresence: presence
      };
      const message = createFramingMessage(context);
      let claimed = false;
      try {
        claimed = await agent!.runMaintenance(() => {
          agent!.followup(message);
          return Promise.resolve(true);
        });
      } catch (_busy) {
        claimed = false;
      }
      if (!claimed) return { outcome: "busy" };
      await agent!.whenIdle();
      const analysis = analyzeWakeTurn(agent!.session.events as unknown as MinimalEvent[], startIndex);
      // Nothing user-visible came out of this wake: collapse the whole
      // exchange on the model surface so hourly reminders never pollute the
      // session context (see compact.ts).
      if (analysis.decision === "no_reply" || analysis.decision === "failed") {
        this.compactWake(agent!, startIndex, alarm, firedAt);
      }
      return {
        outcome: "ok",
        sessionId: actualSessionId,
        analysis: {
          decision: analysis.decision,
          budgetDelta: analysis.budgetDelta,
          ...(analysis.leaked ? { leaked: true } : {}),
          ...(analysis.note !== undefined ? { note: analysis.note } : {}),
          ...(analysis.reasoningSummary !== undefined ? { reasoningSummary: analysis.reasoningSummary } : {}),
          ...(analysis.replySummary !== undefined ? { replySummary: analysis.replySummary } : {})
        }
      };
    };
    try {
      if (alarm.target.mode === "resume") {
        if (this.inflightBySession.has(alarm.target.sessionId)) return { outcome: "busy" };
        this.inflightBySession.add(alarm.target.sessionId);
        actualSessionId = alarm.target.sessionId;
        agent = this.deps.agents.get(alarm.target.sessionId);
        if (agent === undefined) {
          ownedHandle = await this.deps.agents.resume({
            resumeSessionId: alarm.target.sessionId,
            agentOptions: this.agentOptions(),
            setup: (agentCtx) => this.installSelection(agentCtx)
          });
          agent = ownedHandle.agent;
          presence = "cold";
        }
        return await drive();
      }
      // fork / new — build the child session and drive it there.
      if (alarm.target.mode === "fork") {
        const parent = await this.parentLog(alarm.target.sessionId);
        if (parent === undefined) {
          return { outcome: "failed", error: "fork unavailable: parent session could not be read", sessionId: alarm.target.sessionId };
        }
        const cut = completedTurnCut(parent.events);
        if (cut === 0) {
          return { outcome: "failed", error: "fork unavailable: parent session has no completed turn", sessionId: alarm.target.sessionId };
        }
        const meta = { parentSession: alarm.target.sessionId, seedLength: cut, ...(parent.cwd !== undefined ? { cwd: parent.cwd } : {}) };
        actualSessionId = "session-" + randomUUID();
        ownedHandle = await this.deps.agents.create({
          sessionId: actualSessionId,
          seed: parent.events.slice(0, cut),
          meta,
          agentOptions: this.agentOptions(),
          setup: (agentCtx) => this.installSelection(agentCtx)
        });
      } else {
        actualSessionId = "session-" + randomUUID();
        ownedHandle = await this.deps.agents.create({
          sessionId: actualSessionId,
          agentOptions: this.agentOptions(),
          setup: (agentCtx) => this.installSelection(agentCtx)
        });
      }
      this.inflightBySession.add(actualSessionId);
      agent = ownedHandle.agent;
      presence = "cold";
      return await drive();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log("warn", "wake failed for alarm " + alarm.id + ": " + message);
      return { outcome: "failed", error: message, ...(actualSessionId !== undefined ? { sessionId: actualSessionId } : {}) };
    } finally {
      this.inflightByAlarm.delete(alarm.id);
      if (agent !== undefined) this.inflightBySession.delete(actualSessionId);
      if (ownedHandle !== null) {
        await ownedHandle.dispose().catch((error) => {
          this.deps.log("warn", "dispose failed for resumed handle: " + String(error && error.message || error));
        });
      }
    }
  }
}

/**
 * Provider/model for a wake turn from the session's last committed request
 * header, when one exists. Pure so the fallback chain is unit-testable.
 *
 * `reasoningEffort` is passed through verbatim: an explicit effort in the
 * header is preserved for the wake turn, while an absent effort is left unset
 * so adapter/default effort resolution applies (mirrors the web host).
 */
export function selectionFromHeader(header: EpochHeader | undefined): ModelSelection | undefined {
  if (header === undefined) return undefined;
  if (header.config.provider === undefined || header.config.model === undefined) return undefined;
  return {
    provider: header.config.provider,
    model: header.config.model,
    ...(header.config.reasoningEffort === undefined ? {} : { reasoningEffort: header.config.reasoningEffort })
  };
}

/**
 * Mutable model selection for a resumed agent's wake turn: the session's own
 * committed request header wins, then {@link fallback} (agentDefaultModel).
 * A missing or incomplete fallback is surfaced as a warn instead of silently
 * emptying the selection; `current` is undefined only when nothing at all
 * resolves, so the request waterfall has nowhere to draw provider/model from.
 */
export function createWakeSelectionRef(
  header: EpochHeader | undefined,
  fallback: () => { provider?: string; model?: string } | undefined,
  log: WakeDriverDeps["log"]
): ModelSelectionRef {
  let picked: ModelSelection | undefined;
  return {
    get current(): ModelSelection | undefined {
      if (picked !== undefined) return picked;
      const fromHeader = selectionFromHeader(header);
      if (fromHeader !== undefined) return fromHeader;
      const maybe = fallback();
      if (maybe === undefined || (maybe.provider === undefined && maybe.model === undefined)) {
        const what = header === undefined
          ? "no committed request header"
          : "committed request header is incomplete (missing provider/model)";
        log("warn", `wake resume: ${what} and agentDefaultModel selection unavailable; provider/model left to the request waterfall`);
        return undefined;
      }
      if (maybe.provider === undefined || maybe.model === undefined) {
        log("warn", "wake resume: agentDefaultModel selection incomplete: " + JSON.stringify(maybe));
        return undefined;
      }
      return { provider: maybe.provider, model: maybe.model };
    },
    set current(next: ModelSelection | undefined) {
      picked = next;
    },
    assembled: void 0
  };
}