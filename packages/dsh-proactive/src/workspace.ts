/**
 * Workspace target resolution for alarms with target_mode "workspace".
 *
 * Two halves:
 *
 *  create-side wiring (resolveWorkspaceArg) — run BEFORE the closed
 *  validateCreateArgs, mirroring wireTimeZones: the model may name the
 *  workspace by registry id, by absolute path, or not at all (default = the
 *  creator session's own workspace). Everything resolves to a canonical,
 *  existence-checked target_workspace_id so the closed validator only ever
 *  sees one spelling. No auto-create: workspaces are user-managed groupings.
 *
 *  fire-side resolution (resolveWorkspaceWakeTarget / WorkspaceWakePort) —
 *  the destination is derived AT FIRE TIME so it always follows the user's
 *  latest activity:
 *    1. the workspace's most recently UPDATED visible session
 *       (updatedAt = max(createdAt, lastPromptAt), the exact sidebar ordering:
 *       GUI session.list semantics — plugin-source wake messages never move
 *       it, so repeated wakes converge on one session until the user prompts
 *       elsewhere in the workspace);
 *    2. else the workspace's newest BLANK session (the GUI's New Session
 *       slot — dsh-client-runtime connectWorkspace reuses it the same way);
 *    3. else a brand-new session created inside the workspace
 *       (meta.cwd = workspace path, then attachSession).
 *
 *  Subagent-origin sessions and archived sessions are never eligible — the
 *  GUI hides both from the workspace tree, and a wake must never land in a
 *  subagent child.
 */

import * as agentPresetsModule from "@deepseek-ai/dsh-agent-presets";
import { isRecord, isValidWorkspaceId, type ToolError } from "./domain.js";

/** Narrow read of one workspace registry record (dsh-workspace Workspace). */
export interface WorkspaceLike {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  /** Header-validated session account in manual order (activity never reorders). */
  readonly sessionIds: readonly string[];
  status?(): Promise<"ok" | "missing-dir">;
  attachSession?(sessionId: string): Promise<void>;
}

/** Narrow facade over ctx.workspaceRegistry (absent on hosts without dsh-workspace). */
export interface WorkspaceRegistryFacade {
  get(id: string): WorkspaceLike | undefined;
  /** Resolve by canonical directory path without creating; undefined when unowned. */
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>;
  readonly archivedSessionIds: readonly string[];
}

/** Narrow read of one live session from ctx.sessions. */
export interface LiveSessionLike {
  readonly id: string;
  /** dsh ≤0.1.1-rc.2 event log (removed in 0.1.2-rc.1). */
  readonly events?: readonly unknown[];
  /** dsh ≥0.1.2-rc.1 event log snapshot (supersedes `events`). */
  snapshotEvents?(): readonly unknown[];
  readonly header?: { createdAt?: number; cwd?: string; origin?: string; agentPreset?: string };
}

/**
 * Live-session event log across dsh versions: the Session class dropped
 * `.events` in 0.1.2-rc.1 in favor of `snapshotEvents()`. A live session
 * whose log cannot be read folds as blank (a fresh GUI slot) — never as a
 * visible destination.
 */
export function liveEventsOf(live: LiveSessionLike): readonly unknown[] {
  if (Array.isArray(live.events)) return live.events;
  if (typeof live.snapshotEvents === "function") {
    try {
      return live.snapshotEvents();
    } catch {
      return [];
    }
  }
  return [];
}

/** Narrow read of one persisted session header from ctx.sessionPersistence.list(). */
export interface SessionHeaderLike {
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly origin?: string;
  /** Creation-time preset stamp (dsh-session SessionHeader.agentPreset). */
  readonly agentPreset?: string;
  /** Fork children (seeded headers) get no bare-listing projection-cache row. */
  readonly isSeeded?: boolean;
}

/**
 * The session's effective preset id, latest `agent-preset/selected` first,
 * header stamp second. Uses the upstream `resolveSessionPreset` when the
 * installed dsh-agent-presets exports it (0.1.1-rc.2 does); 0.1.2-rc.1
 * REMOVED the export, and a named import would then fail at ESM link time
 * and take the whole plugin tree down — the namespace import lets us fall
 * back to this identical local fold instead. Lives here (not wake.ts) so
 * the preset-source session ranking below shares one fold with the wake
 * composition path; wake.ts re-exports it for source compatibility.
 */
const upstreamResolveSessionPreset = (agentPresetsModule as unknown as { resolveSessionPreset?: (session: { header: { agentPreset?: string }; events: readonly unknown[] }) => string | undefined }).resolveSessionPreset;

