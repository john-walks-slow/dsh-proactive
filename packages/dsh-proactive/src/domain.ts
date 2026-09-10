/**
 * dsh-proactive durable domain (v2): alarm records, run records, validation, and closed error codes.
 * Local-time resolution ports the DST-correct algorithm from @deepseek-ai/dsh-schedule
 * (MIT): overlaps choose the earlier instant, gaps are rejected, and the zone is
 * never imported from the process or browser.
 *
 * v2 model (260907-proactive-alarm-v2):
 *   - wake_reason (heartbeat|alarm) is gone; every alarm carries its own
 *     `respectQuietHours` switch (true = deferred inside quiet hours and gated
 *     by the daily budget; false = user-requested, exempt from both).
 *   - alarm `type`: "once" | "every" | "cron"; all three support a unified
 *     `jitterSeconds` random delay drawn after each scheduled instant.
 *   - the wake destination is decoupled from the creator: `ownerSessionId`
 *     (tools/panel ownership) vs `target` (resume existing / fork from an
 *     existing session / create a new session).
 */

export const PROACTIVE_PLUGIN = "dsh-proactive";
export const MIN_EVERY_SECONDS = 300;
export const MAX_PROMPT_LENGTH = 4000;
export const MAX_NO_REPLY_REASON_LENGTH = 200;
/** Default compaction policy for a new alarm (minimal: keep the no_reply reason in the tombstone). */
export const DEFAULT_COMPACTION: AlarmCompaction = "minimal";
/** All valid compaction values (validation + schema enum share this source). */
export const COMPACTION_MODES: readonly string[] = ["off", "minimal", "aggressive"];
/** Upper bound for the per-occurrence random delay (24h). */
export const MAX_JITTER_SECONDS = 86400;

/**
 * The repo default wake-up instruction: pre-filled into the GUI create form
 * (config.defaultPrompt, editable) so a new alarm starts from the user's
 * standing preset instead of a blank box. Pure constant — domain.ts stays
 * import-free so BOTH the host (config.ts) and the browser client bundle
 * (panel form fallback) share this one source of truth.
 */
export const DEFAULT_WAKE_PROMPT =
  "这是一个 heartbeat reminder，你可以选择与用户发送消息。记得完全进入你的人设和情境。 如果不希望发送消息，则用 proactive_no_reply 安静结束。";

/** dsh session ids are alphanumeric plus `._-`; anything else (slashes, traversals, spaces, UTF-8) is rejected. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** dsh workspace registry ids are generated uuids; the pattern only fails closed on junk shapes. */
export const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

/**
 * Slice by Unicode code points (not UTF-16 units) so a surrogate pair is
 * never split in half — user-facing prompt/preset text may contain emoji.
 */
