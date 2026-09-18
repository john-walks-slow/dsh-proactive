/**
 * Durable host-level store for dsh-proactive.
 *
 *   alarms.json  — one object { version, alarms: Alarm[] }  (atomic tmp+rename)
 *   runs.jsonl   — append-only run records
 *   state.json   — per-UTC-day delivery budget + plugin-created session bookkeeping
 *
 * A corrupt alarms.json never bricks the plugin: load() falls back to an empty
 * store and surfaces { code: "corrupt_store" } from tools that would mutate it.
 *
 * v2 (260907-proactive-alarm-v2): STORE_VERSION moved 1 -> 2. Legacy v1
 * records are normalized in memory on load (sessionId -> ownerSessionId +
 * target.resume; wakeReason "alarm" -> respectQuietHours false, any other ->
 * true; repeat jitter 0..1 rounded onto the unified jitterSeconds; unknown
 * legacy fields such as deliveryHint dropped). The on-disk file is rewritten
 * as version 2 on the next persist.
 */

import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { COMPACTION_MODES, isRecord, isValidPresetId, isValidWorkspaceId, type Alarm, type AlarmTarget, type AlarmTrigger, type AlarmType, type CreatedSessionKind, type CreatedSessionRecord, type RunRecord } from "./domain.js";

export interface StoreState {
  version: number;
  alarms: Alarm[];
}

/**
 * state.json contents: the per-UTC-day delivery budget plus the bookkeeping
 * for sessions this plugin created itself (new-mode products, fork children).
 */
export interface HostState {
  date: string;
  delivered: number;
  /** Newest last; bounded by MAX_CREATED_SESSIONS (excess ids age out harmlessly — at worst an ancient wake-only session becomes capturable again). */
  createdSessions: CreatedSessionRecord[];
}

/** Keeps state.json bounded across long-lived repeating new/fork alarms. */
export const MAX_CREATED_SESSIONS = 1024;

const STORE_VERSION = 2;
const STORE_FILE = "alarms.json";
const RUNS_FILE = "runs.jsonl";
const STATE_FILE = "state.json";

const LEGACY_REASONS = { alarm: false, heartbeat: true } as const;

const TARGET_MODES: readonly string[] = ["resume", "fork", "new", "workspace"];
const TARGET_SOURCES: readonly string[] = ["session", "workspace", "preset"];
const ALARM_TYPES: readonly string[] = ["once", "every", "cron"];
const ALARM_STATUSES: readonly string[] = ["scheduled", "in-flight", "completed", "cancelled", "failed", "paused"];

function isTriggerForType(type: AlarmType, trigger: unknown): boolean {
  if (!isRecord(trigger)) return false;
  if (type === "once") return typeof trigger["at"] === "string";
  if (type === "every") return typeof trigger["everySeconds"] === "number" && (trigger["anchor"] === undefined || typeof trigger["anchor"] === "string") && (trigger["jitterSeconds"] === undefined || typeof trigger["jitterSeconds"] === "number");
  return typeof trigger["expr"] === "string";
}

/**
 * Stored-target shape check. v3 targets carry a sourceType for resume/fork
 * (session | workspace | preset) and optional workspaceId/presetId/provider/
 * model on "new"; v2 records (sourceType absent, sessionId always present)
 * keep loading unchanged — the source folds to "session".
 */
