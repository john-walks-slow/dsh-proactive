/**
 * Declared-schedule files: a declarative alarm source synced into the store.
 *
 * A schedule file (convention: `<workspace>/.life/wake_schedule.json`, but any
 * path matched by config.scheduleFiles works) lists desired wake entries; the
 * sync reconciles the store against it — the FILE is the single source of
 * truth. This gives external planners (e.g. a world-master agent writing the
 * file next to events.json) an idempotent, self-healing channel:
 *   - re-runs never duplicate (stable alarm ids derived from file + entry id);
 *   - restarts re-derive everything from the file;
 *   - removed entries / deleted files remove their alarms automatically.
 *
 * Entries reuse the SAME closed alarm dialect as proactive_set (validated via
 * validateCreateArgs + buildAlarm) — there is no second validation dialect.
 * The plugin knows nothing about the file's domain semantics (zero coupling):
 * it only understands the generic alarm projection.
 *
 * Failure semantics: a file that cannot be read or parsed is "broken" — its
 * previously synced alarms are KEPT until the file becomes readable again
 * (a transient read failure must not silently cancel wakes). An entry that
 * exists in a parsed file but fails preparation (bad target, past at, closed
 * validation error) also keeps an existing alarm with its id, so a bad edit
 * degrades to "no change" rather than "alarm deleted".
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord, isToolError, resolveAtInput, type Alarm } from "./domain.js";
import { buildAlarm, validateCreateArgs } from "./alarm-factory.js";
import type { ToolError } from "./domain.js";
import type { ProactiveConfig } from "./config.js";

/** Synthetic owner session for declared alarms (valid session-id shape). */
export const DECLARED_OWNER = "declared-schedule";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_ENTRIES_PER_FILE = 200;
export const MAX_MATCHED_FILES = 64;
const MAX_WALKED_ENTRIES = 20_000;
const MAX_WALK_DEPTH = 16;
/** Keys a schedule file may carry at the top level (besides version/entries). */
const FILE_DEFAULT_KEYS = ["time_zone", "respect_quiet_hours", "jitter_seconds", "compaction", "target"] as const;
/** Keys one entry may carry (selectors + prompt + knobs + nested target). */
const ENTRY_KEYS = [
  "id", "prompt", "at", "after_seconds", "every_seconds", "cron", "jitter_seconds",
  "time_zone", "respect_quiet_hours", "compaction", "target"
] as const;
/** Keys allowed inside a nested `target` object (mirrors the flat target_* dialect). */
const TARGET_KEYS = ["mode", "workspace_path", "workspace_id", "session_id", "preset_id", "provider", "model"] as const;

export interface DeclaredEntry {
  id: string;
  /** Flat proactive_set-dialect args (file defaults merged; target unresolved). */
  args: Record<string, unknown>;
  /** True when neither the entry nor the file named a target: default to the file's own workspace. */
  needsWorkspaceDefault: boolean;
}

export interface ParsedSchedule {
  file: string;
  entries: DeclaredEntry[];
  errors: string[];
  /** True when the file could not be read/interpreted at all (keep current alarms). */
  fatal: boolean;
}

export interface DeclaredSyncSummary {
  matchedFiles: number;
  created: number;
  updated: number;
  removed: number;
  skippedPast: number;
  errors: string[];
  mutated: boolean;
}

export interface DeclaredSyncStore {
  listAlarms(): readonly Alarm[];
  getAlarm(id: string): Alarm | undefined;
  addAlarm(alarm: Alarm): void;
  replaceAlarm(alarm: Alarm): void;
  removeAlarm(id: string): void;
  persist(): Promise<void>;
}

