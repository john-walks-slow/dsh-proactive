/**
 * dsh-proactive configuration: defaults, $DSH_HOME/proactive/config.json overrides,
 * quiet-hours evaluation, and per-day/host chat-text delivery budget accounting.
 *
 * The plugin preference order (highest wins) is:
 *   1. environment variables DSH_PROACTIVE_* (numeric/enabled fields)
 *   2. <dataDir>/config.json        (file, loaded once at startup)
 *   3. built-in defaults.
 */

import { readFileSync } from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { canonicalizeTimeZone, DEFAULT_WAKE_PROMPT, isRecord, MAX_PROMPT_LENGTH, sliceCodePoints } from "./domain.js";

export interface QuietHours {
  /** "HH:MM" wall-clock in the configured time zone; start inclusive, end exclusive. */
  start: string;
  end: string;
  timeZone: string;
}

export type BootOverduePolicy = "fire" | "notify-only" | "drop";

export interface ProactiveConfig {
  enabled: boolean;
  /** Budget: visible chat-text deliveries per UTC day. */
  maxDeliveriesPerDay: number;
  /** Quiet hours during which only user-requested alarms (wake_reason "alarm") fire. */
  quietHours: QuietHours;
  /** Host-wide cap on proactive wake-up turns per rolling hour. */
  maxWakeupsPerHour: number;
  /** How boot-time overdue alarms are treated. */
  bootOverduePolicy: BootOverduePolicy;
  /** Successive attempt budget when a wake turn cannot run (busy/transient). */
  maxRetriesPerFire: number;
  /** Upper bound for alarm prompts. */
  maxPromptLength: number;
  /**
   * Default wake-up instruction pre-filled into the GUI create form (both the
   * settings page and the conversation tab). Purely a prefill convenience —
   * every stored alarm keeps its own explicit prompt. The constant lives in
   * domain.ts so the browser client bundle shares it.
   */
  defaultPrompt: string;
  /** Master gate for silent-wake tombstone compaction (per-alarm `compaction` still fine-tunes). */
  silentWakeCompaction: boolean;
  /**
   * Declared-schedule source files (glob patterns, absolute paths with * / ** / ?).
   * Empty (default) = the feature is off. Files are parsed on boot and polled;
   * entries sync into the store as declared alarms (see declared.ts).
   */
  scheduleFiles: string[];
  /** Poll interval in seconds for declared-schedule files (15..3600). */
  schedulePollSeconds: number;
  /** Absolute directory for alarms.json / runs.jsonl / state.json / config.json. */
  dataDir: string;
}

export const DEFAULT_CONFIG: ProactiveConfig = {
  enabled: true,
  maxDeliveriesPerDay: 50,
  quietHours: { start: "23:00", end: "08:00", timeZone: "Asia/Shanghai" },
  maxWakeupsPerHour: 60,
  bootOverduePolicy: "fire",
  maxRetriesPerFire: 3,
  maxPromptLength: 4000,
  defaultPrompt: DEFAULT_WAKE_PROMPT,
  silentWakeCompaction: true,
  scheduleFiles: [],
  schedulePollSeconds: 60,
  dataDir: "/root/.dsh/proactive"
};

const TIME_PATTERN = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/;

function defaultDataDir(): string {
  if (typeof process !== "undefined" && process.env["DSH_HOME"]) return process.env["DSH_HOME"] + "/proactive";
  return DEFAULT_CONFIG.dataDir;
}

/** Parse and normalize one quiet-hours time value ("HH:MM"). */
export function parseClockTime(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error("config.quietHours." + label + " must be a string like HH:MM.");
  const match = TIME_PATTERN.exec(value);
  if (match === null) throw new Error("config.quietHours." + label + " must match HH:MM.");
  return value;
}

function readClock(value: string): { minutes: number } {
  const match = TIME_PATTERN.exec(value);
  if (match === null) throw new Error("invalid clock time: " + value);
  return { minutes: Number(match.groups?.["hour"]) * 60 + Number(match.groups?.["minute"]) };
}

/** Load <dataDir>/config.json tolerantly; malformed JSON falls back to defaults and a console warning. */
export function loadConfigFile(dataDir: string): Partial<ProactiveConfig> {
  try {
    const raw = readFileSync(dataDir + "/config.json", "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    return parsed as Partial<ProactiveConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn("[dsh-proactive] config.json ignored:", (error as Error).message);
    }
    return {};
  }
}

/**
 * Persist one config patch to <dataDir>/config.json atomically. The patch is
 * merged over whatever the file currently holds, so fields outside the patch
 * (hand-written or set earlier) survive. Returns the merged file object.
 */
export async function writeConfigFile(dataDir: string, patch: Partial<ProactiveConfig>): Promise<Partial<ProactiveConfig>> {
  const merged: Partial<ProactiveConfig> = { ...loadConfigFile(dataDir), ...patch };
  await mkdir(dataDir, { recursive: true });
  const target = dataDir + "/config.json";
  const tmp = target + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2);
  await writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
  await rename(tmp, target);
  return merged;
}

function positiveInt(value: unknown, fallback: number, ceiling: number): number {
  const n = typeof value === "number" && Number.isSafeInteger(value) ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > ceiling) return fallback;
  return n;
}

export const MAX_SCHEDULE_FILES = 64;
const MAX_SCHEDULE_PATTERN_LENGTH = 512;

/**
 * Tolerant parse of the declared-schedule glob list: non-empty absolute
 * strings without NUL survive, duplicates drop, the list is capped. Invalid
 * entries are dropped (not fatal) — a typo'd pattern just matches nothing.
 */
