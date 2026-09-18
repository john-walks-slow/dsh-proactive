/**
 * Wake driver: the agent-world mechanics behind one alarm fire.
 *
 * v3 target dialect — the wake INTENT (new/resume/fork) is orthogonal to the
 * SOURCE that names the conversation:
 *
 *   target new    -> drive the wake in a brand-new empty session, optionally
 *                    configured: workspaceId (meta.cwd + attach), presetId
 *                    (composition stamp), provider/model (wake selection).
 *   target resume -> reuse the live agent handle (follow-up queued politely)
 *                    or ctx.agents.resume() on the same session id when cold.
 *   target fork   -> copy the parent's completed-turn prefix (host session.fork
 *                    semantics: last `turn/end` boundary, seedLength metadata,
 *                    parentSession lineage) into a brand-new child session and
 *                    drive the wake there. Fork/new children are real persisted
 *                    sessions and stay in the sidebar once created.
 *
 *   source session  (resume/fork) -> the named target_session_id.
 *   source workspace (resume/fork, and the legacy target_mode "workspace") ->
 *                    resolve at fire time through the WorkspaceWakePort (most
 *                    recently updated session in the workspace; else its newest
 *                    blank New Session slot; else SKIP — nothing eligible).
 *                    The resolver never creates; plugin-created products are
 *                    never eligible (store bookkeeping).
 *   source preset   (resume/fork) -> resolve at fire time through the
 *                    PresetWakePort (the most recently updated session RUNNING
 *                    that preset; else SKIP for resume, fail-closed for fork).
 *
 * Sessions this driver creates itself (target_mode new products, fork
 * children) are bookkept into the store right after agents.create, so later
 * workspace/preset resolutions never wake inside the plugin's own echo.
 *
 * Every created/resumed agent gets a model-selection installed on its scope
 * (mirroring the web host's selectionFor), so its first buildRequest resolves
 * provider/model even when AgentOptions are empty: an alarm-level provider/
 * model override (target new) wins outright, else the session's own committed
 * request header, else agentDefaultModel. It is also composed onto the
 * session's agent preset (mirroring the web host's composeAgent): preset-owned
 * tools live on the agent's scope, so a resume/create that skips the join
 * leaves the agent on the host-plane-only registry — bash, read, ... all
 * answer "unknown tool". The preset id comes from the session's own header
 * plus any later `agent-preset/selected` events, so a wake rebuilds the exact
 * composition the session's history ran under.
 *
 *   busy agent    -> runMaintenance throws; caller retries after a short delay
 *   deep silence  -> the framing + no_reply contract; the observer
 *                    derives the decision from the committed session log
 *
 * The handle is always disposed when this driver created it (a resumed/created
 * agent is a process-local runtime; the persisted session itself stays intact).
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentOptions, AgentSetup, ModelSelection, ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { EpochHeader, SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { randomUUID } from "node:crypto";
import { DEFAULT_COMPACTION, targetSourceOf, type Alarm, type AlarmCompaction, type AlarmTarget, type RunDecision } from "./domain.js";
import type { ProactiveStore } from "./store.js";
import type { ProactiveConfig } from "./config.js";
import { analyzeWakeTurn, type MinimalEvent } from "./observer.js";
import { createFramingMessage, type FramingContext } from "./framing.js";
import type { UserPresence } from "./framing.js";
import { isInQuietHours } from "./config.js";
import { applyWakeCompaction, planWakeCompaction, type CompactEvent, type CompactSession } from "./compact.js";
import { resolveSessionPresetOf, type PresetWakeDestination, type PresetWakePort, type WorkspaceWakeDestination, type WorkspaceWakePort } from "./workspace.js";

/** Minimum spacing between min-idle re-checks, so a burst of activity cannot spin the scheduler. */
const MIN_IDLE_RECHECK_MS = 60_000;

// The session preset fold lives in workspace.ts (shared with the
// preset-source session ranking); re-exported here so existing importers of
// wake.js keep working.
export { resolveSessionPresetOf };

export interface WakeAnalysisResult {
  decision: RunDecision;
  budgetDelta: number;
  note?: string;
  /** The no_reply reason the model gave for staying silent. */
  noReplyReason?: string;
  /** Truncated reasoning (thinking) summary of the wake turn. */
  reasoningSummary?: string;
  /** Truncated visible-reply summary of the wake turn. */
  replySummary?: string;
}

