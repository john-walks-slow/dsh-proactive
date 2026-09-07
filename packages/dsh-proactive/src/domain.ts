/**
 * dsh-proactive durable domain: alarm records, run records, validation, and closed error codes.
 * Local-time resolution ports the DST-correct algorithm from @deepseek-ai/dsh-schedule
 * (MIT): overlaps choose the earlier instant, gaps are rejected, and the zone is
 * never imported from the process or browser.
 */

export const PROACTIVE_PLUGIN = "dsh-proactive";
export const MIN_EVERY_SECONDS = 300;
export const MAX_PROMPT_LENGTH = 4000;
export const MAX_NO_REPLY_REASON_LENGTH = 200;

/** dsh session ids are alphanumeric plus `._-`; anything else (slashes, traversals, spaces, UTF-8) is rejected. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Fail closed on session ids that could escape storage paths or scope lookups. */
export function isValidSessionId(sessionId: string): boolean {
  if (sessionId === "" || sessionId.length > 200) return false;
  // "." and ".." would resolve to the sessions root itself — never a real session.
  if (sessionId === "." || sessionId === "..") return false;
  return SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Why a wake fires. Only two reasons exist: `alarm` (user-requested reminder,
 * exempt from quiet hours and the daily budget) and `heartbeat` (model-initiated
 * periodic check-in, gated by quiet hours + budget). Earlier builds used
 * `check_in`, `interval`, and `companion`; every model-initiated value behaved
 * identically, so they were merged into `heartbeat`. Stored alarms may still
 * carry those legacy values — framing and views keep them readable instead of
 * breaking ("check_in" is treated as the same gate class, i.e. non-alarm).
 */
export type WakeReason = "heartbeat" | "alarm";
export type AlarmMode = "one-shot" | "repeat";
export type AlarmStatus = "scheduled" | "in-flight" | "completed" | "cancelled" | "failed" | "paused";
export type RunDecision = "no_reply" | "reply" | "skipped" | "failed";

export const WAKE_REASONS: readonly WakeReason[] = ["heartbeat", "alarm"];

export type ProactiveErrorCode =
  | "invalid_prompt"
  | "invalid_trigger"
  | "invalid_time_zone"
  | "not_future"
  | "frequency_too_high"
  | "not_found"
  | "corrupt_store"
  | "no_active_wake"
  | "persistence_uncertain"
  | "internal_error";

export type ToolError = {
  code: ProactiveErrorCode;
  message: string;
};

export interface AlarmTriggerAt {
  at: string;
}

export interface AlarmTriggerEvery {
  everySeconds: number;
  anchor: string;
  /** Optional randomness 0..1: each repeat interval is scaled by (1 ± jitter·uniform(0,1)). Absent/0 = fixed rate. */
  jitter?: number;
}

export type AlarmTrigger = AlarmTriggerAt | AlarmTriggerEvery;

export interface Alarm {
  id: string;
  sessionId: string;
  mode: AlarmMode;
  trigger: AlarmTrigger;
  prompt: string;
  wakeReason: WakeReason;
  /** IANA zone for repeat alignment and quiet-hours display; "UTC" default. */
  timeZone: string;
  status: AlarmStatus;
  nextDueAt: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastRunAt: string | null;
}

export interface RunRecord {
  id: string;
  alarmId: string;
  sessionId: string;
  firedAt: string;
  decision: RunDecision;
  budgetDelta: number;
  note?: string;
  /** Truncated reasoning (thinking) summary of the wake turn, for the panel history. */
  reasoningSummary?: string;
  /** Truncated visible-reply summary of the wake turn, for the panel history. */
  replySummary?: string;
}

export type AlarmView = {
  id: string;
  sessionId: string;
  mode: AlarmMode;
  prompt: string;
  wakeReason: WakeReason;
  nextDueAt: string;
  state: "scheduled" | "overdue" | "in-flight" | "completed" | "cancelled" | "failed" | "paused";
  deliveryMode: "host";
  /** Repeat randomness 0..1; present only for jittered repeats. */
  jitter?: number;
}

/** Input failure that maps to a closed, stable public code. */
export class ProactiveInputError extends Error {
  readonly code: ProactiveErrorCode;
  constructor(code: ProactiveErrorCode, message: string) {
    super(message);
    this.name = "ProactiveInputError";
    this.code = code;
  }
}

const UTC_INSTANT = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5][0-9]:[0-5][0-9]\.\d{3}Z$/;
const OFFSET_INSTANT = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?(?<zone>Z|(?<sign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/;
const LOCAL_DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/;
const LOCAL_TIME = /^(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?$/;
const IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/;
const OFFSET_NAME = /^GMT(?:(?<sign>[+-])(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?)?$/;

const MIN_FOUR_DIGIT_YEAR_MS = Date.parse("0001-01-01T00:00:00.000Z");
const MAX_FOUR_DIGIT_YEAR_MS = Date.parse("9999-12-31T23:59:59.999Z");

function groupNumber(groups: Record<string, string | undefined>, key: string): number {
  const value = groups[key];
  if (value === undefined) throw new ProactiveInputError("invalid_trigger", "The trigger value has an invalid shape.");
  return Number(value);
}

function milliseconds(value: string | undefined): number {
  return value === undefined ? 0 : Number(value.padEnd(3, "0"));
}

/** Validate one calendar tuple without consulting any process time zone. */
function calendarEpoch(parts: { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number }): number {
  if (parts.year === 0 || parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31 || parts.hour > 23 || parts.minute > 59 || parts.second > 59) {
    throw new ProactiveInputError("invalid_trigger", "The trigger value must be a real ISO calendar date and time.");
  }
  const epoch = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
  if (!Number.isFinite(epoch) || epoch < MIN_FOUR_DIGIT_YEAR_MS || epoch > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new ProactiveInputError("invalid_trigger", "The trigger value must be representable as a four-digit-year RFC 3339 UTC instant.");
  }
  const probe = new Date(epoch);
  if (probe.getUTCFullYear() !== parts.year || probe.getUTCMonth() + 1 !== parts.month || probe.getUTCDate() !== parts.day) {
    throw new ProactiveInputError("invalid_trigger", "The trigger value must be a real calendar date.");
  }
  return epoch;
}

/** Canonicalize an IANA or UTC zone name. */
export function canonicalizeTimeZone(value: string): string {
  if (value.length === 0 || value.trim() !== value || (value !== "UTC" && !IANA_ZONE.test(value))) {
    throw new ProactiveInputError("invalid_time_zone", "time_zone must be UTC or a valid IANA Area/Location name.");
  }
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new ProactiveInputError("invalid_time_zone", "time_zone must resolve to an IANA Area/Location name.");
  }
  if (canonical !== "UTC" && !IANA_ZONE.test(canonical)) {
    throw new ProactiveInputError("invalid_time_zone", "time_zone must resolve to an IANA Area/Location name.");
  }
  return canonical;
}

/** Decode a canonical four-digit-year RFC 3339 UTC instant. */
export function decodeInstant(value: string): string {
  if (typeof value !== "string" || !UTC_INSTANT.test(value)) throw new ProactiveInputError("invalid_trigger", "The target must be a canonical four-digit-year RFC 3339 UTC instant.");
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) throw new ProactiveInputError("invalid_trigger", "The target is not a real UTC calendar instant.");
  return value;
}

/** The UTC epoch of a canonical instant string. */
export function instantEpoch(value: string): number {
  return Date.parse(value);
}

/** Project one epoch into exact local fields plus the zone offset that produced them. */
function localProjection(formatter: Intl.DateTimeFormat, epoch: number): { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number; offset: number } {
  const values = Object.fromEntries(formatter.formatToParts(epoch).map((part) => [part.type, part.value]));
  const zoneName = values["timeZoneName"];
  const offsetMatch = typeof zoneName === "string" ? OFFSET_NAME.exec(zoneName) : null;
  const offsetGroups = offsetMatch?.groups;
  if (offsetMatch === null || offsetGroups === undefined) throw new ProactiveInputError("invalid_time_zone", "time_zone did not expose a usable UTC offset.");
  const direction = offsetGroups["sign"] === "-" ? -1 : 1;
  const offset = offsetGroups["sign"] === undefined ? 0 : direction * (groupNumber(offsetGroups, "hour") * 3600 + groupNumber(offsetGroups, "minute") * 60 + Number(offsetGroups["second"] ?? "0")) * 1e3;
  return {
    year: Number(values["year"]),
    month: Number(values["month"]),
    day: Number(values["day"]),
    hour: Number(values["hour"]),
    minute: Number(values["minute"]),
    second: Number(values["second"]),
    millisecond: Number(values["fractionalSecond"]),
    offset
  };
}

/** Resolve local wall-clock fields in a zone: earlier instant on overlap, reject gaps. */
export function resolveLocalInstant(parts: { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number }, timeZone: string): number {
  const localEpoch = calendarEpoch(parts);
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
    timeZoneName: "longOffset"
  });
  const offsets = new Set<number>();
  for (const delta of [-1728e5, -864e5, 0, 864e5, 1728e5]) {
    const sample = Math.min(MAX_FOUR_DIGIT_YEAR_MS, Math.max(MIN_FOUR_DIGIT_YEAR_MS, localEpoch + delta));
    offsets.add(localProjection(formatter, sample).offset);
  }
  const candidates: number[] = [];
  let outOfRange = false;
  for (const offset of offsets) {
    const candidate = localEpoch - offset;
    if (candidate < MIN_FOUR_DIGIT_YEAR_MS || candidate > MAX_FOUR_DIGIT_YEAR_MS) {
      outOfRange = true;
      continue;
    }
    const projected = localProjection(formatter, candidate);
    if (
      projected.year === parts.year && projected.month === parts.month && projected.day === parts.day &&
      projected.hour === parts.hour && projected.minute === parts.minute && projected.second === parts.second &&
      projected.millisecond === parts.millisecond
    ) {
      candidates.push(candidate);
    }
  }
  const first = candidates.sort((left, right) => left - right)[0];
  if (first === undefined) {
    if (outOfRange) throw new ProactiveInputError("invalid_trigger", "The scheduled time must be representable as a four-digit-year RFC 3339 UTC instant.");
    throw new ProactiveInputError("invalid_time_zone", "The local at time does not exist in the selected time zone.");
  }
  return first;
}

