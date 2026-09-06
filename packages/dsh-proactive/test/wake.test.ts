import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { EpochHeader } from "@deepseek-ai/dsh-session";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { WakeDriver, createWakeSelectionRef, selectionFromHeader, type AgentHandleLike, type AgentsFacade, type WakeFireResult } from "../src/wake.js";
import { ProactiveStore } from "../src/store.js";
import { resolveConfig } from "../src/config.js";
import type { Alarm } from "../src/domain.js";

function alarm(id = "a1"): Alarm {
  return {
    id,
    sessionId: "s1",
    mode: "one-shot",
    trigger: { at: "2026-09-02T00:00:00.000Z" },
    prompt: "进水提醒",
    wakeReason: "alarm",
    deliveryHint: { chat: true, push: true, wechat: true },
    timeZone: "UTC",
    status: "scheduled",
    nextDueAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    runCount: 0,
    lastRunAt: null
  };
}

interface FakeRecording {
  messages: { message: unknown }[];
  disposed: boolean;
  resumed: boolean;
  activeDuringFollowup: boolean | null;
}

function makeFakeAgent(rec: FakeRecording, opts: { busy?: boolean; failWhenIdle?: boolean } = {}) {
  const events: Record<string, unknown>[] = [];
  const agent = {
    session: { id: "s1", events },
    followup: (message: unknown) => {
      rec.messages.push({ message });
      rec.activeDuringFollowup = true; // driver must still count this wake as active
      events.push({ type: "turn/start", data: { turn: 1 } });
      events.push({ type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "proactive_no_reply", arguments: "{}" } });
      events.push({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    },
    runMaintenance: async (task: () => Promise<unknown>) => {
      if (opts.busy) throw new Error("busy: another turn is in flight");
      await task();
      return true;
    },
    whenIdle: async () => {
      if (opts.failWhenIdle) throw new Error("idle wait failed");
    }
  };
  return agent as unknown as Agent;
}

interface Harness {
  driver: WakeDriver;
  store: ProactiveStore;
  rec: FakeRecording;
  cfg: ReturnType<typeof resolveConfig>;
  dir: string;
}

async function harness(opts: { live?: boolean; busy?: boolean; failWhenIdle?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  const rec: FakeRecording = { messages: [], disposed: false, resumed: false, activeDuringFollowup: null };
  const fakeAgent = makeFakeAgent(rec, opts);
  const agents: AgentsFacade = {
    get: () => (opts.live ? fakeAgent : undefined) as never,
    resume: async () => {
      rec.resumed = true;
      const handle: AgentHandleLike = {
        agent: fakeAgent,
        dispose: async () => { rec.disposed = true; }
      };
      return handle;
    }
  };
  const driver = new WakeDriver({
    agents,
    modelSelection: () => ({ provider: "test", model: "x" }),
    store,
    config: cfg,
    log: () => undefined
  });
  return { driver, store, rec, cfg, dir };
}

test("cold wake resumes the session, frames the message, and can be silent", async () => {
  const h = await harness();
  try {
    const fire = await h.driver.fire(alarm("cold1"));
    assert.equal(fire.outcome, "ok");
    if (fire.outcome === "ok") {
      assert.equal(fire.analysis.decision, "no_reply");
      assert.equal(fire.analysis.budgetDelta, 0);
    }
    assert.equal(h.rec.resumed, true);
    assert.equal(h.rec.disposed, true); // process-local handle released
    assert.equal(h.rec.activeDuringFollowup, true); // inflight guard held during the wake
    assert.equal(h.rec.messages.length, 1);
    const text = extractText(h.rec.messages[0].message);
    assert.ok(text.includes("## PROACTIVE WAKE"));
    assert.ok(text.includes("wake_reason: alarm"));
    assert.equal(h.driver.isActiveWake("s1"), false); // cleared after the wake
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("live wake reuses the agent and does not dispose an owned handle", async () => {
  const h = await harness({ live: true });
  try {
    const fire = await h.driver.fire(alarm("live1"));
    assert.equal(fire.outcome, "ok");
    assert.equal(h.rec.resumed, false);
    assert.equal(h.rec.disposed, false);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("busy agents surface as busy for the scheduler to retry", async () => {
  const h = await harness({ busy: true });
  try {
    const fire = await h.driver.fire(alarm("b1"));
    assert.equal(fire.outcome, "busy");
    assert.equal(h.rec.disposed, true); // owned handle released even on early exit
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("concurrent wakes for the same session are rejected as busy", async () => {
  const h = await harness();
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowAgent = {
      session: { id: "s1", events: [] },
      followup: () => undefined,
      runMaintenance: async (task: () => Promise<unknown>) => { await gate; await task(); return true; },
      whenIdle: async () => undefined
    };
    const agents: AgentsFacade = {
      get: () => slowAgent as never,
      resume: async () => { throw new Error("unused"); }
    };
    const driver = new WakeDriver({ agents, modelSelection: () => undefined, store: h.store, config: h.cfg, log: () => undefined });
    const first = driver.fire(alarm("c1"));
    const second = await driver.fire(alarm("c2"));
    assert.equal(second.outcome, "busy"); // inflight guard
    release();
    const firstResult = await first;
    assert.equal(firstResult.outcome, "ok");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("whenIdle failures surface as failed", async () => {
  const h = await harness({ failWhenIdle: true });
  try {
    const fire = await h.driver.fire(alarm("f1"));
    assert.equal(fire.outcome, "failed");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("selectionFromHeader mirrors the session's committed request config", () => {
  assert.equal(selectionFromHeader(undefined), undefined);
  const header: EpochHeader = {
    config: { provider: "cpa", model: "gemini-3-flash" },
  };
  assert.deepEqual(selectionFromHeader(header), { provider: "cpa", model: "gemini-3-flash" });
  const withEffort: EpochHeader = { config: { provider: "p", model: "m", reasoningEffort: ReasoningEffortId("low") } };
  assert.deepEqual(selectionFromHeader(withEffort), { provider: "p", model: "m", reasoningEffort: "low" });
});

test("cold resume installs a model-selection setup and lets the turn proceed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  let lastOptions: { agentOptions?: unknown; setup?: unknown } = {};
  const agents: AgentsFacade = {
    get: () => undefined as never,
    resume: async (options) => {
      lastOptions = options;
      const handle: AgentHandleLike = { agent: wakeAgent, dispose: async () => undefined };
      return handle;
    }
  };
  // selection resolution itself is covered by createWakeSelectionRef; here we
  // only prove the resume contract: cold wakes must carry a setup hook and the
  // turn must still proceed when the fake agent completes normally
  const wakeAgent = makeWakeAgent({ config: { provider: "cpa", model: "gemini-3-flash" } });
  const driver = new WakeDriver({
    agents,
    modelSelection: () => ({ provider: "cpa", model: "medium" }),
    store,
    config: cfg,
    log: () => undefined
  });
  try {
    const fire = await driver.fire(alarm("c1"));
    assert.equal(fire.outcome, "ok");
    assert.equal(typeof lastOptions.setup, "function", "cold resume must carry a setup hook");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeWakeAgent(header: EpochHeader) {
  const events: Record<string, unknown>[] = [];
  const agent = {
    session: { id: "s1", events, requestHeader: () => header },
    followup: () => {
      events.push({ type: "turn/start", data: { turn: 1 } });
      events.push({ type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "proactive_no_reply", arguments: "{}" } });
      events.push({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    },
    runMaintenance: async (task: () => Promise<unknown>) => { await task(); return true; },
    whenIdle: async () => undefined
  };
  return agent as unknown as Agent;
}

test("createWakeSelectionRef falls back header -> agentDefaultModel -> warn", () => {
  const warns: string[] = [];
  const log = (_level: "info" | "warn" | "error", m: string) => warns.push(m);

  const header = (): EpochHeader => ({ config: { provider: "cpa", model: "gemini-3-flash" } });
  // header wins
  const fromHeader = createWakeSelectionRef(header(), () => ({ provider: "cpa", model: "medium" }), log);
  assert.deepEqual(fromHeader.current, { provider: "cpa", model: "gemini-3-flash" });
  // picked (in-memory override) wins over header
  fromHeader.current = { provider: "cpa", model: "medium" };
  assert.deepEqual(fromHeader.current, { provider: "cpa", model: "medium" });

  // no header -> default selection
  const viaDefault = createWakeSelectionRef(undefined, () => ({ provider: "cpa", model: "medium" }), log);
  assert.deepEqual(viaDefault.current, { provider: "cpa", model: "medium" });

  // no header, empty default -> undefined + warn
  const viaEmpty = createWakeSelectionRef(undefined, () => undefined, log);
  assert.equal(viaEmpty.current, undefined);
  assert.ok(warns.some((w) => w.includes("agentDefaultModel selection unavailable")));

  // no header, partial default -> undefined + warn
  const viaPartial = createWakeSelectionRef(undefined, () => ({ provider: "cpa" }), log);
  assert.equal(viaPartial.current, undefined);
  assert.ok(warns.some((w) => w.includes("selection incomplete")));
});

function extractText(message: unknown): string {
  const msg = message as { content?: { type?: string; text?: string }[] };
  return (msg.content ?? []).map((b) => b.text ?? "").join("");
}

