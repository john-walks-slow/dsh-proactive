/**
 * Wake driver: the agent-world mechanics behind one alarm fire.
 *
 *   live session  -> reuse the live agent handle (follow-up queued politely)
 *   cold session  -> ctx.agents.resume() on the same session id, then follow-up.
 *                    The resumed agent gets a model-selection installed on its
 *                    scope (mirroring the web host's selectionFor), so its
 *                    first buildRequest resolves provider/model even when
 *                    AgentOptions are empty: the session's own committed
 *                    request header wins, agentDefaultModel is the fallback.
 *   busy agent    -> runMaintenance throws; caller retries after a short delay
 *   deep silence  -> the framing + proactive_no_reply contract; the observer
 *                    derives the decision from the committed session log
 *
 * The handle is always disposed when this driver created it (a resumed agent
 * is a process-local runtime; the persisted session itself stays intact).
 */

import type { Agent, AgentOptions, AgentSetup, ModelSelection, ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { EpochHeader } from "@deepseek-ai/dsh-session";
import type { Alarm, RunDecision } from "./domain.js";
import type { ProactiveStore } from "./store.js";
import type { ProactiveConfig } from "./config.js";
import { analyzeWakeTurn, type MinimalEvent } from "./observer.js";
import { createFramingMessage, type FramingContext } from "./framing.js";
import type { UserPresence } from "./framing.js";
import { isInQuietHours } from "./config.js";

export interface WakeAnalysisResult {
  decision: RunDecision;
  budgetDelta: number;
  /** True when no_reply was called after visible text was committed. */
  leaked?: boolean;
  note?: string;
}

export type WakeFireResult =
  | { outcome: "ok"; analysis: WakeAnalysisResult }
  | { outcome: "busy" }
  | { outcome: "failed"; error: string };

/** Narrow facade over the pieces of AgentRegistry / agents we actually use. */
export interface AgentsFacade {
  get(sessionId: string): Agent | undefined;
  resume(options: ResumeFacadeOptions): Promise<AgentHandleLike>;
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

/** The handle surface we consume (dsh-agent AgentHandle). */
export interface AgentHandleLike {
  agent: Agent;
  dispose(): Promise<void>;
}

export interface WakeDriverDeps {
  agents: AgentsFacade;
  /** Provider/model override for resumed agents (from ctx.agentDefaultModel or config). */
  modelSelection: () => { provider?: string; model?: string } | undefined;
  store: ProactiveStore;
  config: ProactiveConfig;
  now?: () => number;
  log: (level: "info" | "warn" | "error", message: string) => void;
}

export class WakeDriver {
  private readonly deps: WakeDriverDeps;
  private readonly inflight = new Set<string>();

  constructor(deps: WakeDriverDeps) {
    this.deps = deps;
  }

  /** Whether a wake for this session is currently in flight (guards proactive_no_reply). */
  isActiveWake(sessionId: string): boolean {
    return this.inflight.has(sessionId);
  }

  /**
   * Model selection for a resumed agent: the session's own committed request
   * header wins (the same model the live session last used), agentDefaultModel
   * is the fallback for sessions without any header. Installed on the agent's
   * scope so the first buildRequest resolves provider/model even when
   * AgentOptions are empty — the web host's exact pattern (selectionFor).
   */
  private createWakeSelection(agent: Agent): ModelSelectionRef {
    return createWakeSelectionRef(agent.session.requestHeader(), this.deps.modelSelection, this.deps.log);
  }

  async fire(alarm: Alarm): Promise<WakeFireResult> {
    if (this.inflight.has(alarm.sessionId)) {
      return { outcome: "busy" };
    }
    this.inflight.add(alarm.sessionId);
    let ownedHandle: AgentHandleLike | null = null;
    try {
      let agent = this.deps.agents.get(alarm.sessionId);
      let presence: UserPresence = "live";
      if (agent === undefined) {
        const model = this.deps.modelSelection();
        const agentOptions: AgentOptions | undefined =
          model !== undefined && (model.provider !== undefined || model.model !== undefined)
            ? (model.provider !== undefined ? { provider: model.provider, ...(model.model !== undefined ? { model: model.model } : {}) } : model.model !== undefined ? { model: model.model } : {})
            : undefined;
        ownedHandle = await this.deps.agents.resume({
          resumeSessionId: alarm.sessionId,
          agentOptions,
          setup: (agentCtx) => {
            const agent = (agentCtx as unknown as { agent: Agent }).agent;
            // react-loop installs `agent` on the scoped ctx before setup runs;
            // absence means the setup contract drifted — fail loudly instead of
            // silently reproducing the original "no provider/model" error
            if (agent === undefined) {
              throw new Error("wake resume: resumed agent has no scoped .agent (dsh-agent setup contract drift)");
            }
            installModelSelection(agentCtx, this.createWakeSelection(agent));
          }
        });
        agent = ownedHandle.agent;
        presence = "cold";
      }

      const now = this.deps.now?.() ?? Date.now();
      const startIndex = agent.session.events.length;
      const budgetUsed = this.deps.store.budgetFor(new Date(now).toISOString().slice(0, 10));
      const context: FramingContext = {
        alarm,
        budgetUsed,
        budgetMax: this.deps.config.maxDeliveriesPerDay,
        quiet: isInQuietHours(now, this.deps.config),
        now: new Date(now),
        userPresence: presence,
        configQuietHours: this.deps.config.quietHours,
        heartbeatPrompt: this.deps.config.heartbeatPrompt
      };
      const message = createFramingMessage(context);

      let claimed = false;
      try {
        claimed = await agent.runMaintenance(() => {
          agent.followup(message);
          return Promise.resolve(true);
        });
      } catch (_busy) {
        claimed = false;
      }
      if (!claimed) return { outcome: "busy" };

      await agent.whenIdle();
      const analysis = analyzeWakeTurn(agent.session.events as unknown as MinimalEvent[], startIndex);
      return {
        outcome: "ok",
        analysis: {
          decision: analysis.decision,
          budgetDelta: analysis.budgetDelta,
          ...(analysis.leaked ? { leaked: true } : {}),
          ...(analysis.note !== undefined ? { note: analysis.note } : {}),
          ...(analysis.reasoningSummary !== undefined ? { reasoningSummary: analysis.reasoningSummary } : {}),
          ...(analysis.replySummary !== undefined ? { replySummary: analysis.replySummary } : {})
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log("warn", "wake failed for alarm " + alarm.id + ": " + message);
      return { outcome: "failed", error: message };
    } finally {
      this.inflight.delete(alarm.sessionId);
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