/** Trim and bound a model-supplied alarm prompt. */
export function validatePrompt(raw: unknown, maxLength: number = MAX_PROMPT_LENGTH): string {
  if (typeof raw !== "string") throw new ProactiveInputError("invalid_prompt", "prompt must be a non-empty string.");
  const prompt = raw.trim();
  if (prompt.length === 0) throw new ProactiveInputError("invalid_prompt", "prompt must be a non-empty string.");
  if (prompt.length > maxLength) throw new ProactiveInputError("invalid_prompt", "prompt must be at most {max} characters.".replace("{max}", String(maxLength)));
  return prompt;
}

export interface LocalAtInput {
  date: string;
  time: string;
  time_zone: string;
}

export type AtInput = string | LocalAtInput;

/** Resolve one at input to { epoch, timeZone }. String must carry an explicit zone. */
export function resolveAtInput(at: AtInput): { epoch: number; timeZone: string } {
  if (typeof at === "string") {
    const match = OFFSET_INSTANT.exec(at);
    const groups = match?.groups;
    if (match === null || groups === undefined) {
      throw new ProactiveInputError("invalid_trigger", "The at string must be a strict RFC 3339 date-time with an explicit Z or numeric offset.");
    }
    const year = Number(groups["year"]);
    const month = Number(groups["month"]);
    const day = Number(groups["day"]);
    const hour = Number(groups["hour"]);
    const minute = Number(groups["minute"]);
    const second = Number(groups["second"]);
    const ms = milliseconds(groups["fraction"]);
    const sign = groups["sign"];
    const offsetMinutes = sign === undefined ? 0 : (sign === "-" ? -1 : 1) * (Number(groups["offsetHour"]) * 60 + Number(groups["offsetMinute"]));
    if (Number(groups["offsetHour"]) > 23 || Number(groups["offsetMinute"]) > 59) {
      throw new ProactiveInputError("invalid_trigger", "The at string must carry a valid UTC offset.");
    }
    // Build the instant from the local fields and the explicit offset, then
    // round-trip it back: the local projection must reproduce the input
    // exactly, so impossible dates (e.g. Feb 31) and offsets >= 24h are rejected.
    const localEpoch = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    const epoch = localEpoch - offsetMinutes * 60_000;
    if (!Number.isFinite(epoch) || epoch < MIN_FOUR_DIGIT_YEAR_MS || epoch > MAX_FOUR_DIGIT_YEAR_MS) {
      throw new ProactiveInputError("invalid_trigger", "The at string must be a real RFC 3339 date-time.");
    }
    const local = new Date(epoch + offsetMinutes * 60_000);
    if (
      local.getUTCFullYear() !== year || local.getUTCMonth() + 1 !== month || local.getUTCDate() !== day ||
      local.getUTCHours() !== hour || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second ||
      local.getUTCMilliseconds() !== ms
    ) {
      throw new ProactiveInputError("invalid_trigger", "The at string must be a real RFC 3339 date-time.");
    }
    return { epoch, timeZone: "UTC" };
  }
  if (typeof at === "object" && at !== null && typeof at["date"] === "string" && typeof at["time"] === "string" && typeof at["time_zone"] === "string") {
    const dateMatch = LOCAL_DATE.exec(at["date"]);
    const timeMatch = LOCAL_TIME.exec(at["time"]);
    const date = dateMatch?.groups;
    const time = timeMatch?.groups;
    if (date === undefined || time === undefined) {
      throw new ProactiveInputError("invalid_trigger", "Local at requires date YYYY-MM-DD and time HH:mm:ss with optional one-to-three digit milliseconds.");
    }
    const timeZone = canonicalizeTimeZone(at["time_zone"]);
    const parts = {
      year: groupNumber(date, "year"),
      month: groupNumber(date, "month"),
      day: groupNumber(date, "day"),
      hour: groupNumber(time, "hour"),
      minute: groupNumber(time, "minute"),
      second: groupNumber(time, "second"),
      millisecond: milliseconds(time["fraction"])
    };
    return { epoch: resolveLocalInstant(parts, timeZone), timeZone };
  }
  throw new ProactiveInputError("invalid_trigger", "at must be a strict RFC 3339 string or a local date/time object.");
}

