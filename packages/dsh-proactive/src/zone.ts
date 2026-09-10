/**
 * Minimal "which time zone does this alarm belong to" resolution.
 *
 * time_zone is optional everywhere: when a caller does not pass one (the
 * overwhelmingly common case), the effective zone is the session's last
 * client-reported browser zone (web clients send `clientTimeZone` on every
 * user rpc message, exactly like dsh-time-context expects), falling back to
 * the host process zone. UTC remains only the final safety net.
 */

import { canonicalizeTimeZone, isRecord } from "./domain.js";

/** The host process zone (resolved once): typically the user's local zone in a self-hosted deploy. */
export const SYSTEM_DEFAULT_TIME_ZONE: string = (() => {
  try {
    return canonicalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return "UTC";
  }
})();

/**
 * Scan a session's live event log (newest first) for the most recent user
 * rpc message carrying a canonical browser zone. Invalid or non-canonical
 * zones are skipped, never thrown. Returns undefined when nothing usable.
 */
function clientTimeZoneOf(events: readonly unknown[] | undefined): string | undefined {
  if (events === undefined) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as { type?: unknown; data?: unknown } | undefined;
    if (event === undefined || typeof event !== "object" || event["type"] !== "user/message") continue;
    // A real SessionEvent carries the message source under data.source
    // (data = {content, id, role, source}); the top level only has
    // {type, seq, time, data} — reading event.source never matched.
    const data = event["data"] as { source?: unknown } | undefined;
    const source = (data === undefined || typeof data !== "object" ? undefined : data["source"]) as { kind?: unknown; rpcId?: unknown; clientTimeZone?: unknown } | undefined;
    if (source === undefined || typeof source !== "object" || source["kind"] !== "user" || typeof source["rpcId"] !== "string" || typeof source["clientTimeZone"] !== "string") continue;
    try {
      return canonicalizeTimeZone(source["clientTimeZone"]);
    } catch {
      // best-effort observation: an invalid zone on the wire must not break the call
    }
  }
  return undefined;
}

/**
 * The one resolution rule shared by the model tools and the GUI panel:
 * explicit non-empty time_zone wins, else the session's client zone, else
 * the host process zone.
 */
export function effectiveTimeZone(explicit: unknown, events: readonly unknown[] | undefined): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return clientTimeZoneOf(events) ?? SYSTEM_DEFAULT_TIME_ZONE;
}

/**
 * Fill every empty time-zone slot of a create request through the one default
 * chain. A local `at` object that already names its zone IS the explicit
 * intent — nothing is wired on top of it (the at zone then flows into the
 * stored alarm through buildAlarm). Otherwise both the top-level time_zone and
 * a zone-less at object are completed with effectiveTimeZone.
 */
export function wireTimeZones(args: Record<string, unknown>, events: readonly unknown[] | undefined): Record<string, unknown> {
  const at = isRecord(args["at"]) ? args["at"] : undefined;
  const atHasExplicitZone = at !== undefined && typeof at["time_zone"] === "string" && at["time_zone"].length > 0;
  const out: Record<string, unknown> = { ...args };
  if (atHasExplicitZone) return out;
  const zone = effectiveTimeZone(args["time_zone"], events);
  if (typeof out["time_zone"] !== "string" || out["time_zone"].length === 0) out["time_zone"] = zone;
  if (at !== undefined && (typeof at["time_zone"] !== "string" || at["time_zone"].length === 0)) {
    out["at"] = { ...at, time_zone: zone };
  }
  return out;
}