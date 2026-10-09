/**
 * Schedule-file format + path helpers for the "file" alarm type (261009).
 *
 * A schedule file (convention: `<workspace>/.life/wake_schedule.json`) lists
 * desired wake entries. It is owned by exactly one file-handle alarm, which
 * points at ONE literal absolute path (no globs) — the FILE is the single
 * source of truth for its entries, and the handle is the single source of
 * truth for the subscription's existence (a missing/empty/all-invalid file
 * never makes the subscription disappear silently).
 *
 * This module is pure plus a little filesystem work (canonicalization); the
 * reconciliation itself lives in schedule-sync.ts.
 *
 * Entry parameters are layered, with an important asymmetry:
 *   - `target` picks ONE layer whole (entry > file top level > handle):
 *     target keys are NOT orthogonal (mode + which id goes with it), so a
 *     key-wise merge can synthesize a combination no layer ever meant — that
 *     is the 260928 residual-key failure class.
 *   - every other key is orthogonal and merges key-wise
 *     (entry > file top level > handle > dialect default).
 */

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isRecord, isToolError, toAlarmView, type Alarm, type AlarmView, type ToolError } from "./domain.js";

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_ENTRIES_PER_FILE = 200;

/** Keys a schedule file may carry at the top level (besides version/entries). */
const FILE_DEFAULT_KEYS = ["time_zone", "respect_quiet_hours", "jitter_seconds", "compaction", "min_idle_seconds", "target"] as const;
/** Keys one entry may carry (selectors + prompt + knobs + nested target). */
const ENTRY_KEYS = [
  "id", "prompt", "at", "after_seconds", "every_seconds", "cron", "jitter_seconds",
  "time_zone", "respect_quiet_hours", "compaction", "min_idle_seconds", "target"
] as const;
/** Keys allowed inside a nested `target` object (mirrors the flat target_* dialect). */
const TARGET_KEYS = ["mode", "workspace_path", "workspace_id", "session_id", "preset_id", "provider", "model"] as const;
/** Scalar entry/file defaults (target is handled separately: whole-layer selection). */
const SCALAR_KEYS = ["time_zone", "respect_quiet_hours", "jitter_seconds", "compaction", "min_idle_seconds"] as const;
/** Entry-only keys copied verbatim: the prompt and the four firing selectors. */
const ENTRY_SCALAR_KEYS = ["prompt", "at", "after_seconds", "every_seconds", "cron", ...SCALAR_KEYS] as const;

export interface DeclaredEntry {
  id: string;
  /** Flat scalar args: file-level defaults merged with the entry's own values (entry wins). */
  args: Record<string, unknown>;
  /** Flat target_* args of the winning layer (entry target > file-level target); absent = inherit the handle's target. */
  target?: Record<string, unknown>;
}

export interface ParsedSchedule {
  file: string;
  entries: DeclaredEntry[];
  errors: string[];
  /** True when the file could not be read/interpreted at all (keep current alarms). */
  fatal: boolean;
}

/**
 * Canonical spelling of one schedule file: absolute, no trailing slash, and
 * with the directory's symlinks folded when it exists. The canonical form is
 * what gets STORED and what feeds child alarm ids, so two spellings of the
 * same physical file can never become two handles with two id families
 * (which would fire every occurrence twice).
 */
export async function canonicalizeScheduleFile(file: string): Promise<string> {
  const absolute = resolve(file);
  const dir = dirname(absolute);
  let realDir = dir;
  try {
    realDir = await realpath(dir);
  } catch {
    // The directory may not exist yet (the writer creates it later); the
    // absolute form is the best canonical spelling available.
  }
  return join(realDir, basename(absolute));
}

/** The same-file uniqueness rule, shared by the tools and the panel. */
export function findScheduleHandle(alarms: readonly Alarm[], canonicalFile: string, excludeId?: string): Alarm | undefined {
  return alarms.find((alarm) =>
    alarm.id !== excludeId &&
    alarm.type === "file" &&
    "file" in alarm.trigger &&
    alarm.trigger.file === canonicalFile
  );
}

/**
 * The child alarms a handle currently owns (computed live from the store —
 * never persisted, so the count can never drift from reality).
 */