/** The next occurrence of an every_seconds alarm aligned to its anchor, strictly after now. */
export function nextEveryOccurrence(anchorEpoch: number, everySeconds: number, now: number): number {
  const interval = everySeconds * 1e3;
  if (!Number.isSafeInteger(everySeconds) || everySeconds < MIN_EVERY_SECONDS || !Number.isSafeInteger(interval)) {
    throw new ProactiveInputError("frequency_too_high", "every_seconds must be a safe integer of at least {min} seconds.".replace("{min}", String(MIN_EVERY_SECONDS)));
  }
  // Occurrences are strictly in the future: when now lands exactly on an
  // occurrence, skip to the next one so the scheduler never re-fires at the
  // same instant.
  if (now <= anchorEpoch) return anchorEpoch;
  const k = Math.floor((now - anchorEpoch) / interval) + 1;
  return anchorEpoch + k * interval;
}

/** Uniform(0,1) source for jitter; default Math.random. */
export type RandomSource = () => number;

/**
 * One jittered repeat interval in seconds: the base every_seconds scaled by
 * (1 ± jitter · uniform(0,1)), floored at MIN_EVERY_SECONDS so a heavily
 * jittered interval can never collapse below the validator's floor.
 */
export function jitterInterval(everySeconds: number, jitter: number, random: RandomSource = Math.random): number {
  const j = Math.min(1, Math.max(0, jitter));
  const scale = 1 + (random() * 2 - 1) * j;
  return Math.max(MIN_EVERY_SECONDS, Math.round(everySeconds * scale));
}

