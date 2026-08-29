/**
 * dsh-proactive — 模型主动跟进插件（host-level alarms for DSH agents）
 *
 * Wire-up:
 *   - host store (alarms.json / runs.jsonl / state.json) under the data dir
 *   - ProactiveScheduler drives due alarms through WakeDriver
 *   - WakeDriver resumes cold sessions (ctx.agents.resume) or reuses live
 *     agents, delivers the framed wake message, waits for the turn, and the
 *     observer derives the decision from the committed session log
 *   - proactive_* tools are registered on every root agent (agent/created),
 *     so resumed wake turns always see them
 *
 * Configuration: <dataDir>/config.json overrides defaults (see config.ts),
 * DSH_PROACTIVE_* environment variables override both.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { resolveConfig } from "./config.js";
import { ProactiveStore } from "./store.js";
import { ProactiveScheduler } from "./scheduler.js";
import { WakeDriver } from "./wake.js";
import { registerProactiveTools } from "./tools.js";
import { PROACTIVE_PLUGIN } from "./domain.js";

export const name = PROACTIVE_PLUGIN;
export const inject = ["agents", "tools", "sessionPersistence"];

interface ModelSelectionLike {
  provider?: unknown;
  model?: unknown;
}

function currentModelSelection(ctx: Context): { provider?: string; model?: string } | undefined {
  try {
    const service = (ctx as unknown as Record<string, unknown>)["agentDefaultModel"];
    if (service !== undefined && typeof (service as { currentSelection?: unknown })["currentSelection"] === "function") {
      const selection = (service as { currentSelection: () => ModelSelectionLike })["currentSelection"]();
      if (selection !== undefined && selection !== null) {
        return {
          ...(typeof selection["provider"] === "string" ? { provider: selection["provider"] } : {}),
          ...(typeof selection["model"] === "string" ? { model: selection["model"] } : {})
        };
      }
    }
  } catch {
    /* default model service is optional */
  }
  return undefined;
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const config = resolveConfig();
  if (!config.enabled) {
    ctx.logger.info("dsh-proactive disabled by config.");
    return async () => undefined;
  }

  const loaded = await ProactiveStore.load(config.dataDir);
  const store = loaded.store;
  store.corrupt = loaded.corrupt;
  if (loaded.corrupt) {
    ctx.logger.warn("dsh-proactive: alarms.json is corrupt or unreadable; starting with an empty store. Fix or remove " + config.dataDir + "/alarms.json to restore alarms.");
  }

  const driver = new WakeDriver({
    agents: ctx.agents,
    modelSelection: () => currentModelSelection(ctx),
    store,
    config,
    log: (level, message) => ctx.logger[level](message)
  });

  const scheduler = new ProactiveScheduler({
    store,
    config,
    runWake: (alarm) => driver.fire(alarm),
    log: (level, message) => ctx.logger[level](message)
  });

  // Register on every root agent exactly once: the listener covers agents
  // created/resumed after plugin load, the initial scan covers agents that
  // already exist when this plugin applies (boot order is not guaranteed).
  const registered = new WeakSet<Agent>();
  const registerOne = (agent: Agent) => {
    if (registered.has(agent)) return;
    if (!ctx.agents.roots().includes(agent)) return;
    registered.add(agent);
    registerProactiveTools(agent.ctx, agent, {
      store,
      config,
      driver,
      scheduler,
      now: () => Date.now()
    });
  };
  const stopCreated = ctx.on("agent/created", ({ agent }: { agent: Agent }) => {
    registerOne(agent);
  });
  for (const existing of ctx.agents.roots()) {
    registerOne(existing);
  }

  scheduler.start();
  ctx.logger.info(
    "dsh-proactive started: dataDir=" + config.dataDir +
    " budget=" + config.maxDeliveriesPerDay + "/day" +
    " quietHours=" + config.quietHours.start + "-" + config.quietHours.end + " " + config.quietHours.timeZone +
    " maxWakeupsPerHour=" + config.maxWakeupsPerHour
  );

  return async () => {
    stopCreated();
    scheduler.stop();
    await store.persist().catch(() => undefined);
  };
}