export function resolveSessionPresetOf(session: { header: { agentPreset?: string }; events: readonly unknown[] }): string | undefined {
  if (typeof upstreamResolveSessionPreset === "function") return upstreamResolveSessionPreset(session);
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index] as { type?: string; data?: { agentPreset?: string } } | null;
    if (event?.type === "agent-preset/selected") return event.data?.agentPreset;
  }
  return session.header.agentPreset;
}

/** The persisted projection cache row (ctx.sessionProjectionCache.cachedSnapshot). */
export interface ProjectionCacheLike {
  /**
   * The persisted cache read. The host contract (session-controller
   * projectionsFor): the identity needs the durable inherited-event count,
   * which a bare listed header does not carry — seeded (fork) headers are
   * therefore skipped (no cache row), unseeded ones always key at 0.
   */
  cachedSnapshot(meta: SessionHeaderLike, inheritedEventCount: 0): { values?: { sessionListMetadata?: { blank: boolean; lastPromptAt: number | null } } } | undefined;
}

/** Inputs the create-side resolver needs from the host. */
export interface WorkspaceArgDeps {
  registry: WorkspaceRegistryFacade;
  /** Creator session cwd (the default-workspace arm); absent when unknown. */
  sessionCwd?: string;
}

/**
 * Normalize the workspace argument root before the closed validation:
 *   target_workspace_id  -> validated existence, passed through
 *   target_workspace_path-> resolved through the registry (realpath canon)
 *   neither              -> resolved from the creator session's cwd
 * The output always carries a canonical target_workspace_id (or a closed
 * ToolError); the path key is stripped so validateCreateArgs never sees it.
 */
/** resolveByPath wrapper: a missing directory rejects inside its realpath — fold that into the closed not_found. */
async function resolveWorkspaceByPath(deps: WorkspaceArgDeps, path: string, missMessage: (path: string) => string): Promise<WorkspaceLike | ToolError> {
  try {
    const workspace = await deps.registry.resolveByPath(path);
    return workspace === undefined ? { code: "not_found", message: missMessage(path) } : workspace;
  } catch (error) {
    // dsh-workspace's resolveByPath realpaths the directory: ENOENT (deleted
    // since registration) surfaces as a throw, not undefined.
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT|no such file|missing/i.test(message)) {
      return { code: "not_found", message: "path " + path + " does not exist or is not registered as a workspace (register the directory in the GUI sidebar first)." };
    }
    return { code: "not_found", message: "workspace lookup failed for path " + path + ": " + message };
  }
}

export async function resolveWorkspaceArg(args: Record<string, unknown>, deps: WorkspaceArgDeps): Promise<Record<string, unknown> | ToolError> {
  const id = args["target_workspace_id"];
  const path = args["target_workspace_path"];
  const count = Number(id !== undefined) + Number(path !== undefined);
  if (count > 1) return { code: "invalid_trigger", message: "pass at most one of target_workspace_id, target_workspace_path." };
  let workspace: WorkspaceLike | undefined;
  if (id !== undefined) {
    if (typeof id !== "string" || !isValidWorkspaceId(id)) {
      return { code: "invalid_trigger", message: "target_workspace_id must be a workspace registry id (uuid)." };
    }
    workspace = deps.registry.get(id);
    if (workspace === undefined) {
      return { code: "not_found", message: "workspace " + id + " does not exist (it may have been deleted in the GUI)." };
    }
  } else if (path !== undefined) {
    if (typeof path !== "string" || path.trim() === "" || path.includes("\0")) {
      return { code: "invalid_trigger", message: "target_workspace_path must be a non-empty absolute directory path." };
    }
    const resolved = await resolveWorkspaceByPath(deps, path, (p) => "no workspace is registered for path " + p + " (register the directory as a workspace in the GUI sidebar first).");
    if ("code" in resolved) return resolved;
    workspace = resolved;
  } else {
    if (deps.sessionCwd === undefined || deps.sessionCwd === "") {
      return { code: "invalid_trigger", message: "target_mode workspace requires target_workspace_id or target_workspace_path (this session has no cwd to derive one)." };
    }
    const resolved = await resolveWorkspaceByPath(deps, deps.sessionCwd, (p) => "no workspace is registered for this session's directory (" + p + "); pass target_workspace_id or target_workspace_path.");
    if ("code" in resolved) return resolved;
    workspace = resolved;
  }
  const next: Record<string, unknown> = { ...args };
  delete next["target_workspace_path"];
  next["target_workspace_id"] = workspace.id;
  return next;
}