/**
 * The next occurrence of a jittered repeat: the wake fires roughly
 * every_seconds after the previous one, with each interval independently
 * scaled by (1 ± jitter). The walk is based on now rather than the original
 * anchor so consecutive wakes stay human rather than metronomic, and it is
 * always strictly in the future (a miss is skipped, never re-fired).
 * jitter 0 degenerates to the exact anchor-aligned grid of nextEveryOccurrence.
 */
export function nextJitteredOccurrence(anchorEpoch: number, everySeconds: number, now: number, jitter: number, random: RandomSource = Math.random): number {
  if (jitter === undefined || jitter === 0) {
    return nextEveryOccurrence(anchorEpoch, everySeconds, now);
  }
  nextEveryOccurrence(anchorEpoch, everySeconds, now); // validates everySeconds + floor
  const intervalMs = jitterInterval(everySeconds, jitter, random) * 1e3;
  return Math.max(now + 1, now + intervalMs);
}

/** Whether the alarm target is still in the future. */
export function requireFuture(epoch: number, now: number): void {
  if (epoch <= now) throw new ProactiveInputError("not_future", "The target must be in the future.");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toAlarmView(alarm: Alarm, now: number): AlarmView {
  const overdue = alarm.status === "scheduled" && instantEpoch(alarm.nextDueAt) <= now;
  return {
    id: alarm.id,
    sessionId: alarm.sessionId,
    mode: alarm.mode,
    prompt: alarm.prompt,
    wakeReason: alarm.wakeReason,
    nextDueAt: alarm.nextDueAt,
    state: overdue ? "overdue" : alarm.status,
    deliveryMode: "host",
    ...(alarm.mode === "repeat" && "everySeconds" in alarm.trigger && typeof alarm.trigger["jitter"] === "number" && alarm.trigger["jitter"] > 0 ? { jitter: alarm.trigger["jitter"] } : {})
  };
}

export function internalError(): ToolError {
  return { code: "internal_error", message: "The proactive operation failed." };
}

export function inputError(error: unknown): ToolError {
  return error instanceof ProactiveInputError ? { code: error.code, message: error.message } : internalError();
}

export function isToolError(value: unknown): value is ToolError {
  return isRecord(value) && typeof value["code"] === "string";
}