function targetIsValid(target: Record<string, unknown>): boolean {
  if (target["mode"] === "workspace") {
    return typeof target["workspaceId"] === "string" && isValidWorkspaceId(target["workspaceId"]);
  }
  if (target["mode"] === "new") {
    if (target["sessionId"] !== undefined) return false;
    if (target["sourceType"] !== undefined) return false;
    if (target["workspaceId"] !== undefined && (typeof target["workspaceId"] !== "string" || !isValidWorkspaceId(target["workspaceId"]))) return false;
    if (target["presetId"] !== undefined && typeof target["presetId"] !== "string") return false;
    if (target["provider"] !== undefined && typeof target["provider"] !== "string") return false;
    if (target["model"] !== undefined && typeof target["model"] !== "string") return false;
    return true;
  }
  if (target["mode"] === "resume" || target["mode"] === "fork") {
    if (target["provider"] !== undefined || target["model"] !== undefined) return false;
    const source = target["sourceType"];
    if (source === undefined) {
      // v2 record: a plain sessionId target; a workspaceId/presetId next to it
      // is the v3 spelling and must come with its sourceType.
      return typeof target["sessionId"] === "string" && target["workspaceId"] === undefined && target["presetId"] === undefined;
    }
    if (!TARGET_SOURCES.includes(source as string)) return false;
    if (source === "session") {
      return typeof target["sessionId"] === "string" && target["workspaceId"] === undefined && target["presetId"] === undefined;
    }
    if (source === "workspace") {
      return typeof target["workspaceId"] === "string" && isValidWorkspaceId(target["workspaceId"]) && target["sessionId"] === undefined && target["presetId"] === undefined;
    }
    return typeof target["presetId"] === "string" && isValidPresetId(target["presetId"]) && target["sessionId"] === undefined && target["workspaceId"] === undefined;
  }
  return false;
}

function alarmIsValid(value: unknown): value is Alarm {
  if (!isRecord(value)) return false;
  if (typeof value["id"] !== "string" || typeof value["ownerSessionId"] !== "string") return false;
  if (typeof value["prompt"] !== "string" || typeof value["respectQuietHours"] !== "boolean") return false;
  if (typeof value["timeZone"] !== "string" || typeof value["nextDueAt"] !== "string") return false;
  if (typeof value["type"] !== "string" || !ALARM_TYPES.includes(value["type"])) return false;
  const type = value["type"] as AlarmType;
  if (!ALARM_STATUSES.includes(value["status"] as string)) return false;
  const target = value["target"];
  if (!isRecord(target) || typeof target["mode"] !== "string" || !TARGET_MODES.includes(target["mode"])) return false;
  if (!targetIsValid(target)) return false;
  // compaction is optional: absent = DEFAULT_COMPACTION (legacy v2 records);
  // a present value must be a known mode so a typo never silently degrades.
  const compaction = value["compaction"];
  if (compaction !== undefined && (typeof compaction !== "string" || !COMPACTION_MODES.includes(compaction))) return false;
  // minIdleSeconds is optional: absent/0 = off (legacy records); a present
  // value must be a safe integer within the dialect's ceiling.
  const minIdleSeconds = value["minIdleSeconds"];
  if (minIdleSeconds !== undefined && (typeof minIdleSeconds !== "number" || !Number.isSafeInteger(minIdleSeconds) || minIdleSeconds < 0 || minIdleSeconds > 86400)) return false;
  // declared provenance is optional; a present value must carry the full
  // triple (file / entry / hash) so a partial record can never be mistaken
  // for a synced one.
  const declared = value["declared"];
  if (declared !== undefined) {
    if (!isRecord(declared)) return false;
    if (typeof declared["file"] !== "string" || declared["file"].length === 0) return false;
    if (typeof declared["entry"] !== "string" || declared["entry"].length === 0) return false;
    if (typeof declared["hash"] !== "string" || declared["hash"].length === 0) return false;
  }
  return isTriggerForType(type, value["trigger"]);
}