export interface DeclaredSyncDeps {
  config: Pick<ProactiveConfig, "scheduleFiles" | "schedulePollSeconds">;
  store: DeclaredSyncStore;
  now: () => number;
  /**
   * Workspace argument wiring (target_workspace_path -> canonical id), the
   * same service the tools use; absent on hosts without a workspace registry
   * (declared entries then fail closed per entry).
   */
  resolveWorkspace?: (args: Record<string, unknown>, sessionCwd: string | undefined) => Promise<Record<string, unknown> | ToolError>;
  log: (level: "info" | "warn" | "error", message: string) => void;
}

// ---------------------------------------------------------------------------
// glob (minimal, dependency-free: literal path + * within a segment + **
// across segments + ? one non-slash character)
// ---------------------------------------------------------------------------

export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i++;
        // Canonical glob semantics: `**/` spans zero or more whole segments
        // (a/**/b matches a/b too); a bare trailing ** spans anything.
        if (pattern[i + 1] === "/") {
          i++;
          source += "(?:[^/]*/)*";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (c === "?") {
      source += "[^/]";
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(source + "$");
}

/** Expand one pattern into matched file paths (literal paths stat directly). */
async function expandPattern(pattern: string): Promise<string[]> {
  if (!/[*?]/.test(pattern)) {
    try {
      const info = await stat(pattern);
      return info.isFile() ? [pattern] : [];
    } catch {
      return [];
    }
  }
  const magicIndex = pattern.search(/[*?]/);
  const base = pattern.slice(0, pattern.lastIndexOf("/", magicIndex) + 1) || "/";
  const regexp = globToRegExp(pattern);
  const results: string[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || results.length >= MAX_MATCHED_FILES || visited > MAX_WALKED_ENTRIES) return;
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (results.length >= MAX_MATCHED_FILES || visited > MAX_WALKED_ENTRIES) return;
      visited++;
      const full = dir.endsWith("/") ? dir + dirent.name : dir + "/" + dirent.name;
      if (dirent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (dirent.isFile() && regexp.test(full)) {
        results.push(full);
      }
    }
  };
  await walk(base, 0);
  return results;
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

/** Stable JSON stringify (recursively key-sorted) for hashing. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Stable alarm id for one (file, entry) pair — identical across sync passes. */
export function declaredAlarmId(file: string, entryId: string): string {
  return "decl_" + sha256(file + "\u0000" + entryId).slice(0, 16);
}

/** Flatten a nested target object into the flat target_* dialect keys. */
function flattenTarget(target: unknown, label: string): Record<string, unknown> | string {
  if (!isRecord(target)) return label + " must be an object.";
  const flat: Record<string, unknown> = {};
  for (const key of Object.keys(target)) {
    if (!(TARGET_KEYS as readonly string[]).includes(key)) {
      return label + " accepts only " + (TARGET_KEYS as readonly string[]).join(", ") + ".";
    }
    const value = target[key];
    if (key === "mode") {
      if (value !== "resume" && value !== "fork" && value !== "new") return label + ".mode must be resume, fork, or new.";
      flat["target_mode"] = value;
    } else {
      if (typeof value !== "string" || value.length === 0) return label + "." + key + " must be a non-empty string.";
      flat["target_" + key] = value;
    }
  }
  return flat;
}

/**
 * Parse one schedule file's text into declared entries. Each entry becomes a
 * flat args record in the exact proactive_set dialect, with file-level
 * defaults merged in (entry keys win). Target resolution (workspace_path ->
 * canonical id, file-in-own-workspace default) happens later in the sync —
 * this function stays synchronous and pure.
 */
export function parseScheduleFile(file: string, text: string): ParsedSchedule {
  const errors: string[] = [];
  const entries: DeclaredEntry[] = [];
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return { file, entries, errors: [file + ": invalid JSON (" + (error instanceof Error ? error.message : String(error)) + ")"], fatal: true };
  }
  if (!isRecord(document)) return { file, entries, errors: [file + ": top level must be an object."], fatal: true };
  if (document["version"] !== 1) {
    return { file, entries, errors: [file + ': unsupported "version" (expected 1).'], fatal: true };
  }
  if (!Array.isArray(document["entries"])) return { file, entries, errors: [file + ': "entries" must be an array.'], fatal: true };
  const rawDefaults: Record<string, unknown> = {};
  for (const key of Object.keys(document)) {
    if (key === "version" || key === "entries") continue;
    if (!(FILE_DEFAULT_KEYS as readonly string[]).includes(key)) {
      errors.push(file + ": unknown top-level key \"" + key + "\" (allowed: " + [...FILE_DEFAULT_KEYS].join(", ") + ").");
      continue;
    }
    rawDefaults[key] = document[key];
  }
  let fileTarget: Record<string, unknown> | undefined;
  if (rawDefaults["target"] !== undefined) {
    const flat = flattenTarget(rawDefaults["target"], file + ": target");
    if (typeof flat === "string") errors.push(flat);
    else fileTarget = flat;
  }
  const rawEntries = document["entries"] as unknown[];
  if (rawEntries.length > MAX_ENTRIES_PER_FILE) {
    errors.push(file + ": too many entries (" + rawEntries.length + " > " + MAX_ENTRIES_PER_FILE + "); excess dropped.");
    rawEntries.length = MAX_ENTRIES_PER_FILE;
  }
  const seenIds = new Set<string>();
  for (const raw of rawEntries) {
    if (!isRecord(raw)) {
      errors.push(file + ": every entry must be an object.");
      continue;
    }
    const entryId = raw["id"];
    if (typeof entryId !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(entryId)) {
      errors.push(file + ': entry "id" must be 1..100 characters of [A-Za-z0-9._-].');
      continue;
    }
    if (seenIds.has(entryId)) {
      errors.push(file + ": duplicate entry id \"" + entryId + "\".");
      continue;
    }
    seenIds.add(entryId);
    let bad = false;
    for (const key of Object.keys(raw)) {
      if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
        errors.push(file + " [" + entryId + "]: unknown entry key \"" + key + "\".");
        bad = true;
      }
    }
    if (bad) continue;
    // File-level scalar defaults first; the entry's own values win below.
    const args: Record<string, unknown> = {};
    for (const key of ["time_zone", "respect_quiet_hours", "jitter_seconds", "compaction"]) {
      if (rawDefaults[key] !== undefined) args[key] = rawDefaults[key];
    }
    let needsWorkspaceDefault = true;
    if (raw["target"] !== undefined) {
      const flat = flattenTarget(raw["target"], file + " [" + entryId + "]: target");
      if (typeof flat === "string") {
        errors.push(flat);
        continue;
      }
      Object.assign(args, flat);
      // An explicit but empty target object still falls through to the
      // file's own workspace; any named key counts as an explicit target.
      needsWorkspaceDefault = Object.keys(flat).length === 0;
    } else if (fileTarget !== undefined) {
      Object.assign(args, fileTarget);
      needsWorkspaceDefault = false;
    }
    for (const key of ["prompt", "at", "after_seconds", "every_seconds", "cron", "jitter_seconds", "time_zone", "respect_quiet_hours", "compaction"]) {
      if (raw[key] !== undefined) args[key] = raw[key];
    }
    entries.push({ id: entryId, args, needsWorkspaceDefault });
  }
  return { file, entries, errors, fatal: false };
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