export function sliceCodePoints(text: string, max: number): string {
  if (max <= 0) return "";
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** Fail closed on session ids that could escape storage paths or scope lookups. */
export function isValidSessionId(sessionId: string): boolean {
  if (sessionId === "" || sessionId.length > 200) return false;
  // "." and ".." would resolve to the sessions root itself — never a real session.
  if (sessionId === "." || sessionId === "..") return false;
  return SESSION_ID_PATTERN.test(sessionId);
}

/** Fail closed on workspace ids that are not registry-uuid shaped (defense in depth for stored alarms). */
export function isValidWorkspaceId(workspaceId: string): boolean {
  return WORKSPACE_ID_PATTERN.test(workspaceId);
}

export type AlarmType = "once" | "every" | "cron";
/** Per-alarm surface compaction policy for silent wake turns. */
export type AlarmCompaction = "off" | "minimal" | "aggressive";
export type TargetMode = "resume" | "fork" | "new" | "workspace";
export type AlarmStatus = "scheduled" | "in-flight" | "completed" | "cancelled" | "failed" | "paused";
export type RunDecision = "no_reply" | "reply" | "skipped" | "failed";

/**
 * Where the wake should land. `resume`/`fork` name an existing session; `new`
 * creates one; `workspace` names a dsh workspace registry id and resolves the
 * destination at fire time (most recently updated session in the workspace,
 * else the workspace's blank New Session slot, else a fresh session attached
 * to the workspace — see workspace.ts).
 */
export type AlarmTarget =
  | { mode: "resume"; sessionId: string }
  | { mode: "fork"; sessionId: string }
  | { mode: "new" }
  | { mode: "workspace"; workspaceId: string };

export interface OnceTrigger {
  /** Canonical RFC 3339 UTC instant. */
  at: string;
}

export interface EveryTrigger {
  everySeconds: number;
  /** Grid anchor: occurrences stay aligned to this instant (misses are skipped, never re-fired). */
  anchor: string;
  /** Optional per-occurrence random delay in seconds; absent/0 = exact grid. */
  jitterSeconds?: number;
}

export interface CronTrigger {
  /** Five-field numeric cron expression (minute hour dom month dow). */
  expr: string;
  /** Optional per-occurrence random delay in seconds; absent/0 = exact cron moments. */
  jitterSeconds?: number;
}

export type AlarmTrigger = OnceTrigger | EveryTrigger | CronTrigger;

export interface Alarm {
  id: string;
  /** Creator session; scopes proactive_list/cancel and the panel ownership guard. */
  ownerSessionId: string;
  /** Wake destination, decoupled from the creator. */
  target: AlarmTarget;
  type: AlarmType;
  trigger: AlarmTrigger;
  prompt: string;
  /** true = defer inside quiet hours and gate by the daily budget; false = user-requested, exempt from both. */
  respectQuietHours: boolean;
  /** IANA zone for cron/every alignment and quiet-hours display; "UTC" default. */
  timeZone: string;
  status: AlarmStatus;
  nextDueAt: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastRunAt: string | null;
  /** Per-alarm silent-wake surface compaction policy; absent = DEFAULT_COMPACTION (legacy records). */
  compaction?: AlarmCompaction;
}

export interface RunRecord {
  id: string;
  alarmId: string;
  /** The session the wake actually ran in (a fork/new child for those target modes). */
  sessionId: string;
  firedAt: string;
  decision: RunDecision;
  budgetDelta: number;
  note?: string;
  /** Truncated reasoning (thinking) summary of the wake turn, for the panel history. */
  reasoningSummary?: string;
  /** Truncated visible-reply summary of the wake turn, for the panel history. */
  replySummary?: string;
  /** The no_reply reason the model gave for staying silent, for the panel history. */
  noReplyReason?: string;
}

/**
 * Wire view of one alarm. `sessionId` deliberately keeps its old meaning of
 * OWNER so the GUI (filters, session column, copy-id) stays source-compatible;
 * the wake destination is surfaced separately via targetMode/targetSessionId.
 */
export type AlarmView = {
  id: string;
  sessionId: string;
  type: AlarmType;
  targetMode: TargetMode;
  /** Present for resume/fork targets. */
  targetSessionId?: string;
  /** Present for workspace targets. */
  targetWorkspaceId?: string;
  respectQuietHours: boolean;
  prompt: string;
  nextDueAt: string;
  state: "scheduled" | "overdue" | "in-flight" | "completed" | "cancelled" | "failed" | "paused";
  deliveryMode: "host";
  /** Per-alarm silent-wake surface compaction policy. */
  compaction: AlarmCompaction;
  /** Unified per-occurrence random delay in seconds; present only when > 0. */
  jitterSeconds?: number;
  everySeconds?: number;
  cron?: string;
  at?: string;
  /** The alarm's canonical zone (drives at/cron alignment and wake framing). */
  timeZone?: string;
}

export type ProactiveErrorCode =
  | "invalid_prompt"
  | "invalid_trigger"
  | "invalid_action"
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

/**
 * A local-time projector over one epoch: exact wall-clock fields plus the zone
 * offset that produced them. Structured so callers (quiet-hours, cron) share
 * one DST-correct projection machinery that never consults the process zone.
 */
export function makeLocalFormatter(timeZone: string, extra?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
    timeZoneName: "longOffset",
    ...extra
  });
}

