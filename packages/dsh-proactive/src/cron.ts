/**
 * Zero-dependency five-field numeric cron for dsh-proactive (v2).
 *
 * dsh-schedule itself has no cron (only after/at/every); this module is a
 * self-contained implementation that mirrors the schedule plugin's semantics
 * and style: pure evaluation, closed error codes, occurrences strictly after
 * the reference instant, misses skipped (never re-fired), and — like every
 * other scheduler here — never trusting the process time zone.
 *
 * Grammar: five fields `minute hour day-of-month month day-of-week`.
 *   - minute 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-7 (0 and 7 = Sunday, 1-6 = Mon-Sat)
 *   - each field: comma-separated atoms; atom = `*` | number | `a-b` | star-slash-n | `a-b/n`
 *   - no names, no '?', no seconds, no L/W/# extensions.
 * Day-of-month / day-of-week follow Vixie semantics: a day matches by the
 * restricted field alone when the other is a wildcard, or by either when both
 * are restricted (dom OR dow). On fall-back overlaps the earlier instant of an
 * ambiguous wall minute is the occurrence (the second, repeated wall minute is
 * not emitted — one occurrence per wall minute, consistent with the plugin's
 * resolveLocalInstant convention).
 */

import { makeLocalFormatter, localProjection, ProactiveInputError, resolveLocalInstant } from "./domain.js";

export interface ParsedCron {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dom: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dow: ReadonlySet<number>;
}

interface FieldBounds {
  min: number;
  max: number;
}

const FIELDS: readonly { name: string; bounds: FieldBounds }[] = [
  { name: "minute", bounds: { min: 0, max: 59 } },
  { name: "hour", bounds: { min: 0, max: 23 } },
  { name: "day-of-month", bounds: { min: 1, max: 31 } },
  { name: "month", bounds: { min: 1, max: 12 } },
  { name: "day-of-week", bounds: { min: 0, max: 7 } }
];

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const DAY_MS = 86_400_000;
/** Search window for one occurrence: 8 years covers leap-day-only expressions. */
const WINDOW_MS = 8 * 366 * DAY_MS;

const EPOCH_ATOM = /^(?:(?<star>\*)|(?<start>\d+)(?:-(?<end>\d+))?)(?:\/(?<step>\d+))?$/;

