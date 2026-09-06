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
import { ProactivePanelService } from "./panel/service.js";
import { installPanelRoutes } from "./panel/routes.js";
import { wireSettings } from "./settings.js";
import { PROACTIVE_PLUGIN } from "./domain.js";

export const name = PROACTIVE_PLUGIN;
export const inject = ["agents", "tools", "sessionPersistence"];

interface ModelSelectionLike {
  provider?: unknown;
  model?: unknown;
}

function currentModelSelection(ctx: Context): { provider?: string; model?: string } | undefined {
  const service = (ctx as unknown as Record<string, unknown>)["agentDefaultModel"];
  if (service === undefined || typeof (service as { currentSelection?: unknown })["currentSelection"] !== "function") {
    ctx.logger.warn(
      "dsh-proactive: ctx.agentDefaultModel is not resolvable from this scope (service " + (service === undefined ? "missing" : "has no currentSelection") + "); cold wakes will rely on the session request header fallback"
    );
    return undefined;
  }
  try {
    const selection = (service as { currentSelection: () => ModelSelectionLike })["currentSelection"]();
    if (selection !== undefined && selection !== null) {
      return {
        ...(typeof selection["provider"] === "string" ? { provider: selection["provider"] } : {}),
        ...(typeof selection["model"] === "string" ? { model: selection["model"] } : {})
      };
    }
  } catch (error) {
    ctx.logger.warn("dsh-proactive: agentDefaultModel.currentSelection() failed: " + String(error && (error as Error).message || error));
  }
  return undefined;
}

interface SessionsLike {
  get?: (id: string) => unknown;
}

interface SessionTitleLike {
  get?: (session: unknown) => { title?: string } | undefined;
}

/**
 * Resolve a session id to its display title for the panel tables. The services
 * are probed optional (sessions + dsh-session-title), so a headless host that
 * lacks them degrades to an empty title — the panel then shows the raw id.
 */
function resolveSessionTitle(ctx: Context): (sessionId: string) => string {
  const ctxGet = (ctx as unknown as { get: (name: string, strict?: boolean) => unknown }).get;
  const sessions = ctxGet("sessions", false) as SessionsLike | undefined;
  const titles = ctxGet("sessionTitle", false) as SessionTitleLike | undefined;
  const sessionsGet = sessions?.get;
  const titlesGet = titles?.get;
  if (sessionsGet === undefined || titlesGet === undefined) {
    return () => "";
  }
  return (sessionId: string) => {
    try {
      const session = sessionsGet(sessionId);
      if (session === undefined) return "";
      const snapshot = titlesGet(session);
      return typeof snapshot?.title === "string" ? snapshot.title : "";
    } catch {
      return "";
    }
  };
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  ctx.logger.info("dsh-proactive: applying (trace).");
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

  const panel = new ProactivePanelService({
    store,
    config,
    scheduler,
    dataDir: config.dataDir,
    now: () => Date.now(),
    log: (level, message) => ctx.logger[level](message),
    sessionTitle: resolveSessionTitle(ctx)
  });

  // Optional surfaces: panel HTTP routes (needs the host webserver) and the
  // settings namespace (needs a settings service). Both degrade to a logged
  // no-op on headless profiles — the model tools never depend on them.
  const extraDisposers: Array<() => void> = [];
  const routeDispose = installPanelRoutes(ctx, panel, (listener) => store.onChange(listener));
  if (routeDispose !== undefined) extraDisposers.push(routeDispose);
  const settingsWire = wireSettings(ctx, config);
  if (settingsWire.installed && settingsWire.dispose !== undefined) extraDisposers.push(settingsWire.dispose);

  scheduler.start();
  ctx.logger.info(
    "dsh-proactive started: dataDir=" + config.dataDir +
    " budget=" + config.maxDeliveriesPerDay + "/day" +
    " quietHours=" + config.quietHours.start + "-" + config.quietHours.end + " " + config.quietHours.timeZone +
    " maxWakeupsPerHour=" + config.maxWakeupsPerHour
  );

  return async () => {
    stopCreated();
    for (const dispose of extraDisposers) dispose();
    scheduler.stop();
    await store.persist().catch(() => undefined);
  };
}