export type WakeFireResult =
  | { outcome: "ok"; analysis: WakeAnalysisResult; /** The session the wake actually ran in. */ sessionId: string }
  | { outcome: "busy" }
  | { outcome: "failed"; error: string; sessionId?: string }
  /** Nothing to wake (workspace/preset source resolved to no eligible session): the scheduler records a skip and advances — no retry, no budget. */
  | { outcome: "skipped"; skipReason: string }
  /** min_idle gate not satisfied yet: the scheduler re-arms at deferUntilMs with no record, no retry count, and no budget cost. */
  | { outcome: "defer"; deferUntilMs: number };

/**
 * The live Session log surface across host lines: 0.1.1-rc.2 exposes `.events`,
 * 0.1.2-rc.1 replaced it with `snapshotEvents()` (`.seq` and `requestHeader()`
 * exist in both). A profile may run either line, so read the log through
 * whichever surface the live Session carries. A session still being created
 * has an empty log either way.
 */
export function sessionLogOf(session: unknown): readonly unknown[] {
  const probe = session as { events?: readonly unknown[]; snapshotEvents?: () => readonly unknown[] };
  if (Array.isArray(probe.events)) return probe.events;
  if (typeof probe.snapshotEvents === "function") return probe.snapshotEvents();
  return [];
}

/**
 * The newest event timestamp in a session log, or undefined when the log is
 * empty or carries no parseable times. SessionEvent.time lives at the event
 * top level (never inside data) and is an ISO string.
 */
export function lastEventEpoch(events: readonly unknown[]): number | undefined {
  let latest: number | undefined;
  for (const event of events) {
    const time = (event as { time?: unknown }).time;
    if (typeof time !== "string") continue;
    const epoch = Date.parse(time);
    if (!Number.isFinite(epoch)) continue;
    if (latest === undefined || epoch > latest) latest = epoch;
  }
  return latest;
}

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
  inspect(sessionId: string): Promise<{ meta?: SessionHeader; events: readonly SessionEvent[] }>;
}

/**
 * Narrow facade over ctx.agentPresets: join one agent's scope to the standing
 * mount of one preset. The plugin resolves this from ctx (absent on a
 * rosterless deployment, where cold wakes stay on the host-plane registry).
 */
