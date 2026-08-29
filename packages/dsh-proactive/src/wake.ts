/**
 * Wake driver: the agent-world mechanics behind one alarm fire.
 *
 *   live session  -> reuse the live agent handle (follow-up queued politely)
 *   cold session  -> ctx.agents.resume() on the same session id, then follow-up
 *   busy agent    -> runMaintenance throws; caller retries after a short delay
 *   deep silence  -> the framing + proactive_no_reply contract; the observer
 *                    derives the decision from the committed session log
 *
 * The handle is always disposed when this driver created it (a resumed agent
 * is a process-local runtime; the persisted session itself stays intact).
 */

import type { Agent, AgentOptions } from "@deepseek-ai/dsh-agent";
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
  resume(options: { resumeSessionId: string; agentOptions?: AgentOptions }): Promise<AgentHandleLike>;
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
        ownedHandle = await this.deps.agents.resume({ resumeSessionId: alarm.sessionId, agentOptions });
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
        configQuietHours: this.deps.config.quietHours
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
          ...(analysis.note !== undefined ? { note: analysis.note } : {})
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