export function childrenOfHandle(alarms: readonly Alarm[], handleId: string): Alarm[] {
  return alarms.filter((alarm) => alarm.declared?.sourceId === handleId);
}

/** One AlarmView, enriched with the handle's live child count. */
export function viewWithDeclaredEntries(alarms: readonly Alarm[], alarm: Alarm, now: number): AlarmView {
  const view = toAlarmView(alarm, now);
  if (alarm.type !== "file") return view;
  return { ...view, declaredEntries: childrenOfHandle(alarms, alarm.id).length };
}

/**
 * Whether the create/update dialect names ANY target. Used to decide when the
 * schedule-file default (the file's own workspace) may fill the slot: an
 * explicit target_* argument always wins, and an edit that names none keeps
 * the alarm's current destination instead of falling back to a default.
 */
export function hasTargetArgs(args: Record<string, unknown>): boolean {
  return args["target_mode"] !== undefined || args["target_source"] !== undefined ||
    args["target_session_id"] !== undefined || args["target_workspace_id"] !== undefined ||
    args["target_workspace_path"] !== undefined || args["target_preset_id"] !== undefined ||
    args["target_provider"] !== undefined || args["target_model"] !== undefined;
}

/** Stable JSON stringify (recursively key-sorted) for hashing. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Stable alarm id for one (file, entry) pair — identical across sync passes. */
export function declaredAlarmId(file: string, entryId: string): string {
  return "decl_" + sha256(file + "\u0000" + entryId).slice(0, 16);
}

/** Flatten a nested target object into the flat target_* dialect keys. */
export function flattenTarget(target: unknown, label: string): Record<string, unknown> | string {
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
 * Parse one schedule file's text into declared entries. Each entry carries a
 * flat record of its own + file-level scalar args and the WINNING target
 * layer (never a merge of layers); the caller fills the remaining defaults
 * from the owning handle. Synchronous and pure.
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
    for (const key of SCALAR_KEYS) {
      if (rawDefaults[key] !== undefined) args[key] = rawDefaults[key];
    }
    let target = fileTarget;
    if (raw["target"] !== undefined) {
      const flat = flattenTarget(raw["target"], file + " [" + entryId + "]: target");
      if (typeof flat === "string") {
        errors.push(flat);
        continue;
      }
      target = Object.keys(flat).length > 0 ? flat : undefined;
    }
    for (const key of ENTRY_SCALAR_KEYS) {
      if (raw[key] !== undefined) args[key] = raw[key];
    }
    entries.push({ id: entryId, args, ...(target !== undefined ? { target } : {}) });
  }
  return { file, entries, errors, fatal: false };
}

/** The resolveWorkspaceArg shape the tools/panel use (kept structural to avoid an import cycle). */
export type WorkspaceResolver = (args: Record<string, unknown>, sessionCwd?: string) => Promise<Record<string, unknown> | ToolError>;

/**
 * The strict default target for a handle created without any target_* arg:
 * the file must live EXACTLY one directory below a registered workspace
 * (i.e. `<workspace>/<dir>/<file>`, the `.life/` convention). Walking up to
 * the nearest registered ancestor is deliberately NOT done: this host has
 * `/root`, `/root/projects`, `/usr/bin` registered, so an unregistered agent
 * directory would silently resolve to `/root` and every wake would land in an
 * unrelated conversation — the same silent-failure family as 260928.
 */
export async function defaultHandleTargetArgs(file: string, resolveWorkspace: WorkspaceResolver | undefined): Promise<Record<string, unknown> | ToolError> {
  const workspaceDir = dirname(dirname(file));
  const hint = "schedule_file was given no target: expected the file to live exactly one directory below a registered workspace (" + workspaceDir + " for " + file + "). Pass target_workspace_path or target_session_id explicitly.";
  if (resolveWorkspace === undefined) {
    return { code: "not_found", message: hint + " This host has no workspace registry at all." };
  }
  const resolved = await resolveWorkspace({ target_mode: "resume", target_source: "workspace", target_workspace_path: workspaceDir }, undefined);
  if (isToolError(resolved)) return { code: "not_found", message: hint };
  const workspaceId = resolved["target_workspace_id"];
  if (typeof workspaceId !== "string") return { code: "not_found", message: hint };
  return { target_mode: "resume", target_source: "workspace", target_workspace_id: workspaceId };
}
