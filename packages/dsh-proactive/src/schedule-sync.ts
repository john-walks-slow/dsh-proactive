/**
 * Schedule-file reconciliation + poll loop (261009, replacing declared.ts).
 *
 * The store's "file" alarms are subscription HANDLES: each points at one
 * absolute schedule file and owns the child alarms generated from it. One
 * reconciliation pass, per handle:
 *
 *   read the file  ──►  entry set  ──►  child alarm set  ──►  diff the store
 *
 * Semantics:
 *   - FILE = source of truth for its entries: a removed entry removes its
 *     child; a deleted file revokes the whole plan (children removed).
 *   - HANDLE = source of truth for the subscription's existence: a file that
 *     cannot be read or parsed keeps its children (a transient failure must
 *     never cancel wakes), and a paused/deleted handle drops them.
 *   - a changed entry hash replaces the child; an unchanged hash is a total
 *     no-op (it must not disturb jitter anchors or a min_idle deferral).
 *   - children whose `declared.sourceId` no longer names an ACTIVE handle are
 *     orphans and are removed (this is also the 260918 migration path).
 *
 * Concurrency: every pass goes through ONE serialized chain (`enqueueSync`),
 * so the tools/panel can request an immediate pass without racing the poll
 * tick into duplicate alarms. The apply phase itself is synchronous, and it
 * re-checks the handle before writing — a cancel/pause that lands during the
 * (awaited) entry preparation can never resurrect a child alarm.
 */

import { readFile, stat } from "node:fs/promises";
import {
  DEFAULT_COMPACTION,
  instantEpoch,
  isRecord,
  isToolError,
  resolveAtInput,
  targetArgsOf,
  validatePrompt,
  type AtInput,
  type Alarm,
  type ToolError
} from "./domain.js";
import { buildAlarm, validateCreateArgs } from "./alarm-factory.js";
import { MAX_FILE_BYTES, declaredAlarmId, parseScheduleFile, sha256, stableStringify, type DeclaredEntry, type WorkspaceResolver } from "./schedule-file.js";
import type { ProactiveConfig } from "./config.js";

const MAX_REPORTED_ERRORS = 20;
/**
 * The synthetic owner every pre-261009 declared alarm carries (see 260918).
 * It is what makes an id-matching record ADOPTABLE during the upgrade: the
 * child id is derived from (file, entry), so a record with a child id and
 * this owner can only have come from the declared-schedule machinery — a
 * user alarm never gets such an id.
 */
const LEGACY_DECLARED_OWNER = "declared-schedule";

export interface SyncSummary {
  /** Instant of the pass (epoch ms). */
  lastAt: number;
  /** Active file handles examined. */
  handles: number;
  created: number;
  updated: number;
  removed: number;
  skippedPast: number;
  /** Entry-level failures (bad spec / unresolvable target / past at), newest last. */
  errors: string[];
  mutated: boolean;
}

export interface ScheduleSyncStore {
  listAlarms(): readonly Alarm[];
  getAlarm(id: string): Alarm | undefined;
  addAlarm(alarm: Alarm): void;
  replaceAlarm(alarm: Alarm): void;
  removeAlarm(id: string): Alarm | undefined;
  persist(): Promise<void>;
}

export interface ScheduleSyncDeps {
  config: Pick<ProactiveConfig, "schedulePollSeconds">;
  store: ScheduleSyncStore;
  now: () => number;
  /**
   * Create-side workspace argument wiring, for entries that name
   * `target.workspace_path`. Absent on hosts without a workspace registry:
   * such entries fail closed and keep their current child alarm.
   */
  resolveWorkspace?: WorkspaceResolver;
  log: (level: "info" | "warn" | "error", message: string) => void;
}

export interface ScheduleSyncHandle {
  dispose(): void;
  /** Request a pass and await ITS result (serialized with the poll tick). */
  enqueueSync(): Promise<SyncSummary>;
  lastSummary(): SyncSummary | undefined;
}

function emptySummary(now: number): SyncSummary {
  return { lastAt: now, handles: 0, created: 0, updated: 0, removed: 0, skippedPast: 0, errors: [], mutated: false };
}

