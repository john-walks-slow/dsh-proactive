/**
 * Thin bridge between the official settings surface (ctx.settings) and the
 * live ProactiveConfig snapshot. The panel/settings UI edits the `proactive`
 * namespace for free; every resolved change hot-applies onto the single
 * config object the scheduler/wake/tools already hold by reference, so
 * quietHours/budget policies change without a restart.
 */

import z from "schemastery";
import type { Context } from "@deepseek-ai/cordis";
import { type ProactiveConfig, type BootOverduePolicy, type QuietHours } from "./config.js";
import { canonicalizeTimeZone, DEFAULT_WAKE_PROMPT, isRecord, MAX_PROMPT_LENGTH, type ToolError } from "./domain.js";

/** The hot-updatable configuration subset, excluding the immutable dataDir. */
export interface HotConfig {
  enabled: boolean;
  maxDeliveriesPerDay: number;
  quietHours: QuietHours;
  maxWakeupsPerHour: number;
  bootOverduePolicy: BootOverduePolicy;
  maxRetriesPerFire: number;
  maxPromptLength: number;
  defaultPrompt: string;
  silentWakeCompaction: boolean;
}

/**
 * Pull the hot subset out of a full configuration; used as the composition
 * `base` layer so an existing config.json keeps working as the default under
 * any user overrides written through the settings UI.
 */
export function hotSubset(config: ProactiveConfig): HotConfig {
  return {
    enabled: config.enabled,
    maxDeliveriesPerDay: config.maxDeliveriesPerDay,
    quietHours: { start: config.quietHours.start, end: config.quietHours.end, timeZone: config.quietHours.timeZone },
    maxWakeupsPerHour: config.maxWakeupsPerHour,
    bootOverduePolicy: config.bootOverduePolicy,
    maxRetriesPerFire: config.maxRetriesPerFire,
    maxPromptLength: config.maxPromptLength,
    defaultPrompt: config.defaultPrompt,
    silentWakeCompaction: config.silentWakeCompaction
  };
}

/**
 * Apply a settings-resolved value onto the live config snapshot in place.
 * Returns whether anything changed; a deep-equal next value is a no-op.
 */
export function applyHotConfig(target: ProactiveConfig, next: HotConfig): boolean {
  let changed = false;
  const set = <K extends keyof HotConfig>(key: K): void => {
    const value = next[key] as never;
    if (JSON.stringify(target[key] as never) !== JSON.stringify(value)) {
      (target as unknown as Record<string, unknown>)[key as string] = value;
      changed = true;
    }
  };
  (Object.keys(hotSubset(target)) as Array<keyof HotConfig>).forEach(set);
  return changed;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Accepted ranges for the proactive_update_settings tool. These mirror the
 * resolveConfig clamps exactly (config.ts), so a value this tool accepts is
 * never silently truncated on the next boot when config.json is re-read —
 * the hot-applied value and the persisted value agree.
 */
const MAX_DELIVERIES_PER_DAY = 50;
const MAX_WAKEUPS_PER_HOUR = 60;
const MAX_RETRIES_PER_FIRE = 10;
const MAX_SET_PROMPT_LENGTH = 20000;

/**
 * Closed validation for the proactive_update_settings tool: an open patch of
 * snake_case keys, each optional; at least one key must be present. Returns
 * ONLY the keys that were supplied (partial), so an update never clobbers
 * other live settings. Numeric ranges mirror the resolveConfig clamps exactly
 * (tighter than the settings UI schema where they differ), so a tool-written
 * config.json is never silently truncated on the next boot — hot-applied and
 * persisted values always agree. default_prompt is capped at the hard
 * alarm-prompt limit (MAX_PROMPT_LENGTH): the prefill must always produce a
 * creatable alarm; a maxPromptLength below that cap only trims the prefill
 * loaded from a hand-edited file, never to an invalid state.
 */
export function validateSettingsPatch(raw: unknown): { patch: Partial<HotConfig> } | ToolError {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    return { code: "invalid_trigger", message: "proactive_update_settings requires at least one setting to update." };
  }
  const allowed = new Set([
    "enabled", "max_deliveries_per_day", "quiet_hours",
    "max_wakeups_per_hour", "boot_overdue_policy",
    "max_retries_per_fire", "max_prompt_length", "default_prompt",
    "silent_wake_compaction"
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return { code: "invalid_trigger", message: "proactive_update_settings accepts only " + [...allowed].join(", ") + "." };
    }
  }
  const patch: Partial<HotConfig> = {};
  const write = <K extends keyof HotConfig>(key: K, value: HotConfig[K]): void => {
    (patch as Record<string, unknown>)[key] = value;
  };
  if ("enabled" in raw) {
    if (typeof raw["enabled"] !== "boolean") return { code: "invalid_trigger", message: "enabled must be a boolean." };
    write("enabled", raw["enabled"]);
  }
  if ("max_deliveries_per_day" in raw) {
    const n = raw["max_deliveries_per_day"];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > MAX_DELIVERIES_PER_DAY) {
      return { code: "invalid_trigger", message: "max_deliveries_per_day must be a safe integer 0.." + MAX_DELIVERIES_PER_DAY + "." };
    }
    write("maxDeliveriesPerDay", n);
  }
  if ("quiet_hours" in raw) {
    const q = raw["quiet_hours"];
    if (!isRecord(q) || typeof q["start"] !== "string" || typeof q["end"] !== "string" || typeof q["time_zone"] !== "string") {
      return { code: "invalid_trigger", message: "quiet_hours must be { start: \"HH:MM\", end: \"HH:MM\", time_zone: IANA }." };
    }
    if (!TIME_PATTERN.test(q["start"])) return { code: "invalid_trigger", message: "quiet_hours.start must match HH:MM." };
    if (!TIME_PATTERN.test(q["end"])) return { code: "invalid_trigger", message: "quiet_hours.end must match HH:MM." };
    let zone: string;
    try {
      zone = canonicalizeTimeZone(q["time_zone"]);
    } catch {
      return { code: "invalid_time_zone", message: "quiet_hours.time_zone must be an IANA time zone." };
    }
    write("quietHours", { start: q["start"], end: q["end"], timeZone: zone });
  }
  if ("max_wakeups_per_hour" in raw) {
    const n = raw["max_wakeups_per_hour"];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > MAX_WAKEUPS_PER_HOUR) {
      return { code: "invalid_trigger", message: "max_wakeups_per_hour must be a safe integer 1.." + MAX_WAKEUPS_PER_HOUR + "." };
    }
    write("maxWakeupsPerHour", n);
  }
  if ("boot_overdue_policy" in raw) {
    const v = raw["boot_overdue_policy"];
    if (v !== "fire" && v !== "notify-only" && v !== "drop") {
      return { code: "invalid_trigger", message: "boot_overdue_policy must be fire, notify-only, or drop." };
    }
    write("bootOverduePolicy", v);
  }
  if ("max_retries_per_fire" in raw) {
    const n = raw["max_retries_per_fire"];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > MAX_RETRIES_PER_FIRE) {
      return { code: "invalid_trigger", message: "max_retries_per_fire must be a safe integer 0.." + MAX_RETRIES_PER_FIRE + "." };
    }
    write("maxRetriesPerFire", n);
  }
  if ("max_prompt_length" in raw) {
    const n = raw["max_prompt_length"];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 100 || n > MAX_SET_PROMPT_LENGTH) {
      return { code: "invalid_trigger", message: "max_prompt_length must be a safe integer 100.." + MAX_SET_PROMPT_LENGTH + "." };
    }
    write("maxPromptLength", n);
  }
  if ("default_prompt" in raw) {
    const value = raw["default_prompt"];
    if (typeof value !== "string" || value.trim().length === 0) {
      return { code: "invalid_trigger", message: "default_prompt must be a non-empty string (the create-form prefill)." };
    }
    // Capped at the hard ALARM prompt limit (not MAX_SET_PROMPT_LENGTH): the
    // prefill feeds the create form, and a longer default would pre-fill a
    // prompt the alarm validator itself rejects.
    if (value.trim().length > MAX_PROMPT_LENGTH) {
      return { code: "invalid_trigger", message: "default_prompt must be at most " + MAX_PROMPT_LENGTH + " characters." };
    }
    write("defaultPrompt", value.trim());
  }
  if ("silent_wake_compaction" in raw) {
    if (typeof raw["silent_wake_compaction"] !== "boolean") return { code: "invalid_trigger", message: "silent_wake_compaction must be a boolean." };
    write("silentWakeCompaction", raw["silent_wake_compaction"]);
  }
  return { patch };
}