/** Map a legacy v1 alarm record onto the v2 model; undefined when the record is unusable. */
function normalizeV1(value: unknown): Alarm | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value["id"] !== "string" || typeof value["sessionId"] !== "string" || typeof value["nextDueAt"] !== "string") return undefined;
  const id = value["id"];
  const ownerSessionId = value["sessionId"];
  const legacyMode = value["mode"];
  const nowIso = new Date().toISOString();
  let type: AlarmType;
  let trigger: AlarmTrigger;
  if (legacyMode === "one-shot" && isRecord(value["trigger"]) && typeof value["trigger"]["at"] === "string") {
    type = "once";
    trigger = { at: value["trigger"]["at"] };
  } else if (legacyMode === "repeat" && isRecord(value["trigger"]) && typeof value["trigger"]["everySeconds"] === "number" && typeof value["trigger"]["anchor"] === "string") {
    type = "every";
    const everySeconds = value["trigger"]["everySeconds"];
    const jitter = value["trigger"]["jitter"];
    const jitterSeconds = typeof jitter === "number" && jitter > 0 ? Math.min(everySeconds, Math.max(0, Math.round(jitter * everySeconds))) : undefined;
    trigger = { everySeconds, anchor: value["trigger"]["anchor"], ...(jitterSeconds !== undefined ? { jitterSeconds } : {}) };
  } else {
    return undefined;
  }
  const legacyReason = typeof value["wakeReason"] === "string" && value["wakeReason"] in LEGACY_REASONS ? value["wakeReason"] as keyof typeof LEGACY_REASONS : "heartbeat";
  return {
    id,
    ownerSessionId,
    target: { mode: "resume", sessionId: ownerSessionId },
    type,
    trigger,
    prompt: typeof value["prompt"] === "string" ? value["prompt"] : "",
    respectQuietHours: LEGACY_REASONS[legacyReason],
    timeZone: typeof value["timeZone"] === "string" ? value["timeZone"] : "UTC",
    status: typeof value["status"] === "string" && ALARM_STATUSES.includes(value["status"]) ? value["status"] as Alarm["status"] : "scheduled",
    nextDueAt: value["nextDueAt"],
    createdAt: typeof value["createdAt"] === "string" ? value["createdAt"] : nowIso,
    updatedAt: typeof value["updatedAt"] === "string" ? value["updatedAt"] : nowIso,
    runCount: typeof value["runCount"] === "number" ? value["runCount"] : 0,
    lastRunAt: typeof value["lastRunAt"] === "string" ? value["lastRunAt"] : null
  };
}

/** Tolerant read of the createdSessions array: invalid entries drop, order kept. */
function parseCreatedSessions(value: unknown): CreatedSessionRecord[] {
  if (!Array.isArray(value)) return [];
  const records: CreatedSessionRecord[] = [];
  for (const entry of value) {
    if (isRecord(entry) && typeof entry["sessionId"] === "string" && (entry["kind"] === "new" || entry["kind"] === "fork") && typeof entry["createdAt"] === "string") {
      records.push({ sessionId: entry["sessionId"], kind: entry["kind"], createdAt: entry["createdAt"] });
    }
  }
  return records.slice(-MAX_CREATED_SESSIONS);
}

export class ProactiveStore {
  readonly dataDir: string;
  /** Set when alarms.json could not be fully trusted on load; mutating tools reject. */
  corrupt = false;
  private state: StoreState;
  private host: HostState;
  private changeListeners = new Set<() => void>();
  /** Subscribe to every store mutation (alarms/budget/runs); returns the disposer. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }

  constructor(dataDir: string, initial?: StoreState, initialHost?: HostState) {
    this.dataDir = dataDir;
    this.state = initial ?? { version: STORE_VERSION, alarms: [] };
    this.host = initialHost ?? { date: "1970-01-01", delivered: 0, createdSessions: [] };
  }

  /** Load from disk; corrupt files degrade to an empty in-memory store (never throw). */
  static async load(dataDir: string): Promise<{ store: ProactiveStore; corrupt: boolean }> {
    const store = new ProactiveStore(dataDir);
    let corrupt = false;
    try {
      const raw = await readFile(dataDir + "/" + STORE_FILE, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && Array.isArray(parsed["alarms"])) {
        const records = parsed["alarms"] as unknown[];
        const alarms: Alarm[] = [];
        if (parsed["version"] === STORE_VERSION) {
          for (const record of records) {
            if (alarmIsValid(record)) alarms.push(record);
            else corrupt = true;
          }
        } else if (parsed["version"] === 1) {
          // v1 -> v2 in-memory normalization; the file is rewritten on next persist.
          for (const record of records) {
            const migrated = normalizeV1(record);
            if (migrated !== undefined) alarms.push(migrated);
            else corrupt = true;
          }
        } else {
          corrupt = true;
        }
        store.state = { version: STORE_VERSION, alarms };
      } else {
        corrupt = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") corrupt = true;
    }
    try {
      const rawHost = await readFile(dataDir + "/" + STATE_FILE, "utf8");
      const parsed: unknown = JSON.parse(rawHost);
      if (isRecord(parsed) && typeof parsed["date"] === "string" && typeof parsed["delivered"] === "number" && Number.isInteger(parsed["delivered"])) {
        store.host = { date: parsed["date"], delivered: parsed["delivered"], createdSessions: parseCreatedSessions(parsed["createdSessions"]) };
      }
    } catch {
      /* missing/state.json corrupt are both acceptable; budget restarts from zero */
    }
    return { store, corrupt };
  }

  listAlarms(): readonly Alarm[] {
    return this.state.alarms;
  }

  getAlarm(id: string): Alarm | undefined {
    return this.state.alarms.find((alarm) => alarm.id === id);
  }

  addAlarm(alarm: Alarm): void {
    this.state.alarms.push(alarm);
    this.emitChange();
  }

  replaceAlarm(updated: Alarm): void {
    const index = this.state.alarms.findIndex((alarm) => alarm.id === updated.id);
    if (index >= 0) {
      this.state.alarms[index] = updated;
      this.emitChange();
    }
  }

  removeAlarm(id: string): Alarm | undefined {
    const index = this.state.alarms.findIndex((alarm) => alarm.id === id);
    if (index < 0) return undefined;
    const [removed] = this.state.alarms.splice(index, 1);
    this.emitChange();
    return removed;
  }

  async persist(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const target = this.dataDir + "/" + STORE_FILE;
    const tmp = target + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2);
    await writeFile(tmp, JSON.stringify(this.state, null, 2) + "\n", "utf8");
    await rename(tmp, target);
  }