/**
 * Session-list metadata fold, mirrored from the host's session.list
 * projection (dsh-api-session-controller applySessionListMetadata): blank
 * flips to false on the first turn/start; lastPromptAt tracks the latest
 * human-authored user/message. The event `time` lives at the TOP level of a
 * SessionEvent (`{type, seq, time, data}`) — `data` carries only
 * `{content, id, role, source}` — and the host folds last-wins (not max).
 * Wake framing is a plugin-source notice, so a proactive wake never moves
 * lastPromptAt.
 */
export function listMetadataOf(events: readonly unknown[]): { blank: boolean; lastPromptAt: number | null } {
  let blank = true;
  let lastPromptAt: number | null = null;
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event["type"] === "turn/start") blank = false;
    if (event["type"] === "user/message") {
      const data = event["data"];
      const source = isRecord(data) ? data["source"] : undefined;
      const time = event["time"];
      if (isRecord(source) && source["kind"] === "user" && typeof time === "number") {
        lastPromptAt = time;
      }
    }
  }
  return { blank, lastPromptAt };
}

/** The sidebar's updatedAt: the later of creation and the latest human prompt. */
export function updatedAtOf(createdAt: number, metadata: { lastPromptAt: number | null } | undefined): number {
  return Math.max(createdAt, metadata?.lastPromptAt ?? 0);
}

/** One ranked workspace session candidate (live or cold). */
export interface WorkspaceCandidate {
  sessionId: string;
  /** Sidebar recency key: max(createdAt, lastPromptAt). */
  updatedAt: number;
  createdAt: number;
  /** Never had a turn (GUI hides these; they are the New Session slots). */
  blank: boolean;
  /** Subagent children are never eligible wake destinations. */
  subagent: boolean;
}

export type WorkspacePick =
  | { kind: "session"; sessionId: string }
  | { kind: "create" };

/** Deterministic recency comparison: updatedAt, then createdAt, then id. */
function moreRecent(left: WorkspaceCandidate, right: WorkspaceCandidate): number {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt;
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
}

/**
 * The fire-time destination, mirroring the GUI workspace tree + New Session:
 * the topmost VISIBLE (non-blank, non-subagent) row by recency; else the
 * newest blank row (the New Session slot, connectWorkspace-style); else
 * "create" (a fresh session attached to the workspace).
 */
export function pickWorkspaceTarget(candidates: readonly WorkspaceCandidate[]): WorkspacePick {
  const eligible = candidates.filter((candidate) => !candidate.subagent);
  const visible = eligible.filter((candidate) => !candidate.blank);
  let best: WorkspaceCandidate | undefined;
  for (const candidate of visible.length > 0 ? visible : eligible) {
    if (best === undefined || moreRecent(candidate, best) > 0) best = candidate;
  }
  return best === undefined ? { kind: "create" } : { kind: "session", sessionId: best.sessionId };
}

/** Where a workspace wake should land, resolved at fire time. */
export type WorkspaceWakeDestination =
  | { kind: "session"; sessionId: string }
  | { kind: "create"; cwd: string };

/** Inputs the fire-side resolver needs from the host. */
export interface WorkspaceWakeDeps {
  registry: WorkspaceRegistryFacade;
  /** Live in-memory session store (ctx.sessions). */
  liveSessions(): readonly LiveSessionLike[];
  /** Cold session headers (ctx.sessionPersistence.list); absent on headless hosts. */
  coldHeaders?(): Promise<readonly SessionHeaderLike[]>;
  /** Persisted projection cache rows (ctx.sessionProjectionCache). */
  projectionCache?: ProjectionCacheLike;
  log: (level: "info" | "warn" | "error", message: string) => void;
}

/** Resolve the workspace itself; a closed error string when it vanished. */
async function requireWorkspace(deps: WorkspaceWakeDeps, workspaceId: string): Promise<WorkspaceLike | { error: string }> {
  const workspace = deps.registry.get(workspaceId);
  if (workspace === undefined) {
    return { error: "workspace " + workspaceId + " no longer exists (deleted in the GUI?); cancel or edit this alarm" };
  }
  return workspace;
}

/**
 * Fire-time destination: rank the workspace's sessions (live fold first,
 * cold projection-cache row second — both are the exact sources the GUI's
 * session.list uses) and pick per {@link pickWorkspaceTarget}. The "create"
 * arm additionally verifies the workspace directory still exists: a wake must
 * not mkdir a ghost directory as a side effect.
 */