/** Project one epoch into exact local fields plus the zone offset that produced them. */
export function localProjection(formatter: Intl.DateTimeFormat, epoch: number): { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number; offset: number; weekday?: string } {
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
    offset,
    ...(typeof values["weekday"] === "string" ? { weekday: values["weekday"] } : {})
  };
}

/** Resolve local wall-clock fields in a zone: earlier instant on overlap, reject gaps. */
export function resolveLocalInstant(parts: { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number }, timeZone: string): number {
  const localEpoch = calendarEpoch(parts);
  const formatter = makeLocalFormatter(timeZone);
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

/** Validate the unified jitter knob: integer seconds 0..MAX_JITTER_SECONDS. */
export function validateJitterSeconds(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_JITTER_SECONDS) {
    throw new ProactiveInputError("invalid_trigger", "jitter_seconds must be an integer in 0..{max}.".replace("{max}", String(MAX_JITTER_SECONDS)));
  }
  return raw;
}

/** One random delay in milliseconds for jitter_seconds; 0 when the knob is absent/zero. */
export function jitterDelay(jitterSeconds: number | undefined, random: RandomSource = Math.random): number {
  if (jitterSeconds === undefined || jitterSeconds <= 0) return 0;
  return Math.floor(random() * jitterSeconds * 1000);
}

/**
 * The next occurrence of an every alarm: the anchor-aligned grid instant plus
 * a random delay drawn now. The grid itself never drifts (delays are applied
 * to the fire time, not to the interval), and a miss is skipped, never
 * re-fired (strictly after now). jitterSeconds 0 degenerates to the exact grid.
 */
export function nextJitteredOccurrence(anchorEpoch: number, everySeconds: number, now: number, jitterSeconds: number | undefined, random: RandomSource = Math.random): number {
  const scheduled = nextEveryOccurrence(anchorEpoch, everySeconds, now);
  return scheduled + jitterDelay(jitterSeconds, random);
}

/** Whether the alarm target time is still in the future. */
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
    sessionId: alarm.ownerSessionId,
    type: alarm.type,
    targetMode: alarm.target.mode,
    ...("sessionId" in alarm.target ? { targetSessionId: alarm.target.sessionId } : {}),
    ...("workspaceId" in alarm.target ? { targetWorkspaceId: alarm.target.workspaceId } : {}),
    respectQuietHours: alarm.respectQuietHours,
    prompt: alarm.prompt,
    nextDueAt: alarm.nextDueAt,
    state: overdue ? "overdue" : alarm.status,
    deliveryMode: "host",
    compaction: alarm.compaction ?? DEFAULT_COMPACTION,
    ...(alarm.type === "every" && "everySeconds" in alarm.trigger
      ? { everySeconds: alarm.trigger["everySeconds"], ...(typeof alarm.trigger["jitterSeconds"] === "number" && alarm.trigger["jitterSeconds"] > 0 ? { jitterSeconds: alarm.trigger["jitterSeconds"] } : {}) }
      : {}),
    ...(alarm.type === "cron" && "expr" in alarm.trigger
      ? { cron: alarm.trigger["expr"], ...(typeof alarm.trigger["jitterSeconds"] === "number" && alarm.trigger["jitterSeconds"] > 0 ? { jitterSeconds: alarm.trigger["jitterSeconds"] } : {}) }
      : {}),
    ...(alarm.type === "once" && "at" in alarm.trigger ? { at: alarm.trigger["at"] } : {}),
    ...(alarm.timeZone !== undefined ? { timeZone: alarm.timeZone } : {})
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