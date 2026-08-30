/**
 * dsh-proactive configuration: defaults, $DSH_HOME/proactive/config.json overrides,
 * quiet-hours evaluation, and per-day/host delivery budget accounting.
 *
 * The plugin preference order (highest wins) is:
 *   1. environment variables DSH_PROACTIVE_* (numeric/enabled fields)
 *   2. <dataDir>/config.json        (file, loaded once at startup)
 *   3. built-in defaults.
 */

import { readFileSync } from "node:fs";
import { MAX_PROMPT_LENGTH, MIN_EVERY_SECONDS, canonicalizeTimeZone, isRecord } from "./domain.js";

export interface QuietHours {
  /** "HH:MM" wall-clock in the configured time zone; start inclusive, end exclusive. */
  start: string;
  end: string;
  timeZone: string;
}

export type BootOverduePolicy = "fire" | "notify-only" | "drop";

export interface ProactiveConfig {
  enabled: boolean;
  /** Budget: visible deliveries (chat text that reaches the user, push_notify, send_wechat) per UTC day. */
  maxDeliveriesPerDay: number;
  /** Quiet hours during which only user-requested alarms (wake_reason "alarm") fire. */
  quietHours: QuietHours;
  /** Host-wide cap on proactive wake-up turns per rolling hour. */
  maxWakeupsPerHour: number;
  /** Cap on concurrently in-flight wake turns per session. */
  maxConcurrentPerSession: number;
  /** How boot-time overdue alarms are treated. */
  bootOverduePolicy: BootOverduePolicy;
  /** Successive attempt budget when a wake turn cannot run (busy/transient). */
  maxRetriesPerFire: number;
  /** Upper bound for alarm prompts. */
  maxPromptLength: number;
  /** Default heartbeat check-in prompt consumed by the panel preset. */
  heartbeatPrompt: string;
  /** Default heartbeat repeat interval in seconds (panel preset; floor MIN_EVERY_SECONDS, cap 1 day). */
  heartbeatEverySeconds: number;
  /** Absolute directory for alarms.json / runs.jsonl / state.json / config.json. */
  dataDir: string;
}

export const DEFAULT_CONFIG: ProactiveConfig = {
  enabled: true,
  maxDeliveriesPerDay: 3,
  quietHours: { start: "23:00", end: "08:00", timeZone: "Asia/Shanghai" },
  maxWakeupsPerHour: 4,
  maxConcurrentPerSession: 1,
  bootOverduePolicy: "fire",
  maxRetriesPerFire: 3,
  maxPromptLength: 4000,
  heartbeatPrompt: "这是一个 heartbeat reminder，你可以选择与用户发送消息。记得完全进入你的人设和情境。 如果不希望发送消息，则用 proactive_no_reply 安静结束。",
  heartbeatEverySeconds: 3600,
  dataDir: "/root/.dsh/proactive"
};

const TIME_PATTERN = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/;

/** Ceiling for the heartbeat interval: a ping slower than one full day is no longer a heartbeat. */
const HEARTBEAT_MAX_SECONDS = 86400;

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

function positiveInt(value: unknown, fallback: number, ceiling: number): number {
  const n = typeof value === "number" && Number.isSafeInteger(value) ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > ceiling) return fallback;
  return n;
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
  const config: ProactiveConfig = {
    enabled: typeof file["enabled"] === "boolean" ? file["enabled"] : true,
    maxDeliveriesPerDay: positiveInt(file["maxDeliveriesPerDay"], DEFAULT_CONFIG.maxDeliveriesPerDay, 50),
    quietHours: { start, end, timeZone: canonicalZone },
    maxWakeupsPerHour: positiveInt(file["maxWakeupsPerHour"], DEFAULT_CONFIG.maxWakeupsPerHour, 60),
    maxConcurrentPerSession: Math.max(1, positiveInt(file["maxConcurrentPerSession"], DEFAULT_CONFIG.maxConcurrentPerSession, 4)),
    bootOverduePolicy: file["bootOverduePolicy"] === "notify-only" || file["bootOverduePolicy"] === "drop" ? file["bootOverduePolicy"] : "fire",
    maxRetriesPerFire: Math.max(0, positiveInt(file["maxRetriesPerFire"], DEFAULT_CONFIG.maxRetriesPerFire, 10)),
    maxPromptLength: Math.max(1, positiveInt(file["maxPromptLength"], DEFAULT_CONFIG.maxPromptLength, 20000)),
    heartbeatPrompt: typeof file["heartbeatPrompt"] === "string" && file["heartbeatPrompt"].trim().length > 0
      ? file["heartbeatPrompt"].trim().slice(0, MAX_PROMPT_LENGTH) // same cap as the settings schema, keeps prefill valid
      : DEFAULT_CONFIG.heartbeatPrompt,
    heartbeatEverySeconds: Math.max(MIN_EVERY_SECONDS, positiveInt(file["heartbeatEverySeconds"], DEFAULT_CONFIG.heartbeatEverySeconds, HEARTBEAT_MAX_SECONDS)),
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