  async appendRun(record: RunRecord): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await appendFile(this.dataDir + "/" + RUNS_FILE, JSON.stringify(record) + "\n", "utf8");
    this.emitChange();
  }

  /** Budget for one UTC day; a new day resets the counter. */
  budgetFor(utcDate: string): number {
    if (this.host.date !== utcDate) return 0;
    return this.host.delivered;
  }

  /** Add one (or zero/negative log) chat-text delivery unit for a UTC day and persist the counter. */
  async spendBudget(utcDate: string, delta: number): Promise<number> {
    if (this.host.date !== utcDate) this.host = { date: utcDate, delivered: 0, createdSessions: this.host.createdSessions };
    this.host.delivered = Math.max(0, this.host.delivered + delta);
    await this.persistHost();
    this.emitChange();
    return this.host.delivered;
  }

  /** Creation kind of a plugin-created session; undefined for user sessions. */
  createdSessionKind(sessionId: string): CreatedSessionKind | undefined {
    return this.host.createdSessions.find((record) => record.sessionId === sessionId)?.kind;
  }

  /**
   * Bookkeep one session this plugin created, then persist state.json. The
   * in-memory book updates even when the write fails (this process keeps the
   * exclusion; a restart loses it — the caller warns).
   */
  async recordCreatedSession(sessionId: string, kind: CreatedSessionKind): Promise<void> {
    if (this.createdSessionKind(sessionId) !== undefined) return;
    const createdSessions = [...this.host.createdSessions, { sessionId, kind, createdAt: new Date().toISOString() }];
    this.host = { ...this.host, createdSessions: createdSessions.slice(-MAX_CREATED_SESSIONS) };
    await this.persistHost();
  }

  /** Atomic state.json write shared by every HostState mutation. */
  private async persistHost(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const target = this.dataDir + "/" + STATE_FILE;
    const tmp = target + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2);
    await writeFile(tmp, JSON.stringify(this.host, null, 2) + "\n", "utf8");
    await rename(tmp, target);
  }

  /** Latest run records from runs.jsonl, oldest-to-newest within the window. */
  async listRecentRuns(limit: number): Promise<RunRecord[]> {
    if (limit <= 0) return [];
    try {
      const raw = await readFile(this.dataDir + "/" + RUNS_FILE, "utf8");
      const lines = raw.split("\n").filter((line) => line.trim() !== "").slice(-limit);
      const runs: RunRecord[] = [];
      for (const line of lines) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRecord(parsed) && typeof parsed["id"] === "string" && typeof parsed["firedAt"] === "string") runs.push(parsed as unknown as RunRecord);
        } catch {
          /* one malformed tail line never blocks the panel */
        }
      }
      return runs;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") this.emitChange();
      return [];
    }
  }
}