const quietHoursSchema = z.object({
  start: z.string().pattern(TIME_PATTERN).default("23:00"),
  end: z.string().pattern(TIME_PATTERN).default("08:00"),
  timeZone: z.string().default("Asia/Shanghai")
});

/** The `proactive` settings namespace schema; mirrors HotConfig. */
export const proactiveSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  maxDeliveriesPerDay: z.number().min(0).max(1000).default(3),
  quietHours: quietHoursSchema,
  maxWakeupsPerHour: z.number().min(1).max(60).default(4),
  bootOverduePolicy: z.union([z.const("fire"), z.const("notify-only"), z.const("drop")]).default("fire"),
  maxRetriesPerFire: z.number().min(0).max(16).default(3),
  // Schema ceiling mirrors the resolveConfig clamp (20000) so a settings-UI
  // value is never silently truncated on the next boot.
  maxPromptLength: z.number().min(100).max(MAX_SET_PROMPT_LENGTH).default(4000),
  defaultPrompt: z.string().default(DEFAULT_WAKE_PROMPT),
  silentWakeCompaction: z.boolean().default(false)
});

export interface SettingsWire {
  installed: boolean;
  dispose?: () => void;
}

/**
 * Register the namespace on ctx.settings when the service is composed and
 * hot-apply every resolved change onto the live config snapshot. Missing
 * settings (headless profiles) degrades to a logged no-op; the plugin never
 * hard-depends on the GUI surface.
 */
export function wireSettings(ctx: Context, config: ProactiveConfig): SettingsWire {
  const settings = (ctx as unknown as { get: (name: string, strict?: boolean) => unknown }).get("settings", false);
  if (settings === undefined || settings === null || typeof (settings as { register?: unknown })["register"] !== "function") {
    ctx.logger.info("dsh-proactive: no settings service composed; configuration UI and hot-reload disabled.");
    return { installed: false };
  }
  try {
    const scope = (settings as { register: (ns: string, schema: unknown, options?: object) => { get: () => HotConfig; watch: (cb: (next: HotConfig) => void) => () => void } })["register"](
      "proactive",
      proactiveSettingsSchema,
      { base: hotSubset(config) }
    );
    const dispose = scope.watch((next) => {
      const changed = applyHotConfig(config, next);
      ctx.logger.info("dsh-proactive: settings changed" + (changed ? " — hot-applied." : " (no effective change)."));
    });
    applyHotConfig(config, scope.get());
    ctx.logger.info("dsh-proactive: settings namespace `proactive` registered; configuration hot-reload enabled.");
    return { installed: true, dispose };
  } catch (error) {
    ctx.logger.warn("dsh-proactive: settings registration failed: " + (error instanceof Error ? error.message : String(error)));
    return { installed: false };
  }
}