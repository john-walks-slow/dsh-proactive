/**
 * Durable host-level store for dsh-proactive.
 *
 *   alarms.json  — one object { version, alarms: Alarm[] }  (atomic tmp+rename)
 *   runs.jsonl   — append-only run records
 *   state.json   — per-UTC-day delivery budget counter
 *
 * A corrupt alarms.json never bricks the plugin: load() falls back to an empty
 * store and surfaces { code: "corrupt_store" } from tools that would mutate it.
 */

import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { isRecord, type Alarm, type RunRecord } from "./domain.js";

export interface StoreState {
  version: number;
  alarms: Alarm[];
}

export interface BudgetState {
  date: string;
  delivered: number;
}

const STORE_VERSION = 1;
const STORE_FILE = "alarms.json";
const RUNS_FILE = "runs.jsonl";
const STATE_FILE = "state.json";

function alarmIsValid(value: unknown): value is Alarm {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["sessionId"] === "string" && typeof value["nextDueAt"] === "string";
}

export class ProactiveStore {
  readonly dataDir: string;
  /** Set when alarms.json could not be fully trusted on load; mutating tools reject. */
  corrupt = false;
  private state: StoreState;
  private budget: BudgetState;
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

  constructor(dataDir: string, initial?: StoreState, initialBudget?: BudgetState) {
    this.dataDir = dataDir;
    this.state = initial ?? { version: STORE_VERSION, alarms: [] };
    this.budget = initialBudget ?? { date: "1970-01-01", delivered: 0 };
  }

  /** Load from disk; corrupt files degrade to an empty in-memory store (never throw). */
  static async load(dataDir: string): Promise<{ store: ProactiveStore; corrupt: boolean }> {
    const store = new ProactiveStore(dataDir);
    let corrupt = false;
    try {
      const raw = await readFile(dataDir + "/" + STORE_FILE, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && parsed["version"] === STORE_VERSION && Array.isArray(parsed["alarms"])) {
        store.state = { version: STORE_VERSION, alarms: parsed["alarms"].filter(alarmIsValid) };
        if (store.state.alarms.length !== (parsed["alarms"] as unknown[]).length) corrupt = true;
      } else {
        corrupt = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") corrupt = true;
    }
    try {
      const rawBudget = await readFile(dataDir + "/" + STATE_FILE, "utf8");
      const parsed: unknown = JSON.parse(rawBudget);
      if (isRecord(parsed) && typeof parsed["date"] === "string" && typeof parsed["delivered"] === "number" && Number.isInteger(parsed["delivered"])) {
        store.budget = { date: parsed["date"], delivered: parsed["delivered"] };
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
    if (this.budget.date !== utcDate) return 0;
    return this.budget.delivered;
  }

  /** Add one (or zero/negative log) delivery unit for a UTC day and persist the counter. */
  async spendBudget(utcDate: string, delta: number): Promise<number> {
    if (this.budget.date !== utcDate) this.budget = { date: utcDate, delivered: 0 };
    this.budget.delivered = Math.max(0, this.budget.delivered + delta);
    await mkdir(this.dataDir, { recursive: true });
    const target = this.dataDir + "/" + STATE_FILE;
    const tmp = target + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2);
    await writeFile(tmp, JSON.stringify(this.budget, null, 2) + "\n", "utf8");
    await rename(tmp, target);
    this.emitChange();
    return this.budget.delivered;
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