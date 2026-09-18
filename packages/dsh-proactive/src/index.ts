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
import { WakeDriver, type AgentPresetsPort, type WakeDriverDeps } from "./wake.js";
import { registerProactiveTools } from "./tools.js";
import { startDeclaredScheduleSync } from "./declared.js";
import { ProactivePanelService } from "./panel/service.js";
import { installPanelRoutes } from "./panel/routes.js";
import { wireSettings } from "./settings.js";
import { PROACTIVE_PLUGIN } from "./domain.js";
import { createPresetWakePort, createWorkspaceWakePort, liveEventsOf, resolveWorkspaceArg, type LiveSessionLike, type ProjectionCacheLike, type SessionHeaderLike, type WorkspaceRegistryFacade } from "./workspace.js";

export const name = PROACTIVE_PLUGIN;
export const inject = ["agents", "tools", "sessionPersistence"];

interface ModelSelectionLike {
  provider?: unknown;
  model?: unknown;
}

function currentModelSelection(ctx: Context): { provider?: string; model?: string } | undefined {
  const service = ctx.get("agentDefaultModel", false) as { currentSelection?: () => ModelSelectionLike } | undefined;
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

/**
 * Session display titles are a client-side concern: the GUI panels enrich
 * alarm rows from the host `session.list` projections (the exact same source
 * the sidebar uses), so the host-side surface stays dependency-free. This
 * resolver always yields an empty title; the panel falls back to the raw
 * session id when no title arrived (e.g. headless hosts).
 */
function resolveSessionTitle(_ctx: unknown): (sessionId: string) => string {
  return () => "";
}

/** Session-owned events from the live in-memory store (cordis augmentation not typed here). */
function sessionEventsOf(ctx: Context): (sessionId: string) => readonly unknown[] | undefined {
  const sessions = ctx.get("sessions", false) as { get?: (id: string) => LiveSessionLike | undefined } | undefined;
  return (sessionId) => {
    const session = sessions?.get?.(sessionId);
    return session === undefined ? undefined : liveEventsOf(session);
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

  // Workspace world (target_mode "workspace"): the registry itself, the live
  // session store, cold persistence headers, and the persisted projection
  // cache are all read defensively — a host without dsh-workspace keeps every
  // other feature and workspace-targeted alarms fail closed with a clear error.
  const registry = ctx.get("workspaceRegistry", false) as WorkspaceRegistryFacade | undefined;
  if (registry === undefined) {
    ctx.logger.warn("dsh-proactive: ctx.workspaceRegistry is not available; workspace-target alarms will fail until a profile with dsh-workspace runs this host.");
  }
  const resolveWorkspace = registry === undefined
    ? undefined
    : (args: Record<string, unknown>, sessionCwd?: string) => resolveWorkspaceArg(args, { registry, sessionCwd });
  // The persistence service plays two narrow roles (fork seed reads via
  // inspect, cold workspace ranking via list); one cast covers both.
  const persistenceService = ctx.get("sessionPersistence", false) as
    (WakeDriverDeps["sessionPersistence"] & { list(): Promise<readonly SessionHeaderLike[]> }) | undefined;
  // The preset roster joins every wake agent to its session's preset — the
  // same defensive read as above: without dsh-agent-presets in the profile
  // (rosterless deployment) wake agents stay on the host-plane registry.
  const presetsService = ctx.get("agentPresets", false) as AgentPresetsPort | undefined;
  if (presetsService === undefined) {
    ctx.logger.warn("dsh-proactive: ctx.agentPresets is not available; cold-wake agents will compose without a preset (host-plane tools only).");
  }
  const workspaces = registry === undefined
    ? undefined
    : createWorkspaceWakePort({
        registry,
        liveSessions: () => {
          const sessions = ctx.get("sessions", false) as { list?: () => readonly LiveSessionLike[] } | undefined;
          return sessions?.list?.() ?? [];
        },
        coldHeaders: persistenceService === undefined ? undefined : () => persistenceService.list(),
        projectionCache: ctx.get("sessionProjectionCache", false) as ProjectionCacheLike | undefined,
        createdSessionKind: (sessionId) => store.createdSessionKind(sessionId),
        log: (level, message) => ctx.logger[level](message)
      });
  // Preset-sourced targets (target_source "preset"): the same live/cold
  // ranking inputs as the workspace port, minus the registry — the preset
  // roster itself is NOT needed to match sessions (the header/event fold is
  // the source of truth); only the archived exclusion reads the registry.
  const liveSessionsForTargets = () => {
    const sessions = ctx.get("sessions", false) as { list?: () => readonly LiveSessionLike[] } | undefined;
    return sessions?.list?.() ?? [];
  };
  const presetTargets = createPresetWakePort({
    liveSessions: liveSessionsForTargets,
    coldHeaders: persistenceService === undefined ? undefined : () => persistenceService.list(),
    projectionCache: ctx.get("sessionProjectionCache", false) as ProjectionCacheLike | undefined,
    archivedSessionIds: registry === undefined ? undefined : () => registry.archivedSessionIds,
    createdSessionKind: (sessionId) => store.createdSessionKind(sessionId),
    log: (level, message) => ctx.logger[level](message)
  });

  const driver = new WakeDriver({
    agents: ctx.agents,
    // Cold-parent fork seed reads go through the same persistence service the
    // web host uses; degraded to a logged failed wake when absent (headless).
    // Access is defensive: the cordis augmentation for sessionPersistence only
    // exists when dsh-session-persistence types are loaded into the profile.
    sessionPersistence: persistenceService,
    workspaces,
    presetTargets,
    agentPresets: presetsService,
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
      now: () => Date.now(),
      resolveWorkspace,
      sessionEvents: sessionEventsOf(ctx)
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
    sessionTitle: resolveSessionTitle(ctx),
    sessionEvents: sessionEventsOf(ctx),
    resolveWorkspace,
    // Roster rows for the create form's preset pickers; the same defensive
    // read as the wake path (rosterless deployments get a degraded picker).
    ...(presetsService === undefined ? {} : {
      presetRoster: async () => {
        const roster = await (presetsService as unknown as { remoteExportList?: () => Promise<{ presets: readonly { id: string; name?: string; description?: string; isDefault?: boolean; broken?: string }[] }> }).remoteExportList?.();
        return roster?.presets ?? [];
      }
    })
  });

  // Optional surfaces: panel HTTP routes (needs the host webserver) and the
  // settings namespace (needs a settings service). Both degrade to a logged
  // no-op on headless profiles — the model tools never depend on them.
  const extraDisposers: Array<() => void> = [];
  const routeDispose = installPanelRoutes(ctx, panel, (listener) => store.onChange(listener));
  if (routeDispose !== undefined) extraDisposers.push(routeDispose);
  const settingsWire = wireSettings(ctx, config);
  if (settingsWire.installed && settingsWire.dispose !== undefined) extraDisposers.push(settingsWire.dispose);

  // Declared-schedule files (config.scheduleFiles): a declarative alarm
  // source synced into the store on boot and polled on an interval; the file
  // is the source of truth. Feature-off by default (empty list = no-op pass).
  const declaredSync = startDeclaredScheduleSync({
    config,
    store,
    now: () => Date.now(),
    resolveWorkspace,
    scheduler,
    log: (level, message) => ctx.logger[level](message)
  });
  extraDisposers.push(declaredSync.dispose);

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