export interface AgentPresetsPort {
  /** The preset id mounted when a caller names none (AgentPresets.defaultId). */
  readonly defaultId: string;
  mount(agentCtx: Context, id?: string): Promise<unknown>;
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
  meta?: { cwd?: string; parentSession?: string; seedLength?: number; agentPreset?: string };
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
  /** Workspace destination resolution for workspace-sourced targets (absent -> those alarms fail loudly). */
  workspaces?: WorkspaceWakePort;
  /** Preset destination resolution for preset-sourced targets (absent -> those alarms fail loudly). */
  presetTargets?: PresetWakePort;
  /** Preset roster for composing wake agents onto their session's preset (absent on a rosterless deployment). */
  agentPresets?: AgentPresetsPort;
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
  private compactWake(agent: Agent, startIndex: number, alarm: Alarm, firedAt: Date, compaction: AlarmCompaction, reason: string | undefined): void {
    try {
      const session = agent.session as unknown as {
        append: CompactSession["append"];
      };
      if (typeof session.append !== "function") return;
      const events = sessionLogOf(agent.session) as unknown as CompactEvent[];
      const plan = planWakeCompaction(events, startIndex);
      if (plan === undefined) return;
      if (applyWakeCompaction(session as CompactSession, plan, events, alarm, firedAt, compaction, reason, this.deps.log)) {
        this.deps.log("info", "wake exchange compacted for alarm " + alarm.id + " (no visible output; model surface collapsed to a tombstone)");
      }
    } catch (error) {
      this.deps.log("warn", "wake compaction failed for alarm " + alarm.id + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }

  /**
   * Model selection for a resumed/created agent: an alarm-level override with
   * BOTH provider and model wins outright (a "new" target naming its model);
   * otherwise the session's own committed request header wins (the same model
   * the live session last used), and the fallback chain is the host's
   * agentDefaultModel MERGED with any partial override. Installed on the
   * agent's scope so the first buildRequest resolves provider/model even when
   * AgentOptions are empty — the web host's exact pattern (selectionFor).
   */
  private createWakeSelection(agent: Agent, override?: { provider?: string; model?: string }): ModelSelectionRef {
    if (override !== undefined && override.provider !== undefined && override.model !== undefined) {
      const fixed: ModelSelection = { provider: override.provider, model: override.model };
      let picked: ModelSelection | undefined;
      return {
        get current(): ModelSelection | undefined { return picked ?? fixed; },
        set current(next: ModelSelection | undefined) { picked = next; },
        assembled: void 0
      };
    }
    return createWakeSelectionRef(
      agent.session.requestHeader(),
      () => {
        const base = this.deps.modelSelection();
        return {
          ...(base ?? {}),
          ...(override?.provider !== undefined ? { provider: override.provider } : {}),
          ...(override?.model !== undefined ? { model: override.model } : {})
        };
      },
      this.deps.log
    );
  }

  private agentOptions(override?: { provider?: string; model?: string }): AgentOptions | undefined {
    const base = this.deps.modelSelection();
    const provider = override?.provider ?? base?.provider;
    const model = override?.model ?? base?.model;
    if (provider === undefined && model === undefined) return undefined;
    const options: AgentOptions = {};
    if (provider !== undefined) options.provider = provider;
    if (model !== undefined) options.model = model;
    return options;
  }

  private installSelection(agentCtx: unknown, override?: { provider?: string; model?: string }): void {
    const agent = (agentCtx as unknown as { agent: Agent }).agent;
    // react-loop installs `agent` on the scoped ctx before setup runs;
    // absence means the setup contract drifted — fail loudly instead of
    // silently reproducing the original "no provider/model" error
    if (agent === undefined) {
      throw new Error("wake resume: resumed agent has no scoped .agent (dsh-agent setup contract drift)");
    }
    installModelSelection(agentCtx as Parameters<typeof installModelSelection>[0], this.createWakeSelection(agent, override));
  }

  /**
   * Creation meta recording the default preset, so a fresh child's header
   * names the composition it runs under (the web host records the same on
   * every create). `undefined` on a rosterless deployment.
   */
  private defaultPresetMeta(): { agentPreset?: string } | undefined {
    const presets = this.deps.agentPresets;
    return presets === undefined ? undefined : { agentPreset: presets.defaultId };
  }

  /**
   * Bookkeep one just-created session so the fire-time resolvers never route
   * a later wake into it (see workspace.ts). Best-effort persistence: the
   * in-memory book is already updated when the write fails, and this
   * process keeps the exclusion until a restart loses it.
   */
  private bookkeepCreatedSession(sessionId: string, kind: "new" | "fork"): void {
    void this.deps.store.recordCreatedSession(sessionId, kind).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log("warn", "created-session bookkeeping failed for " + sessionId + ": " + message + " (dynamic-target alarms may capture this session until restart)");
    });
  }

  /**
   * Creation/resume-time composition, the web host's exact pattern
   * (composeAgent in the session controller): model selection first, then the
   * session's own preset — resolved from its header plus any later
   * `agent-preset/selected` events, so a wake rebuilds the exact composition
   * the session's history ran under. Without the join a preset-world agent
   * resolves only host-plane tools (bash/read/... all "unknown tool"), which
   * is the cold-wake defect this exists to prevent.
   *
   * Setup-time shape notes: a session being CREATED has an empty log at setup
   * (sessionLogOf → []; the header already carries the creation meta's preset
   * stamp, which the empty-log resolve falls back to), and resolveSessionPreset
   * reads `.events` directly, so it always receives the compat-adapted view —
   * never the raw live Session.
   */
  private async composeAgent(agentCtx: unknown, override?: { provider?: string; model?: string }): Promise<void> {
    this.installSelection(agentCtx, override);
    const presets = this.deps.agentPresets;
    if (presets === undefined) return;
    const agent = (agentCtx as unknown as { agent: Agent }).agent;
    const log = sessionLogOf(agent.session) as readonly SessionEvent[];
    const presetId = resolveSessionPresetOf({ header: agent.session.header, events: log });
    await presets.mount(agentCtx as Context, presetId);
  }