function parseRange(text: string, bounds: FieldBounds, fieldName: string): Set<number> {
  const values = new Set<number>();
  for (const atom of text.split(",")) {
    if (atom === "") throw new ProactiveInputError("invalid_trigger", "cron " + fieldName + " contains an empty list item.");
    const match = EPOCH_ATOM.exec(atom);
    if (match === null) {
      throw new ProactiveInputError("invalid_trigger", "cron " + fieldName + " item '" + atom + "' must be * , a number, a range a-b, or a step */n / a-b/n.");
    }
    const groups = match.groups;
    const step = groups?.["step"] === undefined ? 1 : Number(groups["step"]);
    if (!Number.isSafeInteger(step) || step < 1) throw new ProactiveInputError("invalid_trigger", "cron " + fieldName + " step must be a positive integer.");
    let start: number;
    let end: number;
    if (groups?.["star"] !== undefined) {
      start = bounds.min;
      end = bounds.max;
    } else {
      start = Number(groups?.["start"]);
      // A bare number is a single value; `a/n` (no explicit end) sweeps to the
      // field max (Vixie step semantics). An explicit `a-b` uses its own end.
      end = groups?.["end"] !== undefined ? Number(groups["end"]) : (step > 1 ? bounds.max : start);
      if (start > end) throw new ProactiveInputError("invalid_trigger", "cron " + fieldName + " range start must not exceed its end.");
    }
    if (start < bounds.min || start > bounds.max || end < bounds.min || end > bounds.max) {
      throw new ProactiveInputError("invalid_trigger", "cron " + fieldName + " range " + String(start) + "-" + String(end) + " is outside " + String(bounds.min) + ".." + String(bounds.max) + ".");
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  if (values.size === 0) throw new ProactiveInputError("invalid_trigger", "cron " + fieldName + " matched no values.");
  return values;
}

/** Parse a five-field numeric cron expression; throws invalid_trigger on any syntax error. */
export function parseCron(expr: string): ParsedCron {
  if (typeof expr !== "string" || expr.trim() !== expr || expr.length === 0) {
    throw new ProactiveInputError("invalid_trigger", "cron must be a non-empty five-field expression with no surrounding whitespace.");
  }
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) {
    throw new ProactiveInputError("invalid_trigger", "cron must have exactly five fields (minute hour day-of-month month day-of-week), got " + String(fields.length) + ".");
  }
  const dow = parseRange(fields[4], FIELDS[4].bounds, FIELDS[4].name);
  // Vixie: 0 and 7 both mean Sunday — normalize membership without changing the set identity.
  if (dow.has(7)) dow.add(0);
  return {
    minute: parseRange(fields[0], FIELDS[0].bounds, FIELDS[0].name),
    hour: parseRange(fields[1], FIELDS[1].bounds, FIELDS[1].name),
    dom: parseRange(fields[2], FIELDS[2].bounds, FIELDS[2].name),
    month: parseRange(fields[3], FIELDS[3].bounds, FIELDS[3].name),
    dow
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Smallest set value strictly greater than current; MAX_SAFE_INTEGER when none. */
function nextInSet(values: ReadonlySet<number>, current: number): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const v of values) {
    if (v > current && v < best) best = v;
  }
  return best;
}

/**
 * Vixie dom/dow rule: a day matches by the restricted field alone when the
 * other is a wildcard; when BOTH are restricted either may match (OR).
 * `*` fields are stored as their full value range (31 days / 8 dow slots),
 * which is how "restricted" is detected here — a full-range set is a wildcard.
 */
function dayMatches(parsed: ParsedCron, day: number, weekday: number): boolean {
  const domRestricted = parsed.dom.size < 31;
  const dowRestricted = parsed.dow.size < 8;
  if (domRestricted && dowRestricted) return parsed.dom.has(day) || parsed.dow.has(weekday);
  if (domRestricted) return parsed.dom.has(day);
  if (dowRestricted) return parsed.dow.has(weekday);
  return true;
}

interface WallFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function resolveWall(fields: WallFields, timeZone: string): number | null {
  try {
    return resolveLocalInstant({ year: fields.year, month: fields.month, day: fields.day, hour: fields.hour, minute: fields.minute, second: 0, millisecond: 0 }, timeZone);
  } catch {
    // Gap (spring-forward) or out-of-range — the caller advances instead.
    return null;
  }
}

function nextDay(year: number, month: number, day: number): WallFields {
  if (day < daysInMonth(year, month)) return { year, month, day: day + 1, hour: 0, minute: 0 };
  return nextMonthDay(year, month);
}

function nextMonthDay(year: number, month: number): WallFields {
  if (month < 12) return { year, month: month + 1, day: 1, hour: 0, minute: 0 };
  return { year: year + 1, month: 1, day: 1, hour: 0, minute: 0 };
}

/**
 * The first cron occurrence strictly after afterEpoch in the given zone.
 * DST-correct: wall-clock moments are resolved through the same Intl-based
 * machinery as the rest of the plugin; a moment that does not exist
 * (spring-forward gap) is skipped, an ambiguous one (fall-back) takes the
 * earlier instant. Throws invalid_trigger when nothing matches in the 8-year
 * window. Pure: no clock, no random source, deterministic in (expr, zone, after).
 */
export function nextCronOccurrence(expr: string, timeZone: string, afterEpoch: number): number {
  const parsed = parseCron(expr);
  let formatter: ReturnType<typeof makeLocalFormatter>;
  try {
    formatter = makeLocalFormatter(timeZone, { weekday: "short" });
  } catch {
    // Keep the closed error-code contract: unknown zones surface as
    // invalid_time_zone, never as a raw RangeError from Intl.
    throw new ProactiveInputError("invalid_time_zone", "Unknown IANA time zone: " + String(timeZone));
  }
  // First whole minute strictly after afterEpoch.
  let cursor = Math.floor(afterEpoch / 60_000) * 60_000 + 60_000;
  const windowEnd = cursor + WINDOW_MS;
  let guard = 0;
  while (cursor <= windowEnd && guard < 200_000) {
    guard++;
    const local = localProjection(formatter, cursor);
    const weekday = WEEKDAY_INDEX[local["weekday"] ?? ""];
    if (weekday === undefined) throw new ProactiveInputError("invalid_trigger", "cron evaluation failed to determine the local weekday.");
    if (!parsed.month.has(local.month)) {
      const jump = nextMonthDay(local.year, local.month);
      const epoch = resolveWall(jump, timeZone);
      cursor = epoch === null ? cursor + 60_000 : epoch;
      continue;
    }
    if (!dayMatches(parsed, local.day, weekday)) {
      const jump = nextDay(local.year, local.month, local.day);
      const epoch = resolveWall(jump, timeZone);
      cursor = epoch === null ? cursor + 60_000 : epoch;
      continue;
    }
    if (!parsed.hour.has(local.hour)) {
      const nextHour = nextInSet(parsed.hour, local.hour);
      const jump: WallFields = nextHour > 23 ? nextDay(local.year, local.month, local.day) : { year: local.year, month: local.month, day: local.day, hour: nextHour, minute: 0 };
      const epoch = resolveWall(jump, timeZone);
      cursor = epoch === null ? cursor + 60_000 : epoch;
      continue;
    }
    if (parsed.minute.has(local.minute)) {
      const epoch = resolveWall({ year: local.year, month: local.month, day: local.day, hour: local.hour, minute: local.minute }, timeZone);
      if (epoch !== null && epoch > afterEpoch) return epoch;
      cursor += 60_000;
      continue;
    }
    const nextMinute = nextInSet(parsed.minute, local.minute);
    if (nextMinute > 59) {
      const nextHour = nextInSet(parsed.hour, local.hour);
      const jump: WallFields = nextHour > 23 ? nextDay(local.year, local.month, local.day) : { year: local.year, month: local.month, day: local.day, hour: nextHour, minute: 0 };
      const epoch = resolveWall(jump, timeZone);
      cursor = epoch === null ? cursor + 60_000 : epoch;
      continue;
    }
    const epoch = resolveWall({ year: local.year, month: local.month, day: local.day, hour: local.hour, minute: nextMinute }, timeZone);
    if (epoch !== null && epoch > afterEpoch) return epoch;
    cursor += 60_000;
  }
  throw new ProactiveInputError("invalid_trigger", "The cron expression matches no time within the supported window.");
}