export async function resolveWorkspaceWakeTarget(deps: WorkspaceWakeDeps, workspaceId: string): Promise<WorkspaceWakeDestination | { error: string }> {
  const workspace = await requireWorkspace(deps, workspaceId);
  if ("error" in workspace) return workspace;
  const archived = new Set(deps.registry.archivedSessionIds);
  const liveById = new Map<string, LiveSessionLike>();
  for (const session of deps.liveSessions()) liveById.set(session.id, session);
  const coldById = new Map<string, SessionHeaderLike>();
  let coldListFailed = false;
  if (deps.coldHeaders !== undefined) {
    try {
      for (const header of await deps.coldHeaders()) coldById.set(header.id, header);
    } catch (error) {
      // A persistence listing failure must not turn into "no sessions":
      // rank from the live store only — but remember it, so an empty result
      // below can fail loudly instead of creating a duplicate session.
      coldListFailed = true;
      deps.log("warn", "workspace wake: cold session listing failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  const candidates: WorkspaceCandidate[] = [];
  for (const sessionId of workspace.sessionIds) {
    if (archived.has(sessionId)) continue;
    const live = liveById.get(sessionId);
    if (live !== undefined) {
      const header = live.header;
      const metadata = listMetadataOf(liveEventsOf(live));
      candidates.push({
        sessionId,
        updatedAt: updatedAtOf(header?.createdAt ?? 0, metadata),
        createdAt: header?.createdAt ?? 0,
        blank: metadata.blank,
        subagent: header?.origin === "subagent"
      });
      continue;
    }
    const header = coldById.get(sessionId);
    if (header === undefined) continue; // neither live nor materialized: not a real destination
    // The sidebar fold's exact cold read (projectionsFor): seeded (fork)
    // headers carry no durable inherited count in a bare listing, so they get
    // no cache row; unseeded ones key at 0.
    const metadata = header.isSeeded === true
      ? undefined
      : deps.projectionCache?.cachedSnapshot(header, 0)?.values?.sessionListMetadata;
    candidates.push({
      sessionId,
      updatedAt: updatedAtOf(header.createdAt, metadata),
      createdAt: header.createdAt,
      // No cache row (checkpoint never written / host without the cache):
      // conservatively visible — never skip a real conversation.
      blank: metadata?.blank === true,
      subagent: header.origin === "subagent"
    });
  }
  const pick = pickWorkspaceTarget(candidates);
  if (pick.kind === "session") return pick;
  if (coldListFailed) {
    // All-cold workspace + transient persistence failure: "no candidates"
    // is unproven here — fail into the retry path rather than creating a
    // session that would duplicate one we could not see.
    return { error: "cold session listing failed; cannot safely pick or create a destination (will retry)" };
  }
  if (typeof workspace.status === "function") {
    const status = await workspace.status();
    if (status === "missing-dir") {
      return { error: "workspace directory is missing: " + workspace.path + " (restore the directory or edit this alarm)" };
    }
  }
  return { kind: "create", cwd: workspace.path };
}

/** The driver-facing port: resolve at fire time + attach created sessions. */
export interface WorkspaceWakePort {
  resolveTarget(workspaceId: string): Promise<WorkspaceWakeDestination | { error: string }>;
  attach(workspaceId: string, sessionId: string): Promise<void>;
  /**
   * Canonical directory path for creating a session inside the workspace
   * (target_mode new with a configured workspace). Same missing-dir guard
   * as the create arm of resolveTarget: a wake must never mkdir a ghost
   * directory as a side effect.
   */
  cwdOf(workspaceId: string): Promise<string | { error: string }>;
}

/** Assemble the driver-facing port from host-level deps (index.ts wiring). */
export function createWorkspaceWakePort(deps: WorkspaceWakeDeps): WorkspaceWakePort {
  return {
    resolveTarget: (workspaceId) => resolveWorkspaceWakeTarget(deps, workspaceId),
    async attach(workspaceId, sessionId) {
      const workspace = await requireWorkspace(deps, workspaceId);
      if ("error" in workspace) throw new Error(workspace.error);
      if (typeof workspace.attachSession !== "function") {
        throw new Error("workspace " + workspaceId + " exposes no attachSession (registry contract drift)");
      }
      await workspace.attachSession(sessionId);
    },
    async cwdOf(workspaceId) {
      const workspace = await requireWorkspace(deps, workspaceId);
      if ("error" in workspace) return workspace;
      if (typeof workspace.status === "function") {
        const status = await workspace.status();
        if (status === "missing-dir") {
          return { error: "workspace directory is missing: " + workspace.path + " (restore the directory or edit this alarm)" };
        }
      }
      return workspace.path;
    }
  };
}

/**
 * Fire-time destination for a preset-sourced target: the most recently
 * updated session RUNNING that preset, or "none" when no eligible session
 * exists. Unlike the workspace resolver there is no create arm here — the
 * caller decides what "none" means (resume creates a fresh session on the
 * preset; fork fails closed).
 */
export type PresetWakeDestination =
  | { kind: "session"; sessionId: string }
  | { kind: "none" };

/** Inputs the preset-source resolver needs from the host. */
export interface PresetWakeDeps {
  /** Live in-memory session store (ctx.sessions). */
  liveSessions(): readonly LiveSessionLike[];
  /** Cold session headers (ctx.sessionPersistence.list); absent on headless hosts. */
  coldHeaders?(): Promise<readonly SessionHeaderLike[]>;
  /** Persisted projection cache rows (ctx.sessionProjectionCache). */
  projectionCache?: ProjectionCacheLike;
  /** Archived-session exclusion (registry-backed; absent = no registry, nothing to exclude). */
  archivedSessionIds?(): readonly string[];
  log: (level: "info" | "warn" | "error", message: string) => void;
}

/**
 * Rank every session running the preset and pick the same way the workspace
 * resolver does (visible first, sidebar recency, subagent/archived never).
 *
 * Preset matching: a LIVE session folds its effective preset (latest
 * `agent-preset/selected` event, header stamp second — the exact fold the
 * wake composition uses); a COLD session only carries its creation-time
 * header stamp, the same limitation the sidebar's cold rows have.
 */
export async function resolvePresetWakeTarget(deps: PresetWakeDeps, presetId: string): Promise<PresetWakeDestination | { error: string }> {
  const archived = new Set(deps.archivedSessionIds?.() ?? []);
  const liveById = new Map<string, LiveSessionLike>();
  for (const session of deps.liveSessions()) liveById.set(session.id, session);
  const coldById = new Map<string, SessionHeaderLike>();
  let coldListFailed = false;
  if (deps.coldHeaders !== undefined) {
    try {
      for (const header of await deps.coldHeaders()) coldById.set(header.id, header);
    } catch (error) {
      // Same conservative rule as the workspace resolver: a failed cold
      // listing must not fold into "no sessions" — remember it so an empty
      // result fails into the retry path instead of a wrong decision.
      coldListFailed = true;
      deps.log("warn", "preset wake: cold session listing failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  const candidates: WorkspaceCandidate[] = [];
  for (const live of liveById.values()) {
    if (archived.has(live.id)) continue;
    const header = live.header;
    if (header?.origin === "subagent") continue;
    const events = liveEventsOf(live);
    if (resolveSessionPresetOf({ header: header ?? {}, events }) !== presetId) continue;
    const metadata = listMetadataOf(events);
    candidates.push({
      sessionId: live.id,
      updatedAt: updatedAtOf(header?.createdAt ?? 0, metadata),
      createdAt: header?.createdAt ?? 0,
      blank: metadata.blank,
      subagent: false
    });
  }
  for (const header of coldById.values()) {
    if (liveById.has(header.id)) continue;
    if (archived.has(header.id)) continue;
    if (header.origin === "subagent") continue;
    if (header.agentPreset !== presetId) continue;
    // The sidebar fold's exact cold read: seeded (fork) headers carry no
    // cache row; a missing row is conservatively visible.
    const metadata = header.isSeeded === true
      ? undefined
      : deps.projectionCache?.cachedSnapshot(header, 0)?.values?.sessionListMetadata;
    candidates.push({
      sessionId: header.id,
      updatedAt: updatedAtOf(header.createdAt, metadata),
      createdAt: header.createdAt,
      blank: metadata?.blank === true,
      subagent: false
    });
  }
  if (candidates.length === 0) {
    if (coldListFailed) {
      return { error: "cold session listing failed; cannot safely pick a preset destination (will retry)" };
    }
    return { kind: "none" };
  }
  const pick = pickWorkspaceTarget(candidates);
  return pick.kind === "session" ? pick : { kind: "none" };
}

/** The driver-facing port for preset-sourced targets. */
export interface PresetWakePort {
  resolveTarget(presetId: string): Promise<PresetWakeDestination | { error: string }>;
}

/** Assemble the preset-source port from host-level deps (index.ts wiring). */
export function createPresetWakePort(deps: PresetWakeDeps): PresetWakePort {
  return {
    resolveTarget: (presetId) => resolvePresetWakeTarget(deps, presetId)
  };
}