  /**
   * Events + workspace cwd + preset of a parent session, live agent first,
   * then persistence. The preset rides the fork child's meta so its header
   * records the composition its inherited history ran under.
   */
  private async parentLog(parentId: string): Promise<{ events: readonly SessionEvent[]; cwd?: string; presetId?: string } | undefined> {
    const live = this.deps.agents.get(parentId);
    if (live !== undefined) {
      const log = sessionLogOf(live.session) as unknown as SessionEvent[];
      return {
        events: log,
        cwd: live.session.header.cwd,
        presetId: resolveSessionPresetOf({ header: live.session.header, events: log })
      };
    }
    if (this.deps.sessionPersistence === undefined) return undefined;
    try {
      const inspected = await this.deps.sessionPersistence.inspect(parentId);
      return {
        events: inspected.events,
        cwd: inspected.meta?.cwd,
        presetId: inspected.meta === undefined ? undefined : resolveSessionPresetOf({ header: inspected.meta, events: inspected.events })
      };
    } catch {
      return undefined;
    }
  }

  /** Acquire the agent for one session id: live reuse or cold resume. */
  private async acquireForResume(sessionId: string): Promise<{ agent: Agent; handle: AgentHandleLike | null; presence: UserPresence }> {
    const live = this.deps.agents.get(sessionId);
    if (live !== undefined) return { agent: live, handle: null, presence: "live" };
    const handle = await this.deps.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.agentOptions(),
      setup: (agentCtx) => this.composeAgent(agentCtx)
    });
    return { agent: handle.agent, handle, presence: "cold" };
  }

  /**
   * min_idle_seconds gate for resume destinations: the wake is delivered only
   * after the destination session has been quiet for the configured span. The
   * clock reads the LIVE agent's session log tail — any event resets it,
   * including earlier wake turns, so a self-monitoring alarm enforces its own
   * spacing. A cold session is idle by definition (nothing is running).
   * Returns null when the wake may proceed.
   */
  private idleGate(alarm: Alarm, sessionId: string): WakeFireResult | null {
    const minIdleSeconds = alarm.minIdleSeconds ?? 0;
    if (minIdleSeconds <= 0) return null;
    const live = this.deps.agents.get(sessionId);
    if (live === undefined) return null;
    const last = lastEventEpoch(sessionLogOf(live.session));
    if (last === undefined) return null;
    const now = this.deps.now?.() ?? Date.now();
    const idleAt = last + minIdleSeconds * 1000;
    if (now >= idleAt) return null;
    return { outcome: "defer", deferUntilMs: Math.max(idleAt, now + MIN_IDLE_RECHECK_MS) };
  }

  /** Deliver the framed wake to `agent` and analyze the settled turn. */
  private async drive(alarm: Alarm, agent: Agent, actualSessionId: string, presence: UserPresence): Promise<WakeFireResult> {
    const now = this.deps.now?.() ?? Date.now();
    const firedAt = new Date(now);
    const startIndex = agent.session.seq;
    const context: FramingContext = {
      alarm,
      quiet: isInQuietHours(now, this.deps.config),
      now: firedAt,
      userPresence: presence
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
    const analysis = analyzeWakeTurn(sessionLogOf(agent.session) as unknown as MinimalEvent[], startIndex);
    // Collapse the wake exchange off the model surface ONLY when the model
    // explicitly asserted the turn is reclaimable via proactive_reclaim (see
    // observer.ts compactable). Implicit silences, other tools' silences,
    // replies, and failed turns all keep their exchange in context. The
    // silentWakeCompaction gate still has to be on for any compaction.
    if (analysis.compactable) {
      const compaction = this.deps.config.silentWakeCompaction
        ? (alarm.compaction ?? DEFAULT_COMPACTION)
        : "off";
      if (compaction !== "off") {
        this.compactWake(agent, startIndex, alarm, firedAt, compaction, analysis.noReplyReason);
      }
    }
    return {
      outcome: "ok",
      sessionId: actualSessionId,
      analysis: {
        decision: analysis.decision,
        budgetDelta: analysis.budgetDelta,
        ...(analysis.note !== undefined ? { note: analysis.note } : {}),
        ...(analysis.reasoningSummary !== undefined ? { reasoningSummary: analysis.reasoningSummary } : {}),
        ...(analysis.replySummary !== undefined ? { replySummary: analysis.replySummary } : {}),
        ...(analysis.noReplyReason !== undefined ? { noReplyReason: analysis.noReplyReason } : {})
      }
    };
  }

  async fire(alarm: Alarm): Promise<WakeFireResult> {
    if (this.inflightByAlarm.has(alarm.id)) return { outcome: "busy" };
    this.inflightByAlarm.add(alarm.id);
    let ownedHandle: AgentHandleLike | null = null;
    let agent: Agent | undefined;
    let presence: UserPresence = "live";
    // The session the wake will actually run in (differs from the owner for fork/new/create arms).
    let actualSessionId = "";
    // The session currently holding the inflight guard ("" = none yet).
    let guardSessionId = "";
    try {
      // Legacy v2 "workspace" targets fold into the v3 resume+workspace
      // spelling here, so every downstream arm sees exactly one dialect.
      const target: Extract<AlarmTarget, { mode: "resume" | "fork" | "new" }> =
        alarm.target.mode === "workspace"
          ? { mode: "resume", sourceType: "workspace", workspaceId: alarm.target.workspaceId }
          : alarm.target;

      if (target.mode === "new") {
        // A fresh session per fire, optionally configured: workspace (cwd +
        // attach), preset (composition), provider/model (wake selection).
        let cwd: string | undefined;
        if (target.workspaceId !== undefined) {
          const port = this.deps.workspaces;
          if (port === undefined) {
            this.deps.log("warn", "wake failed for alarm " + alarm.id + ": workspace-configured alarms are unavailable on this host (no workspace registry)");
            return { outcome: "failed", error: "workspace-configured alarms are unavailable on this host (no workspace registry)" };
          }
          let resolved: string | { error: string };
          try {
            resolved = await port.cwdOf(target.workspaceId);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.log("warn", "wake failed for alarm " + alarm.id + ": workspace resolution failed: " + message);
            return { outcome: "failed", error: "workspace resolution failed: " + message };
          }
          if (typeof resolved !== "string") {
            this.deps.log("warn", "wake failed for alarm " + alarm.id + ": " + resolved.error);
            return { outcome: "failed", error: resolved.error };
          }
          cwd = resolved;
        }
        const override = target.provider !== undefined || target.model !== undefined
          ? { provider: target.provider, model: target.model }
          : undefined;
        actualSessionId = "session-" + randomUUID();
        const presetMeta = target.presetId !== undefined ? { agentPreset: target.presetId } : this.defaultPresetMeta();
        const meta = cwd !== undefined || presetMeta !== undefined
          ? { ...(cwd !== undefined ? { cwd } : {}), ...(presetMeta ?? {}) }
          : undefined;
        ownedHandle = await this.deps.agents.create({
          sessionId: actualSessionId,
          agentOptions: this.agentOptions(override),
          meta,
          setup: (agentCtx) => this.composeAgent(agentCtx, override)
        });
        // Bookkeep BEFORE attach/drive: even a failed attach or drive leaves
        // a real session behind, and it must never become a later wake's
        // "most recently active" destination.
        this.bookkeepCreatedSession(actualSessionId, "new");
        if (target.workspaceId !== undefined) {
          // Attach BEFORE driving, so a failed attach never delivers a wake
          // into an ungrouped session.
          const port = this.deps.workspaces!;
          try {
            await port.attach(target.workspaceId, actualSessionId);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error("workspace attach failed: " + message + " (created session " + actualSessionId + " is left unattached; it will not receive wakes)");
          }
        }
        this.inflightBySession.add(actualSessionId);
        guardSessionId = actualSessionId;
        agent = ownedHandle.agent;
        presence = "cold";
        return await this.drive(alarm, agent, actualSessionId, presence);
      }

      const source = targetSourceOf(target);

      if (target.mode === "resume") {
        if (source === "session") {
          const sessionId = target.sessionId;
          if (sessionId === undefined || sessionId === "") {
            return { outcome: "failed", error: "resume target has no session id (corrupt alarm record); cancel or edit this alarm" };
          }
          if (this.inflightBySession.has(sessionId)) return { outcome: "busy" };
          const idle = this.idleGate(alarm, sessionId);
          if (idle !== null) return idle;
          this.inflightBySession.add(sessionId);
          guardSessionId = sessionId;
          actualSessionId = sessionId;
          const acquired = await this.acquireForResume(sessionId);
          agent = acquired.agent;
          ownedHandle = acquired.handle;
          presence = acquired.presence;
          return await this.drive(alarm, agent, actualSessionId, presence);
        }
        if (source === "workspace") {
          const workspaceId = target.workspaceId;
          if (workspaceId === undefined || workspaceId === "") {
            return { outcome: "failed", error: "workspace-sourced target has no workspace id (corrupt alarm record); cancel or edit this alarm" };
          }
          const port = this.deps.workspaces;
          if (port === undefined) {
            this.deps.log("warn", "wake failed for alarm " + alarm.id + ": workspace-source alarms are unavailable on this host (no workspace registry)");
            return { outcome: "failed", error: "workspace-source alarms are unavailable on this host (no workspace registry)" };
          }
          let destination: WorkspaceWakeDestination | { error: string };
          try {
            destination = await port.resolveTarget(workspaceId);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.log("warn", "wake failed for alarm " + alarm.id + ": workspace resolution failed: " + message);
            return { outcome: "failed", error: "workspace resolution failed: " + message };
          }
          if ("error" in destination) {
            this.deps.log("warn", "wake failed for alarm " + alarm.id + ": " + destination.error);
            return { outcome: "failed", error: destination.error };
          }
          if (destination.kind === "session") {
            if (this.inflightBySession.has(destination.sessionId)) return { outcome: "busy" };
            const idle = this.idleGate(alarm, destination.sessionId);
            if (idle !== null) return idle;
            this.inflightBySession.add(destination.sessionId);
            guardSessionId = destination.sessionId;
            actualSessionId = destination.sessionId;
            const acquired = await this.acquireForResume(destination.sessionId);
            agent = acquired.agent;
            ownedHandle = acquired.handle;
            presence = acquired.presence;
            return await this.drive(alarm, agent, actualSessionId, presence);
          }
          // Nothing eligible (only archived/subagent/plugin-created sessions,
          // or an empty workspace): skip the fire. Creating here would defeat
          // the bookkeeping — every fire would mint a fresh top-ranked
          // candidate and the next wake would land inside the plugin's own
          // echo. target_mode "new" is the "ensure a session" spelling.
          return {
            outcome: "skipped",
            skipReason: "workspace " + workspaceId + " has no eligible session to wake (only archived, subagent-owned, or this plugin's own created sessions); use target_mode new to wake a fresh session"
          };
        }
        // source === "preset"
        const presetId = target.presetId;
        if (presetId === undefined || presetId === "") {
          return { outcome: "failed", error: "preset-sourced target has no preset id (corrupt alarm record); cancel or edit this alarm" };
        }
        const port = this.deps.presetTargets;
        if (port === undefined) {
          this.deps.log("warn", "wake failed for alarm " + alarm.id + ": preset-source alarms are unavailable on this host (no preset roster)");
          return { outcome: "failed", error: "preset-source alarms are unavailable on this host (no preset roster)" };
        }
        let destination: PresetWakeDestination | { error: string };
        try {
          destination = await port.resolveTarget(presetId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.deps.log("warn", "wake failed for alarm " + alarm.id + ": preset resolution failed: " + message);
          return { outcome: "failed", error: "preset resolution failed: " + message };
        }
        if ("error" in destination) {
          this.deps.log("warn", "wake failed for alarm " + alarm.id + ": " + destination.error);
          return { outcome: "failed", error: destination.error };
        }
        if (destination.kind === "session") {
          if (this.inflightBySession.has(destination.sessionId)) return { outcome: "busy" };
          const idle = this.idleGate(alarm, destination.sessionId);
          if (idle !== null) return idle;
          this.inflightBySession.add(destination.sessionId);
          guardSessionId = destination.sessionId;
          actualSessionId = destination.sessionId;
          const acquired = await this.acquireForResume(destination.sessionId);
          agent = acquired.agent;
          ownedHandle = acquired.handle;
          presence = acquired.presence;
          return await this.drive(alarm, agent, actualSessionId, presence);
        }
        // No session runs the preset (user sessions only — plugin-created
        // products are never eligible): skip the fire. Same reasoning as the
        // workspace arm: creating here would mint a fresh preset-stamped
        // candidate every fire; target_mode "new" with target_preset_id is
        // the "start one" spelling.
        return {
          outcome: "skipped",
          skipReason: "no session is running preset " + presetId + " (archived, subagent-owned, and this plugin's own created sessions are never eligible); use target_mode new with target_preset_id to start one"
        };
      }

      // fork — resolve the source session, then branch from its history.
      let parentSessionId: string;
      if (source === "session") {
        if (target.sessionId === undefined || target.sessionId === "") {
          return { outcome: "failed", error: "fork target has no session id (corrupt alarm record); cancel or edit this alarm" };
        }
        parentSessionId = target.sessionId;
      } else if (source === "workspace") {
        if (target.workspaceId === undefined || target.workspaceId === "") {
          return { outcome: "failed", error: "fork target has no workspace id (corrupt alarm record); cancel or edit this alarm" };
        }
        const port = this.deps.workspaces;
        if (port === undefined) {
          this.deps.log("warn", "wake failed for alarm " + alarm.id + ": workspace-source alarms are unavailable on this host (no workspace registry)");
          return { outcome: "failed", error: "workspace-source alarms are unavailable on this host (no workspace registry)" };
        }
        let destination: WorkspaceWakeDestination | { error: string };
        try {
          destination = await port.resolveTarget(target.workspaceId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.deps.log("warn", "wake failed for alarm " + alarm.id + ": workspace resolution failed: " + message);
          return { outcome: "failed", error: "workspace resolution failed: " + message };
        }
        if ("error" in destination) {
          this.deps.log("warn", "wake failed for alarm " + alarm.id + ": " + destination.error);
          return { outcome: "failed", error: destination.error };
        }
        if (destination.kind !== "session") {
          return { outcome: "failed", error: "fork unavailable: workspace has no eligible session to fork from" };
        }
        parentSessionId = destination.sessionId;
      } else {
        if (target.presetId === undefined || target.presetId === "") {
          return { outcome: "failed", error: "fork target has no preset id (corrupt alarm record); cancel or edit this alarm" };
        }
        const port = this.deps.presetTargets;
        if (port === undefined) {
          this.deps.log("warn", "wake failed for alarm " + alarm.id + ": preset-source alarms are unavailable on this host (no preset roster)");
          return { outcome: "failed", error: "preset-source alarms are unavailable on this host (no preset roster)" };
        }
        let destination: PresetWakeDestination | { error: string };
        try {
          destination = await port.resolveTarget(target.presetId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.deps.log("warn", "wake failed for alarm " + alarm.id + ": preset resolution failed: " + message);
          return { outcome: "failed", error: "preset resolution failed: " + message };
        }
        if ("error" in destination) {
          this.deps.log("warn", "wake failed for alarm " + alarm.id + ": " + destination.error);
          return { outcome: "failed", error: destination.error };
        }
        if (destination.kind !== "session") {
          return { outcome: "failed", error: "fork unavailable: no session found running preset " + target.presetId };
        }
        parentSessionId = destination.sessionId;
      }
      const parent = await this.parentLog(parentSessionId);
      if (parent === undefined) {
        return { outcome: "failed", error: "fork unavailable: parent session could not be read", sessionId: parentSessionId };
      }
      const cut = completedTurnCut(parent.events);
      if (cut === 0) {
        return { outcome: "failed", error: "fork unavailable: parent session has no completed turn", sessionId: parentSessionId };
      }
      const meta = {
        parentSession: parentSessionId,
        seedLength: cut,
        ...(parent.cwd !== undefined ? { cwd: parent.cwd } : {}),
        ...(parent.presetId !== undefined ? { agentPreset: parent.presetId } : {})
      };
      actualSessionId = "session-" + randomUUID();
      ownedHandle = await this.deps.agents.create({
        sessionId: actualSessionId,
        seed: parent.events.slice(0, cut),
        meta,
        agentOptions: this.agentOptions(),
        setup: (agentCtx) => this.composeAgent(agentCtx)
      });
      // Fork children inherit the parent's human history, so lastPromptAt
      // can never expose them — only the bookkeeping keeps them out of
      // later workspace/preset resolutions.
      this.bookkeepCreatedSession(actualSessionId, "fork");
      this.inflightBySession.add(actualSessionId);
      guardSessionId = actualSessionId;
      agent = ownedHandle.agent;
      presence = "cold";
      return await this.drive(alarm, agent, actualSessionId, presence);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log("warn", "wake failed for alarm " + alarm.id + ": " + message);
      return { outcome: "failed", error: message, ...(actualSessionId !== "" ? { sessionId: actualSessionId } : {}) };
    } finally {
      this.inflightByAlarm.delete(alarm.id);
      if (guardSessionId !== "") this.inflightBySession.delete(guardSessionId);
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