async function prepareEntry(deps: DeclaredSyncDeps, parsed: ParsedSchedule, entry: DeclaredEntry): Promise<Record<string, unknown> | string> {
  const args: Record<string, unknown> = { ...entry.args };
  if (entry.needsWorkspaceDefault) {
    if (deps.resolveWorkspace === undefined) {
      return parsed.file + " [" + entry.id + "]: no target given and no workspace registry to default to the file's own workspace.";
    }
    const resolved = await deps.resolveWorkspace({ target_workspace_path: dirname(parsed.file) }, undefined);
    if (isToolError(resolved)) {
      return parsed.file + " [" + entry.id + "]: cannot default to the file's own workspace: " + resolved.message;
    }
    const workspaceId = resolved["target_workspace_id"];
    if (typeof workspaceId !== "string") {
      return parsed.file + " [" + entry.id + "]: cannot default to the file's own workspace (no registry id).";
    }
    args["target_workspace_id"] = workspaceId;
  }
  if (args["target_workspace_path"] !== undefined) {
    if (deps.resolveWorkspace === undefined) {
      return parsed.file + " [" + entry.id + "]: target_workspace_path needs a workspace registry (none on this host).";
    }
    const resolved = await deps.resolveWorkspace(args, undefined);
    if (isToolError(resolved)) return parsed.file + " [" + entry.id + "]: " + resolved.message;
    Object.assign(args, resolved);
  }
  return args;
}