/** The literal file path of a handle, or undefined when the trigger is corrupt. */
function fileOf(handle: Alarm): string | undefined {
  if (!isRecord(handle.trigger) || !("file" in handle.trigger)) return undefined;
  const file = handle.trigger.file;
  return typeof file === "string" && file.length > 0 ? file : undefined;
}

function positiveSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * The handle's own fields become the LOWEST explicit default layer for its
 * children (below the file's top level and the entry itself). Only the
 * orthogonal keys are inherited; `target` is picked whole by the entry/file
 * layer, never merged key-wise.
 */
function handleDefaults(handle: Alarm, entry: DeclaredEntry): Record<string, unknown> {
  const jitter = positiveSeconds(isRecord(handle.trigger) ? handle.trigger["jitterSeconds"] : undefined);
  const minIdle = positiveSeconds(handle.minIdleSeconds);
  return {
    prompt: handle.prompt,
    time_zone: handle.timeZone,
    respect_quiet_hours: handle.respectQuietHours,
    compaction: handle.compaction ?? DEFAULT_COMPACTION,
    ...(minIdle !== undefined ? { min_idle_seconds: minIdle } : {}),
    ...(jitter !== undefined ? { jitter_seconds: jitter } : {}),
    ...entry.args
  };
}

/** One entry's flat args, with workspace_path targets resolved to a registry id. */
async function composeEntryArgs(deps: ScheduleSyncDeps, handle: Alarm, entry: DeclaredEntry): Promise<Record<string, unknown> | ToolError> {
  // Whole-layer target selection: the entry's (or the file's) target wins
  // entirely, otherwise the handle's own target is projected as-is.
  const target = entry.target ?? targetArgsOf(handle.target);
  const args: Record<string, unknown> = { ...handleDefaults(handle, entry), ...target };
  if (args["target_workspace_path"] !== undefined) {
    if (deps.resolveWorkspace === undefined) {
      return { code: "not_found", message: "target.workspace_path needs a workspace registry (none on this host)." };
    }
    const resolved = await deps.resolveWorkspace(args, undefined);
    if (isToolError(resolved)) return resolved;
    delete args["target_workspace_path"];
    Object.assign(args, resolved);
  }
  return args;
}

export async function syncScheduleFiles(deps: ScheduleSyncDeps): Promise<SyncSummary> {
  const summary = emptySummary(deps.now());
  const log = deps.log;
  try {
    const handles = deps.store.listAlarms().filter((alarm) => alarm.type === "file" && alarm.status === "scheduled");
    summary.handles = handles.length;
    const activeHandleIds = new Set(handles.map((handle) => handle.id));
    /** Handles whose file is unreadable/unparsable this pass: keep their children. */
    const brokenHandleIds = new Set<string>();
    const desired = new Map<string, Alarm>();
    /** Entry ids present in a parsed file whose preparation failed: keep the existing child. */
    const keptIds = new Set<string>();

    for (const handle of handles) {
      const file = fileOf(handle);
      if (file === undefined) {
        log("warn", "schedule files: handle " + handle.id + " has a corrupt trigger; skipped.");
        brokenHandleIds.add(handle.id);
        continue;
      }
      let text: string;
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) {
          log("warn", "schedule files: " + file + " is not a regular file or is larger than " + MAX_FILE_BYTES + " bytes; keeping its current alarms.");
          brokenHandleIds.add(handle.id);
          continue;
        }
        text = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          // The file is gone: the plan is revoked, its children go with it
          // (the handle itself stays — it is the subscription).
          continue;
        }
        log("warn", "schedule files: failed to read " + file + ": " + (error instanceof Error ? error.message : String(error)) + "; keeping its current alarms.");
        brokenHandleIds.add(handle.id);
        continue;
      }
      const parsed = parseScheduleFile(file, text);
      for (const error of parsed.errors) summary.errors.push(error);
      if (parsed.fatal) {
        // A broken file must not nuke its previously synced alarms.
        log("warn", "schedule files: " + file + " could not be parsed; keeping its current alarms.");
        brokenHandleIds.add(handle.id);
        continue;
      }
      for (const entry of parsed.entries) {
        const alarmId = declaredAlarmId(file, entry.id);
        const prepared = await composeEntryArgs(deps, handle, entry);
        if (isToolError(prepared)) {
          summary.errors.push(file + " [" + entry.id + "]: " + prepared.message);
          keptIds.add(alarmId);
          continue;
        }
        const args = prepared;
        let prompt: string;
        try {
          prompt = validatePrompt(args["prompt"]);
        } catch (error) {
          summary.errors.push(file + " [" + entry.id + "]: " + (error instanceof Error ? error.message : String(error)));
          keptIds.add(alarmId);
          continue;
        }
        args["prompt"] = prompt;
        // Past one-shot moments never fire late: the file describes desired
        // wakes, and a moment already gone is simply not created. Recurring
        // (cron/every/after) entries always proceed.
        const now = deps.now();
        if (args["at"] !== undefined) {
          try {
            if (resolveAtInput(args["at"] as AtInput).epoch <= now) {
              summary.skippedPast++;
              continue;
            }
          } catch (error) {
            summary.errors.push(file + " [" + entry.id + "]: " + (error instanceof Error ? error.message : String(error)));
            keptIds.add(alarmId);
            continue;
          }
        }
        const shape = validateCreateArgs(args, "");
        if (isToolError(shape)) {
          summary.errors.push(file + " [" + entry.id + "]: " + shape.message);
          keptIds.add(alarmId);
          continue;
        }
        const built = buildAlarm(handle.ownerSessionId, shape, now);
        if (isToolError(built)) {
          summary.errors.push(file + " [" + entry.id + "]: " + built.message);
          keptIds.add(alarmId);
          continue;
        }
        desired.set(alarmId, {
          ...built.alarm,
          id: alarmId,
          declared: { file, entry: entry.id, hash: sha256(stableStringify(args)), sourceId: handle.id }
        });
      }
    }

    // Apply. This loop is synchronous: the only await window was the entry
    // preparation above, so re-reading the handle here is enough to make a
    // concurrent cancel/pause win over a stale wish list.
    for (const [alarmId, alarm] of desired) {
      const sourceId = alarm.declared?.sourceId;
      const handle = sourceId === undefined ? undefined : deps.store.getAlarm(sourceId);
      if (sourceId === undefined || handle === undefined || handle.status !== "scheduled" || handle.type !== "file") {
        const why = sourceId === undefined ? "no owner handle" : handle === undefined ? "handle vanished" : "handle is " + handle.status;
        // Surfaced in summary.errors as well: the panel snapshot is the only
        // durable trace of a skipped creation (cordis warn is not persisted).
        summary.errors.push("entry " + String(alarm.declared?.entry) + " skipped: " + why + " during the sync.");
        log("warn", "schedule files: handle for " + alarmId + " disappeared or was paused during the sync; not creating it.");
        continue;
      }
      const existing = deps.store.getAlarm(alarmId);
      if (existing !== undefined) {
        // A pre-261009 record has no `sourceId` (and the earliest ones have no
        // `declared` provenance at all): the same (file, entry) still derives
        // the same id, so it is ADOPTED — re-pointed at the handle instead of
        // being dropped and re-created (which would have lost its history).
        const adoptable = existing.declared !== undefined || existing.ownerSessionId === LEGACY_DECLARED_OWNER;
        if (!adoptable) {
          log("warn", "schedule files: alarm id " + alarmId + " already exists as a regular alarm; entry skipped.");
          continue;
        }
        if (existing.status === "in-flight") continue;
        const unchanged = existing.declared !== undefined &&
          existing.declared.hash === alarm.declared?.hash &&
          existing.declared.sourceId === alarm.declared?.sourceId;
        if (unchanged) continue;
        deps.store.replaceAlarm(alarm);
        summary.updated++;
        summary.mutated = true;
      } else {
        deps.store.addAlarm(alarm);
        summary.created++;
        summary.mutated = true;
      }
    }

    // Remove: children whose handle is gone/inactive are orphans (this also
    // cleans up pre-261009 records, which carry no sourceId), and children no
    // longer backed by a parsed entry go too. Broken files and failed entries
    // keep their alarms; an in-flight alarm finishes its occurrence first.
    for (const alarm of [...deps.store.listAlarms()]) {
      const declared = alarm.declared;
      if (declared === undefined || alarm.status === "in-flight") continue;
      // Backed by a parsed entry in THIS pass (created, adopted or kept):
      // never remove it below, whatever its (possibly stale) sourceId says.
      if (desired.has(alarm.id) || keptIds.has(alarm.id)) continue;
      const sourceId = declared.sourceId;
      const handleActive = sourceId !== undefined && activeHandleIds.has(sourceId);
      if (!handleActive) {
        deps.store.removeAlarm(alarm.id);
        summary.removed++;
        summary.mutated = true;
        continue;
      }
      if (brokenHandleIds.has(sourceId)) continue;
      deps.store.removeAlarm(alarm.id);
      summary.removed++;
      summary.mutated = true;
    }

    // Derived display value: the earliest child wake. With no candidates the
    // previous value is kept (rewriting it every pass would churn the store).
    for (const handle of handles) {
      const candidates = deps.store.listAlarms().filter((alarm) =>
        alarm.declared?.sourceId === handle.id && (alarm.status === "scheduled" || alarm.status === "in-flight"));
      if (candidates.length === 0) continue;
      const earliest = Math.min(...candidates.map((alarm) => instantEpoch(alarm.nextDueAt)));
      if (!Number.isFinite(earliest)) continue;
      const nextDueAt = new Date(earliest).toISOString();
      const fresh = deps.store.getAlarm(handle.id);
      if (fresh === undefined || fresh.nextDueAt === nextDueAt) continue;
      deps.store.replaceAlarm({ ...fresh, nextDueAt });
      summary.mutated = true;
    }

    if (summary.mutated) await deps.store.persist().catch(() => undefined);
    // Per-entry failures must be visible, not just counted: cordis info/warn
    // is not persisted anywhere, so the summary (surfaced through the panel
    // snapshot) is the only durable-ish trace of WHICH entry dropped and why.
    for (const error of summary.errors.slice(0, MAX_REPORTED_ERRORS)) {
      log("warn", "schedule files: " + error);
    }
    if (summary.created + summary.updated + summary.removed + summary.errors.length > 0) {
      log("info", "schedule files: handles=" + summary.handles + " +" + summary.created + " ~" + summary.updated + " -" + summary.removed +
        " skippedPast=" + summary.skippedPast + " errors=" + summary.errors.length);
    }
  } catch (error) {
    log("error", "schedule files: sync pass failed: " + (error instanceof Error ? error.message : String(error)));
  }
  summary.lastAt = deps.now();
  return summary;
}

/**
 * Poll loop over the schedule files. The first pass runs immediately; every
 * pass — the tick's and the tools'/panel's immediate requests — goes through
 * ONE serialized chain, so two passes can never interleave into duplicate
 * alarms. A pass that mutated the store nudges the scheduler.
 */
export function startScheduleSync(deps: ScheduleSyncDeps & { scheduler: { requestDrive(): void } }): ScheduleSyncHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let chain: Promise<unknown> = Promise.resolve();
  let last: SyncSummary | undefined;

  const enqueueSync = (): Promise<SyncSummary> => {
    const run = chain.then(() => syncScheduleFiles(deps), () => syncScheduleFiles(deps));
    chain = run.then(() => undefined, () => undefined);
    return run.then((summary) => {
      last = summary;
      if (summary.mutated) deps.scheduler.requestDrive();
      return summary;
    });
  };

  const tick = (): void => {
    void enqueueSync().catch(() => undefined).finally(() => {
      if (disposed) return;
      const seconds = Math.max(15, Math.min(3600, deps.config.schedulePollSeconds));
      timer = setTimeout(tick, seconds * 1000);
      timer.unref?.();
    });
  };
  tick();

  return {
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    enqueueSync,
    lastSummary: () => last
  };
}