export function parseScheduleFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_SCHEDULE_PATTERN_LENGTH) continue;
    if (!entry.startsWith("/") || entry.includes("\0")) continue;
    if (out.includes(entry)) continue;
    out.push(entry);
    if (out.length >= MAX_SCHEDULE_FILES) break;
  }
  return out;
}

/** Merge defaults, file overrides, and DSH_PROACTIVE_* environment overrides. */
export function resolveConfig(dataDir?: string): ProactiveConfig {
  const dir = dataDir ?? (process.env["DSH_PROACTIVE_DATA_DIR"] ?? defaultDataDir());
  const file = loadConfigFile(dir);
  const env = process.env;
  const quiet = isRecord(file["quietHours"]) ? file["quietHours"] as Record<string, unknown> : {};
  const timeZone = typeof quiet["timeZone"] === "string" && quiet["timeZone"].length > 0 ? quiet["timeZone"]
    : env["DSH_PROACTIVE_TIME_ZONE"] ?? DEFAULT_CONFIG.quietHours.timeZone;
  const canonicalZone = canonicalizeTimeZone(timeZone);
  // Validate HH:MM at load so a typo'd config falls back to the default instead
  // of blowing up later on the isInQuietHours read path (which also feeds the
  // scheduler hot loop).
  let start = typeof quiet["start"] === "string" ? quiet["start"] : DEFAULT_CONFIG.quietHours.start;
  let end = typeof quiet["end"] === "string" ? quiet["end"] : DEFAULT_CONFIG.quietHours.end;
  try {
    parseClockTime(start, "start");
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[dsh-proactive] invalid quietHours.start; using default:", (error as Error).message);
    start = DEFAULT_CONFIG.quietHours.start;
  }
  try {
    parseClockTime(end, "end");
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[dsh-proactive] invalid quietHours.end; using default:", (error as Error).message);
    end = DEFAULT_CONFIG.quietHours.end;
  }
  const maxPromptLength = Math.max(1, positiveInt(file["maxPromptLength"], DEFAULT_CONFIG.maxPromptLength, 20000));
  const config: ProactiveConfig = {
    enabled: typeof file["enabled"] === "boolean" ? file["enabled"] : true,
    maxDeliveriesPerDay: positiveInt(file["maxDeliveriesPerDay"], DEFAULT_CONFIG.maxDeliveriesPerDay, 50),
    quietHours: { start, end, timeZone: canonicalZone },
    maxWakeupsPerHour: positiveInt(file["maxWakeupsPerHour"], DEFAULT_CONFIG.maxWakeupsPerHour, 60),
    bootOverduePolicy: file["bootOverduePolicy"] === "notify-only" || file["bootOverduePolicy"] === "drop" ? file["bootOverduePolicy"] : "fire",
    maxRetriesPerFire: Math.max(0, positiveInt(file["maxRetriesPerFire"], DEFAULT_CONFIG.maxRetriesPerFire, 10)),
    maxPromptLength,
    // The prefill must always be a CREATABLE alarm prompt, so it is bounded
    // by the hard alarm-prompt cap (MAX_PROMPT_LENGTH) — never only by
    // maxPromptLength, which the settings surface lets exceed it. Slicing is
    // code-point safe so an emoji preset is never cut mid-surrogate.
    defaultPrompt: typeof file["defaultPrompt"] === "string" && file["defaultPrompt"].trim().length > 0
      ? sliceCodePoints(file["defaultPrompt"].trim(), Math.min(maxPromptLength, MAX_PROMPT_LENGTH))
      : DEFAULT_CONFIG.defaultPrompt,
    // Default ON (tombstone compaction reclaims silent/failed wakes off the
    // model surface). An explicit boolean in config.json wins; any non-boolean
    // value falls back to the default (on), not to false.
    silentWakeCompaction: typeof file["silentWakeCompaction"] === "boolean" ? file["silentWakeCompaction"] : DEFAULT_CONFIG.silentWakeCompaction,
    scheduleFiles: parseScheduleFiles(file["scheduleFiles"]),
    schedulePollSeconds: Math.max(15, Math.min(3600, positiveInt(file["schedulePollSeconds"], DEFAULT_CONFIG.schedulePollSeconds, 3600))),
    dataDir: dir
  };
  if (env["DSH_PROACTIVE_ENABLED"] === "0" || env["DSH_PROACTIVE_ENABLED"] === "false") config.enabled = false;
  if (env["DSH_PROACTIVE_MAX_DELIVERIES_PER_DAY"] !== undefined) {
    config.maxDeliveriesPerDay = positiveInt(env["DSH_PROACTIVE_MAX_DELIVERIES_PER_DAY"], 3, 50);
  }
  return config;
}

/** The current local wall-clock minutes and UTC-day key for one instant. */
export function localClockMinutes(now: Date | number, timeZone: string): { minutes: number; utcDate: string } {
  const epoch = typeof now === "number" ? now : now.getTime();
  const parts = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(epoch);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return { minutes: hour * 60 + minute, utcDate: new Date(epoch).toISOString().slice(0, 10) };
}

/** Whether one instant falls inside the quiet window (start inclusive, end exclusive; wrap-around allowed). */
export function isInQuietHours(now: Date | number, cfg: Pick<ProactiveConfig, "quietHours">): boolean {
  const { minutes } = localClockMinutes(now, cfg.quietHours.timeZone);
  const start = readClock(cfg.quietHours.start).minutes;
  const end = readClock(cfg.quietHours.end).minutes;
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function quietHoursLabel(cfg: Pick<ProactiveConfig, "quietHours">): string {
  return cfg.quietHours.start + "–" + cfg.quietHours.end + " " + cfg.quietHours.timeZone;
}