/**
 * One reconciliation pass: read every matched schedule file, diff against the
 * store, apply create/update/remove. Never throws; every failure is logged
 * and reflected in the summary. Returns whether the store mutated so the
 * caller can request a scheduler drive.
 */
export async function syncDeclaredSchedules(deps: DeclaredSyncDeps): Promise<DeclaredSyncSummary> {
  const summary: DeclaredSyncSummary = { matchedFiles: 0, created: 0, updated: 0, removed: 0, skippedPast: 0, errors: [], mutated: false };
  const log = deps.log;
  try {
    const patterns = deps.config.scheduleFiles ?? [];
    const now = deps.now();
    const parsedFiles = new Map<string, ParsedSchedule>();
    const brokenFiles = new Set<string>();
    if (patterns.length > 0) {
      const matched: string[] = [];
      for (const pattern of patterns) {
        for (const file of await expandPattern(pattern)) {
          if (!matched.includes(file)) matched.push(file);
        }
        if (matched.length >= MAX_MATCHED_FILES) {
          log("warn", "declared schedules: more than " + MAX_MATCHED_FILES + " files matched; excess ignored.");
          break;
        }
      }
      summary.matchedFiles = matched.length;
      for (const file of matched) {
        try {
          const info = await stat(file);
          if (!info.isFile() || info.size > MAX_FILE_BYTES) {
            brokenFiles.add(file);
            log("warn", "declared schedules: skipping " + file + " (not a regular file or larger than " + MAX_FILE_BYTES + " bytes).");
            continue;
          }
          const text = await readFile(file, "utf8");
          const parsed = parseScheduleFile(file, text);
          summary.errors.push(...parsed.errors);
          if (parsed.fatal) {
            // A broken file must not nuke its previously synced alarms: keep
            // them until the file parses again.
            brokenFiles.add(file);
            log("warn", "declared schedules: " + file + " could not be parsed; keeping its current alarms.");
            continue;
          }
          parsedFiles.set(file, parsed);
        } catch (error) {
          brokenFiles.add(file);
          log("warn", "declared schedules: failed to read " + file + ": " + (error instanceof Error ? error.message : String(error)));
        }
      }
    }

    // Build the desired set (resolve targets, hash, skip unusable entries).
    const desired = new Map<string, Alarm>();
    /** Entry ids present in a parsed file whose preparation failed: keep an existing alarm. */
    const keptIds = new Set<string>();
    for (const parsed of parsedFiles.values()) {
      for (const entry of parsed.entries) {
        const alarmId = declaredAlarmId(parsed.file, entry.id);
        const prepared = await prepareEntry(deps, parsed, entry);
        if (typeof prepared === "string") {
          summary.errors.push(prepared);
          keptIds.add(alarmId);
          continue;
        }
        const args = prepared;
        // Past one-shot moments never fire late: the file describes desired
        // wakes, and a moment already gone is simply not created. Recurring
        // (cron/every/after) entries always proceed.
        if (args["at"] !== undefined) {
          try {
            const resolvedAt = resolveAtInput(args["at"] as string | { date: string; time: string; time_zone: string });
            if (resolvedAt.epoch <= now) {
              summary.skippedPast++;
              continue;
            }
          } catch (error) {
            summary.errors.push(parsed.file + " [" + entry.id + "]: " + (error instanceof Error ? error.message : String(error)));
            keptIds.add(alarmId);
            continue;
          }
        }
        const shape = validateCreateArgs(args, "");
        if ("code" in shape) {
          summary.errors.push(parsed.file + " [" + entry.id + "]: " + shape.message);
          keptIds.add(alarmId);
          continue;
        }
        const built = buildAlarm(DECLARED_OWNER, shape, now);
        if ("code" in built) {
          summary.errors.push(parsed.file + " [" + entry.id + "]: " + built.message);
          keptIds.add(alarmId);
          continue;
        }
        desired.set(alarmId, {
          ...built.alarm,
          id: alarmId,
          declared: { file: parsed.file, entry: entry.id, hash: sha256(stableStringify(args)) }
        });
      }
    }

    // Apply: create/update what the files declare.
    for (const [alarmId, alarm] of desired) {
      const existing = deps.store.getAlarm(alarmId);
      if (existing !== undefined) {
        if (existing.declared === undefined) {
          log("warn", "declared schedules: alarm id " + alarmId + " already exists as a regular alarm; entry skipped.");
          continue;
        }
        if (existing.status === "in-flight") continue;
        if (existing.declared.hash === alarm.declared?.hash) continue;
        deps.store.replaceAlarm(alarm);
        summary.updated++;
        summary.mutated = true;
      } else {
        deps.store.addAlarm(alarm);
        summary.created++;
        summary.mutated = true;
      }
    }

    // Remove alarms no longer backed by a parsed entry (entry removed, file
    // gone, or feature turned off). Broken files and failed preparations
    // keep their alarms; an in-flight alarm finishes this occurrence first.
    for (const alarm of deps.store.listAlarms()) {
      if (alarm.declared === undefined || alarm.status === "in-flight") continue;
      if (desired.has(alarm.id) || keptIds.has(alarm.id)) continue;
      if (brokenFiles.has(alarm.declared.file)) continue;
      deps.store.removeAlarm(alarm.id);
      summary.removed++;
      summary.mutated = true;
    }

    if (summary.mutated) await deps.store.persist().catch(() => undefined);
    if (summary.created + summary.updated + summary.removed + summary.errors.length > 0) {
      log("info", "declared schedules: +" + summary.created + " ~" + summary.updated + " -" + summary.removed +
        " skippedPast=" + summary.skippedPast + " errors=" + summary.errors.length);
    }
  } catch (error) {
    log("error", "declared schedules: sync pass failed: " + (error instanceof Error ? error.message : String(error)));
  }
  return summary;
}

/**
 * Poll loop over the declared-schedule files. The first pass runs
 * immediately; config is read LIVE each tick (settings-tool updates apply
 * without rebuilding the timer). After a pass that mutated the store, the
 * scheduler is nudged so new due alarms fire without waiting for its timer.
 */
export function startDeclaredScheduleSync(deps: DeclaredSyncDeps & { scheduler: { requestDrive(): void } }): { dispose: () => void; syncOnce: () => Promise<DeclaredSyncSummary> } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  const tick = (): void => {
    chain = chain.then(async () => {
      const summary = await syncDeclaredSchedules(deps);
      if (summary.mutated) deps.scheduler.requestDrive();
    }).catch(() => undefined).finally(() => {
      if (timer !== null) clearTimeout(timer);
      const seconds = Math.max(15, Math.min(3600, deps.config.schedulePollSeconds));
      timer = setTimeout(tick, seconds * 1000);
      timer.unref?.();
    });
  };
  tick();
  return {
    dispose: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    syncOnce: () => syncDeclaredSchedules(deps)
  };
}
