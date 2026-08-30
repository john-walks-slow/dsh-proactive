/**
 * Thin bridge between the official settings surface (ctx.settings) and the
 * live ProactiveConfig snapshot. The panel/settings UI edits the `proactive`
 * namespace for free; every resolved change hot-applies onto the single
 * config object the scheduler/wake/tools already hold by reference, so
 * quietHours/budget policies change without a restart.
 */

import z from "schemastery";
import type { Context } from "@deepseek-ai/cordis";
import { DEFAULT_CONFIG, type ProactiveConfig, type BootOverduePolicy, type QuietHours } from "./config.js";
import { MAX_PROMPT_LENGTH, MIN_EVERY_SECONDS } from "./domain.js";

/** The hot-updatable configuration subset, excluding the immutable dataDir. */
export interface HotConfig {
  enabled: boolean;
  maxDeliveriesPerDay: number;
  quietHours: QuietHours;
  maxWakeupsPerHour: number;
  maxConcurrentPerSession: number;
  bootOverduePolicy: BootOverduePolicy;
  maxRetriesPerFire: number;
  maxPromptLength: number;
  heartbeatPrompt: string;
  heartbeatEverySeconds: number;
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
    maxConcurrentPerSession: config.maxConcurrentPerSession,
    bootOverduePolicy: config.bootOverduePolicy,
    maxRetriesPerFire: config.maxRetriesPerFire,
    maxPromptLength: config.maxPromptLength,
    heartbeatPrompt: config.heartbeatPrompt,
    heartbeatEverySeconds: config.heartbeatEverySeconds
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
  maxConcurrentPerSession: z.number().min(1).max(16).default(1),
  bootOverduePolicy: z.union([z.const("fire"), z.const("notify-only"), z.const("drop")]).default("fire"),
  maxRetriesPerFire: z.number().min(0).max(16).default(3),
  maxPromptLength: z.number().min(100).max(100000).default(4000),
  heartbeatPrompt: z.string().min(1).max(MAX_PROMPT_LENGTH).default(DEFAULT_CONFIG.heartbeatPrompt),
  heartbeatEverySeconds: z.number().min(MIN_EVERY_SECONDS).max(86400).default(DEFAULT_CONFIG.heartbeatEverySeconds)
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