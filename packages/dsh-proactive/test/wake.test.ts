import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, deriveEventMessage, type EpochHeader } from "@deepseek-ai/dsh-session";
import { CallId, ReasoningEffortId, createAssistantMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { WakeDriver, createWakeSelectionRef, selectionFromHeader, completedTurnCut, sessionLogOf, type AgentHandleLike, type AgentPresetsPort, type AgentsFacade, type CreateFacadeOptions, type WakeFireResult } from "../src/wake.js";
import type { WorkspaceWakePort } from "../src/workspace.js";
import { ProactiveStore } from "../src/store.js";
import { resolveConfig } from "../src/config.js";
import type { Alarm } from "../src/domain.js";

function alarm(id = "a1", target: Alarm["target"] = { mode: "resume", sessionId: "s1" }): Alarm {
  return {
    id,
    ownerSessionId: "s1",
    target,
    type: "once",
    trigger: { at: "2026-09-02T00:00:00.000Z" },
    prompt: "进水提醒",
    respectQuietHours: false,
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
      events.push({ type: "tool/call", data: { turn: 1, step: 1, callId: CallId("c1"), name: "no_reply", arguments: "{}" } });
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
  cfg.silentWakeCompaction = true;
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
    },
    create: async () => { throw new Error("unused"); }
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

test("sessionLogOf reads the log through both Session lines", () => {
  const old = { seq: 2, events: [{ seq: 0 }, { seq: 1 }] };
  const modern = { seq: 1, snapshotEvents: () => [{ seq: 0 }] };
  const bare = { seq: 0 };
  assert.deepEqual(sessionLogOf(old), [{ seq: 0 }, { seq: 1 }]);
  assert.deepEqual(sessionLogOf(modern), [{ seq: 0 }]);
  assert.deepEqual(sessionLogOf(bare), []); // session still being created
});

test("cold wake resumes the session, frames the message, and can be silent", async () => {
  const h = await harness();
  try {
    const fire = await h.driver.fire(alarm("cold1"));
    assert.equal(fire.outcome, "ok");
    if (fire.outcome === "ok") {
      assert.equal(fire.analysis.decision, "no_reply");
      assert.equal(fire.analysis.budgetDelta, 0);
      assert.equal(fire.sessionId, "s1");
    }
    assert.equal(h.rec.resumed, true);
    assert.equal(h.rec.disposed, true); // process-local handle released
    assert.equal(h.rec.activeDuringFollowup, true); // inflight guard held during the wake
    assert.equal(h.rec.messages.length, 1);
    const text = extractText(h.rec.messages[0].message);
    assert.ok(text.startsWith("[dsh-proactive wake cold1 once cold]"), "v3 minimal header expected, got: " + text.slice(0, 60));
    assert.ok(text.includes("end the turn with no text at all"));
    assert.ok(text.includes("进水提醒"));
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
      resume: async () => { throw new Error("unused"); },
      create: async () => { throw new Error("unused"); }
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

test("completedTurnCut mirrors the host fork boundary (last turn/end, cut to next turn/start)", () => {
  const events = [
    { seq: 0, type: "user/message" },
    { seq: 1, type: "turn/start" },
    { seq: 2, type: "assistant/message" },
    { seq: 3, type: "turn/end" },
    { seq: 4, type: "comment" },
    { seq: 5, type: "user/message" },
    { seq: 6, type: "turn/start" }
  ];
  // cut = last turn/end (seq 3) + 1 = 4, then the host-verbatim extend loop
  // consumes trailing non-turn events until the next turn/start (seq 6) -> cut 6.
  assert.equal(completedTurnCut(events), 6);
  // No completed turn -> 0.
  assert.equal(completedTurnCut([{ seq: 0, type: "user/message" }, { seq: 1, type: "turn/start" }]), 0);
  assert.equal(completedTurnCut([]), 0);
  // Trailing events after the LAST turn/end include everything until the following turn/start.
  const withTail = [
    { seq: 0, type: "turn/start" },
    { seq: 1, type: "turn/end" },
    { seq: 2, type: "comment" }
  ];
  assert.equal(completedTurnCut(withTail), 3);
});

test("fork target creates a child session seeded with the parent's completed history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  const rec: FakeRecording = { messages: [], disposed: false, resumed: false, activeDuringFollowup: null };
  const childAgent = makeFakeAgent(rec);
  (childAgent as unknown as { session: { id: string } }).session.id = "session-child";
  const parentEvents = [
    { type: "user/message", seq: 0 },
    { type: "turn/start", seq: 1 },
    { type: "assistant/message", seq: 2 },
    { type: "turn/end", seq: 3, data: { reason: { kind: "completed" } } }
  ];
  const parentAgent = {
    session: { id: "parent", events: parentEvents, header: { version: 0, id: "parent", createdAt: 0, cwd: "/work", agentPreset: "general" } }
  } as unknown as Agent;
  let captured: CreateFacadeOptions | undefined;
  const agents: AgentsFacade = {
    get: (id: string) => (id === "parent" ? parentAgent : undefined) as never,
    resume: async () => { throw new Error("unused"); },
    create: async (options) => {
      captured = options;
      const handle: AgentHandleLike = { agent: childAgent, dispose: async () => undefined };
      return handle;
    }
  };
  const driver = new WakeDriver({ agents, modelSelection: () => ({ provider: "test", model: "x" }), store, config: cfg, log: () => undefined });
  try {
    const fire = await driver.fire(alarm("fork1", { mode: "fork", sessionId: "parent" }));
    assert.equal(fire.outcome, "ok");
    assert.ok(captured !== undefined);
    assert.equal(captured.seed?.length, 4); // whole completed prefix
    assert.equal(captured.meta?.parentSession, "parent");
    assert.equal(captured.meta?.seedLength, 4);
    assert.equal(captured.meta?.cwd, "/work");
    assert.equal(captured.meta?.agentPreset, "general"); // child inherits the parent's composition
    assert.ok(captured.sessionId.startsWith("session-"));
    if (fire.outcome === "ok") {
      assert.equal(fire.sessionId, captured.sessionId);
    }
    assert.equal(driver.isActiveWake(captured.sessionId), false); // child cleared after the wake
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fork target fails when the parent has no completed turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  const emptyParent = { session: { id: "parent", events: [{ type: "user/message", seq: 0 }], header: { version: 0, id: "parent", createdAt: 0 } } } as unknown as Agent;
  const agents: AgentsFacade = {
    get: (id: string) => (id === "parent" ? emptyParent : undefined) as never,
    resume: async () => { throw new Error("unused"); },
    create: async () => { throw new Error("must not be called"); }
  };
  const driver = new WakeDriver({ agents, modelSelection: () => undefined, store, config: cfg, log: () => undefined });
  try {
    const fire = await driver.fire(alarm("fork0", { mode: "fork", sessionId: "parent" }));
    assert.equal(fire.outcome, "failed");
    if (fire.outcome === "failed") assert.ok(fire.error.includes("no completed turn"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fork from a cold parent reads the persisted log for the seed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  const rec: FakeRecording = { messages: [], disposed: false, resumed: false, activeDuringFollowup: null };
  const childAgent = makeFakeAgent(rec);
  const persistedEvents = [
    { type: "user/message", seq: 0 },
    { type: "turn/start", seq: 1 },
    { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } }
  ];
  let captured: CreateFacadeOptions | undefined;
  const agents: AgentsFacade = {
    get: () => undefined as never,
    resume: async () => { throw new Error("unused"); },
    create: async (options) => {
      captured = options;
      return { agent: childAgent, dispose: async () => undefined };
    }
  };
  const driver = new WakeDriver({
    agents,
    sessionPersistence: {
      inspect: async () => ({ events: persistedEvents as never, meta: { version: 0, id: "parent" as never, createdAt: 0, cwd: "/persisted", agentPreset: "general" } })
    },
    modelSelection: () => undefined,
    store,
    config: cfg,
    log: () => undefined
  });
  try {
    const fire = await driver.fire(alarm("forkcold", { mode: "fork", sessionId: "parent" }));
    assert.equal(fire.outcome, "ok");
    assert.ok(captured !== undefined);
    assert.equal(captured.seed?.length, 3);
    assert.equal(captured.meta?.seedLength, 3);
    assert.equal(captured.meta?.cwd, "/persisted");
    assert.equal(captured.meta?.agentPreset, "general"); // cold parent's preset survives into the child
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new target creates an empty child session and wakes it there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  const rec: FakeRecording = { messages: [], disposed: false, resumed: false, activeDuringFollowup: null };
  const childAgent = makeFakeAgent(rec);
  let captured: CreateFacadeOptions | undefined;
  const agents: AgentsFacade = {
    get: () => undefined as never,
    resume: async () => { throw new Error("unused"); },
    create: async (options) => {
      captured = options;
      return { agent: childAgent, dispose: async () => undefined };
    }
  };
  const driver = new WakeDriver({ agents, modelSelection: () => undefined, store, config: cfg, log: () => undefined });
  try {
    const fire = await driver.fire(alarm("new1", { mode: "new" }));
    assert.equal(fire.outcome, "ok");
    assert.ok(captured !== undefined);
    assert.equal(captured.seed, undefined);
    assert.equal(captured.meta, undefined);
    assert.ok(captured.sessionId.startsWith("session-"));
    if (fire.outcome === "ok") assert.equal(fire.sessionId, captured.sessionId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

test("cold resume installs a model-selection setup that drives the request waterfall", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  let capturedOptions: { agentOptions?: unknown; setup?: unknown } = {};
  const header: EpochHeader = { config: { provider: "cpa", model: "gemini-3-flash" } };
  const wakeAgent = makeWakeAgent(header);
  const agents: AgentsFacade = {
    get: () => undefined as never,
    resume: async (options) => {
      capturedOptions = options;
      const handle: AgentHandleLike = { agent: wakeAgent, dispose: async () => undefined };
      return handle;
    },
    create: async () => { throw new Error("unused"); }
  };
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
    assert.equal(typeof capturedOptions.setup, "function", "cold resume must carry a setup hook");

    // execute the real setup against a real cordis Context with the fake agent
    const agentCtx = new Context();
    Object.defineProperty(agentCtx, "agent", { value: wakeAgent, configurable: true });
    const applied = (capturedOptions.setup as (ctx: Context) => unknown)(agentCtx);
    if (applied && typeof (applied as { then?: unknown }).then === "function") await applied;

    // drive the two model-selection waterfalls (strict cordis event typings
    // don't know these runtime event names; cast just for the test harness)
    const waterfall = (agentCtx as unknown as { waterfall: (subject: unknown, name: string, ...args: unknown[]) => Promise<unknown> }).waterfall;
    // system-prompt/assemble snapshots the session-header selection
    const assembled = (await waterfall(agentCtx, "system-prompt/assemble", {}, {}, () => Promise.resolve({ variables: {} }))) as { variables: Record<string, unknown> };
    assert.deepEqual(assembled.variables, { provider: "cpa", model: "gemini-3-flash" });
    // agent/request overrides the seed route with the assembled selection
    const request = (await waterfall(agentCtx, "agent/request", { turn: 1, step: 1 }, () => Promise.resolve({ provider: "seed", model: "seed", maxTokens: 100 }))) as { provider: string; model: string; maxTokens: number };
    assert.equal(request.provider, "cpa");
    assert.equal(request.model, "gemini-3-flash");
    assert.equal(request.maxTokens, 100, "unrelated request fields must pass through untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cold resume mounts the session's preset, newest selection winning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  let capturedOptions: { setup?: unknown } = {};
  const header: EpochHeader = { config: { provider: "cpa", model: "gemini-3-flash" } };
  // header names "general"; a later agent-preset/selected event switched to "dev"
  const wakeAgent = {
    session: {
      id: "s1",
      events: [
        { type: "agent-preset/selected", seq: 0, data: { agentPreset: "general" } },
        { type: "agent-preset/selected", seq: 1, data: { agentPreset: "dev" } }
      ],
      header: { version: 0, id: "s1", createdAt: 0, agentPreset: "general" },
      requestHeader: () => header
    },
    followup: () => undefined,
    runMaintenance: async (task: () => Promise<unknown>) => { await task(); return true; },
    whenIdle: async () => undefined
  } as unknown as Agent;
  const mounted: Array<{ ctx: unknown; id: string | undefined }> = [];
  const agentPresets: AgentPresetsPort = {
    defaultId: "standard",
    mount: async (ctx, id) => { mounted.push({ ctx, id }); }
  };
  const agents: AgentsFacade = {
    get: () => undefined as never,
    resume: async (options) => {
      capturedOptions = options;
      return { agent: wakeAgent, dispose: async () => undefined };
    },
    create: async () => { throw new Error("unused"); }
  };
  const driver = new WakeDriver({ agents, agentPresets, modelSelection: () => ({ provider: "cpa", model: "medium" }), store, config: cfg, log: () => undefined });
  try {
    const fire = await driver.fire(alarm("coldp"));
    assert.equal(fire.outcome, "ok");
    assert.equal(typeof capturedOptions.setup, "function", "cold resume must carry a setup hook");

    // execute the real setup: the roster mount must receive the agent's scope
    // context and the LAST recorded selection, not the creation header
    const agentCtx = new Context();
    Object.defineProperty(agentCtx, "agent", { value: wakeAgent, configurable: true });
    const applied = (capturedOptions.setup as (ctx: Context) => unknown)(agentCtx);
    if (applied && typeof (applied as { then?: unknown }).then === "function") await applied;

    assert.equal(mounted.length, 1);
    assert.equal(mounted[0].ctx, agentCtx, "mount must receive the agent's scoped context");
    assert.equal(mounted[0].id, "dev", "the newest agent-preset/selected event must win over the header");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cold resume without a roster composes no preset (rosterless deployments)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  let capturedOptions: { setup?: unknown } = {};
  const wakeAgent = makeWakeAgent({ config: { provider: "cpa", model: "gemini-3-flash" } });
  const agents: AgentsFacade = {
    get: () => undefined as never,
    resume: async (options) => {
      capturedOptions = options;
      return { agent: wakeAgent, dispose: async () => undefined };
    },
    create: async () => { throw new Error("unused"); }
  };
  const driver = new WakeDriver({ agents, modelSelection: () => undefined, store, config: cfg, log: () => undefined });
  try {
    const fire = await driver.fire(alarm("coldnp"));
    assert.equal(fire.outcome, "ok");
    const agentCtx = new Context();
    Object.defineProperty(agentCtx, "agent", { value: wakeAgent, configurable: true });
    // No roster -> the setup must settle WITHOUT touching any preset service.
    // makeWakeAgent's session deliberately has no `header`, so a regression
    // that drops the rosterless guard rejects right here (reading
    // `header.agentPreset` off the fake session).
    await (capturedOptions.setup as (ctx: Context) => Promise<void>)(agentCtx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new target records the default preset in the child's creation meta", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  const rec: FakeRecording = { messages: [], disposed: false, resumed: false, activeDuringFollowup: null };
  const childAgent = makeFakeAgent(rec);
  let captured: CreateFacadeOptions | undefined;
  const agents: AgentsFacade = {
    get: () => undefined as never,
    resume: async () => { throw new Error("unused"); },
    create: async (options) => {
      captured = options;
      return { agent: childAgent, dispose: async () => undefined };
    }
  };
  const agentPresets: AgentPresetsPort = {
    defaultId: "standard",
    mount: async () => undefined
  };
  const driver = new WakeDriver({ agents, agentPresets, modelSelection: () => undefined, store, config: cfg, log: () => undefined });
  try {
    const fire = await driver.fire(alarm("newp", { mode: "new" }));
    assert.equal(fire.outcome, "ok");
    assert.ok(captured !== undefined);
    assert.equal(captured.meta?.agentPreset, "standard");
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
      events.push({ type: "tool/call", data: { turn: 1, step: 1, callId: CallId("c1"), name: "no_reply", arguments: "{}" } });
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

test("silent wake collapses on the model surface after the turn settles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  cfg.silentWakeCompaction = true;
  const store = new ProactiveStore(dir);
  const session = Session.create("s1" as never);
  const agent = {
    session,
    followup: (message: unknown) => {
      session.append("turn/start", { turn: 1 });
      session.append("user/message", message as never, { surfaceOp: "append" });
      session.append("assistant/message", {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: "tool-call", id: CallId("c1"), name: "no_reply", arguments: JSON.stringify({ reason: "没事" }) }],
          source: { provider: "cpa", model: "gemini-3-flash" }
        })
      }, { surfaceOp: "append", sourceEventSeqs: [] });
      session.append("tool/call", { turn: 1, step: 1, callId: CallId("c1"), name: "no_reply", arguments: "{}" });
      session.append("tool/result", {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: CallId("c1"), content: [{ type: "text", text: JSON.stringify({ accepted: true, silent: true }) }], isError: false })
      }, { surfaceOp: "append" });
      session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    },
    runMaintenance: async (task: () => Promise<unknown>) => { await task(); return true; },
    whenIdle: async () => undefined
  } as unknown as Agent;
  const agents: AgentsFacade = {
    get: () => agent,
    resume: async () => { throw new Error("unused"); },
    create: async () => { throw new Error("unused"); }
  };
  const driver = new WakeDriver({ agents, modelSelection: () => ({ provider: "cpa", model: "x" }), store, config: cfg, log: () => undefined });
  try {
    const fire = await driver.fire(alarm("silent1"));
    assert.equal(fire.outcome, "ok");
    if (fire.outcome === "ok") assert.equal(fire.analysis.decision, "no_reply");
    // Compaction landed: the model surface derives ONLY the tombstone from
    // the whole wake exchange (framing + assistant + tool result erased).
    const derived = session.surface.nodes
      .map((seq) => deriveEventMessage(session.events[seq] as never))
      .filter((message) => message !== null);
    assert.equal(derived.length, 1);
    const [only] = derived;
    const block = only.content[0] as { type: string; text: string };
    assert.equal(block.type, "text");
    assert.ok(block.text.startsWith("[dsh-proactive silent wake silent1 "), "tombstone expected, got: " + block.text);
    assert.ok(Buffer.byteLength(block.text) < 90, "tombstone must stay tiny, was " + Buffer.byteLength(block.text));
    // The raw log keeps the full exchange for the human transcript.
    assert.ok(session.events.some((event) => event.type === "assistant/message"));
    assert.ok(session.events.some((event) => event.type === "tool/result"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("silent wake is NOT compacted when silentWakeCompaction is off (default)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  // Off by default: the gate must leave the whole silent exchange on the model
  // surface even though the turn produced no visible output.
  const store = new ProactiveStore(dir);
  const session = Session.create("s1" as never);
  const agent = {
    session,
    followup: (message: unknown) => {
      session.append("turn/start", { turn: 1 });
      session.append("user/message", message as never, { surfaceOp: "append" });
      session.append("assistant/message", {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: "tool-call", id: CallId("c1"), name: "no_reply", arguments: JSON.stringify({ reason: "没事" }) }],
          source: { provider: "cpa", model: "gemini-3-flash" }
        })
      }, { surfaceOp: "append", sourceEventSeqs: [] });
      session.append("tool/call", { turn: 1, step: 1, callId: CallId("c1"), name: "no_reply", arguments: "{}" });
      session.append("tool/result", {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: CallId("c1"), content: [{ type: "text", text: JSON.stringify({ accepted: true, silent: true }) }], isError: false })
      }, { surfaceOp: "append" });
      session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    },
    runMaintenance: async (task: () => Promise<unknown>) => { await task(); return true; },
    whenIdle: async () => undefined
  } as unknown as Agent;
  const agents: AgentsFacade = {
    get: () => agent,
    resume: async () => { throw new Error("unused"); },
    create: async () => { throw new Error("unused"); }
  };
  const driver = new WakeDriver({ agents, modelSelection: () => ({ provider: "cpa", model: "x" }), store, config: cfg, log: () => undefined });
  try {
    const fire = await driver.fire(alarm("silentoff1"));
    assert.equal(fire.outcome, "ok");
    if (fire.outcome === "ok") assert.equal(fire.analysis.decision, "no_reply");
    const derived = session.surface.nodes
      .map((seq) => deriveEventMessage(session.events[seq] as never))
      .filter((message) => message !== null);
    const texts = derived.map((m) => (m.content[0] as { text?: string }).text ?? "");
    assert.ok(texts.some((t) => t.startsWith("[dsh-proactive wake silentoff1 ")), "framing must stay on the surface (no compaction)");
    assert.ok(!texts.some((t) => t.startsWith("[dsh-proactive silent wake ")), "no tombstone may appear when the gate is off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("visible-reply wakes are never compacted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  const session = Session.create("s1" as never);
  const agent = {
    session,
    followup: (message: unknown) => {
      session.append("turn/start", { turn: 1 });
      session.append("user/message", message as never, { surfaceOp: "append" });
      session.append("assistant/message", {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: "text", text: "到点了，喝水！" }],
          source: { provider: "cpa", model: "gemini-3-flash" }
        })
      }, { surfaceOp: "append", sourceEventSeqs: [] });
      session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    },
    runMaintenance: async (task: () => Promise<unknown>) => { await task(); return true; },
    whenIdle: async () => undefined
  } as unknown as Agent;
  const agents: AgentsFacade = {
    get: () => agent,
    resume: async () => { throw new Error("unused"); },
    create: async () => { throw new Error("unused"); }
  };
  const driver = new WakeDriver({ agents, modelSelection: () => ({ provider: "cpa", model: "x" }), store, config: cfg, log: () => undefined });
  try {
    const fire = await driver.fire(alarm("reply1"));
    assert.equal(fire.outcome, "ok");
    if (fire.outcome === "ok") {
      assert.equal(fire.analysis.decision, "reply");
      assert.equal(fire.analysis.budgetDelta, 1);
    }
    const derived = session.surface.nodes
      .map((seq) => deriveEventMessage(session.events[seq] as never))
      .filter((message) => message !== null);
    assert.equal(derived.length, 2); // framing + visible reply, untouched
    const reply = derived[1].content[0] as { type: string; text: string };
    assert.equal(reply.text, "到点了，喝水！");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("raced user turn cannot make a visible wake reply compactable (P1 regression)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  const session = Session.create("s1" as never);
  const agent = {
    session,
    followup: (message: unknown) => {
      // Real drain order: wake turn (visible reply), then a user turn that
      // raced in within the same whenIdle window and ended with no text.
      session.append("turn/start", { turn: 1 });
      session.append("user/message", message as never, { surfaceOp: "append" });
      session.append("assistant/message", {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: "text", text: "到点了，该喝水了！" }],
          source: { provider: "cpa", model: "gemini-3-flash" }
        })
      }, { surfaceOp: "append", sourceEventSeqs: [] });
      session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
      session.append("turn/start", { turn: 2 });
      session.append("user/message", createUserMessage({ content: [{ type: "text", text: "用户竞态消息" }], source: { kind: "user" } }), { surfaceOp: "append" });
      session.append("turn/end", { turn: 2, reason: { kind: "error", error: { code: "X", message: "boom" } } });
    },
    runMaintenance: async (task: () => Promise<unknown>) => { await task(); return true; },
    whenIdle: async () => undefined
  } as unknown as Agent;
  const agents: AgentsFacade = {
    get: () => agent,
    resume: async () => { throw new Error("unused"); },
    create: async () => { throw new Error("unused"); }
  };
  const driver = new WakeDriver({ agents, modelSelection: () => ({ provider: "cpa", model: "x" }), store, config: cfg, log: () => undefined });
  try {
    const fire = await driver.fire(alarm("raced1"));
    assert.equal(fire.outcome, "ok");
    if (fire.outcome === "ok") {
      assert.equal(fire.analysis.decision, "reply"); // judges the WAKE turn, not the raced one
      assert.equal(fire.analysis.budgetDelta, 1);
    }
    const derived = session.surface.nodes
      .map((seq) => deriveEventMessage(session.events[seq] as never))
      .filter((message) => message !== null);
    const texts = derived.map((m) => (m.content[0] as { text?: string }).text ?? "");
    assert.ok(texts.some((t) => t.includes("到点了，该喝水了！")), "visible reply must stay on the model surface");
    assert.ok(texts.some((t) => t.startsWith("[dsh-proactive wake ")), "framing must stay (reply turns are never compacted)");
    assert.ok(!texts.some((t) => t.startsWith("[dsh-proactive silent wake ")), "no tombstone may appear for a reply turn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("raced user turn with text does not block compaction of a SILENT wake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  cfg.silentWakeCompaction = true;
  const store = new ProactiveStore(dir);
  const session = Session.create("s1" as never);
  const agent = {
    session,
    followup: (message: unknown) => {
      // Silent wake turn, then a raced user turn that carried text within
      // the same whenIdle window. The decision must judge the wake turn
      // (no_reply) and the wake exchange must still collapse; the raced
      // user turn's text stays on the surface untouched.
      session.append("turn/start", { turn: 1 });
      session.append("user/message", message as never, { surfaceOp: "append" });
      session.append("assistant/message", {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: "tool-call", id: CallId("c1"), name: "no_reply", arguments: JSON.stringify({ reason: "没事" }) }],
          source: { provider: "cpa", model: "gemini-3-flash" }
        })
      }, { surfaceOp: "append", sourceEventSeqs: [] });
      session.append("tool/call", { turn: 1, step: 1, callId: CallId("c1"), name: "no_reply", arguments: "{}" });
      session.append("tool/result", {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: CallId("c1"), content: [{ type: "text", text: JSON.stringify({ accepted: true, silent: true }) }], isError: false })
      }, { surfaceOp: "append" });
      session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
      session.append("turn/start", { turn: 2 });
      session.append("user/message", createUserMessage({ content: [{ type: "text", text: "竞态用户回合的内容" }], source: { kind: "user" } }), { surfaceOp: "append" });
      session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
    },
    runMaintenance: async (task: () => Promise<unknown>) => { await task(); return true; },
    whenIdle: async () => undefined
  } as unknown as Agent;
  const agents: AgentsFacade = {
    get: () => agent,
    resume: async () => { throw new Error("unused"); },
    create: async () => { throw new Error("unused"); }
  };
  const driver = new WakeDriver({ agents, modelSelection: () => ({ provider: "cpa", model: "x" }), store, config: cfg, log: () => undefined });
  try {
    const fire = await driver.fire(alarm("silentraced1"));
    assert.equal(fire.outcome, "ok");
    if (fire.outcome === "ok") assert.equal(fire.analysis.decision, "no_reply");
    const texts = session.surface.nodes
      .map((seq) => deriveEventMessage(session.events[seq] as never))
      .filter((message) => message !== null)
      .map((m) => (m.content[0] as { text?: string }).text ?? "");
    assert.ok(texts.some((t) => t.startsWith("[dsh-proactive silent wake silentraced1 ")), "silent wake still collapsed to a tombstone");
    assert.ok(texts.some((t) => t.includes("竞态用户回合的内容")), "raced user turn text stays on the surface");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function extractText(message: unknown): string {
  const msg = message as { content?: { type?: string; text?: string }[] };
  return (msg.content ?? []).map((b) => b.text ?? "").join("");
}

/* --------------------------------------------- workspace target wakes ---- */

test("workspace alarm without a port fails loudly (headless host)", async () => {
  const h = await harness();
  try {
    const fire = await h.driver.fire(alarm("ws1", { mode: "workspace", workspaceId: "ws-a" }));
    assert.equal(fire.outcome, "failed");
    if (fire.outcome === "failed") assert.ok(fire.error.includes("unavailable on this host"));
    assert.equal(h.rec.messages.length, 0); // nothing delivered
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("workspace alarm with a failing port surfaces the closed error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  const port: WorkspaceWakePort = {
    resolveTarget: async () => ({ error: "workspace ws-a no longer exists (deleted in the GUI?); cancel or edit this alarm" }),
    attach: async () => { throw new Error("must not be called"); },
    cwdOf: async () => { throw new Error("must not be called"); }
  };
  const agents: AgentsFacade = { get: () => undefined, resume: async () => { throw new Error("unused"); }, create: async () => { throw new Error("unused"); } };
  const driver = new WakeDriver({ agents, workspaces: port, modelSelection: () => undefined, store, config: cfg, log: () => undefined });
  try {
    const fire = await driver.fire(alarm("ws2", { mode: "workspace", workspaceId: "ws-a" }));
    assert.equal(fire.outcome, "failed");
    if (fire.outcome === "failed") assert.ok(fire.error.includes("no longer exists"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace alarm lands in the resolved session via the resume path", async () => {
  const h = await harness();
  const attached: string[] = [];
  const port: WorkspaceWakePort = {
    resolveTarget: async () => ({ kind: "session", sessionId: "s1" }),
    attach: async (_workspaceId, sessionId) => { attached.push(sessionId); },
    cwdOf: async () => { throw new Error("must not be called"); }
  };
  const driver = new WakeDriver({
    agents: {
      get: () => undefined as never,
      resume: async () => {
        h.rec.resumed = true;
        return { agent: makeFakeAgent(h.rec), dispose: async () => { h.rec.disposed = true; } };
      },
      create: async () => { throw new Error("unused"); }
    },
    workspaces: port,
    modelSelection: () => ({ provider: "test", model: "x" }),
    store: h.store,
    config: h.cfg,
    log: () => undefined
  });
  try {
    const fire = await driver.fire(alarm("ws3", { mode: "workspace", workspaceId: "ws-a" }));
    assert.equal(fire.outcome, "ok");
    assert.equal(h.rec.resumed, true);
    assert.equal(h.rec.messages.length, 1);
    if (fire.outcome === "ok") assert.equal(fire.sessionId, "s1");
    assert.deepEqual(attached, []); // session arm never attaches
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("workspace alarm creates a session in the workspace and attaches BEFORE delivering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  const trace: string[] = [];
  const port: WorkspaceWakePort = {
    resolveTarget: async () => ({ kind: "create", cwd: "/repos/alpha" }),
    attach: async (_workspaceId, sessionId) => { trace.push("attach:" + sessionId); },
    cwdOf: async () => "/repos/alpha"
  };
  let captured: CreateFacadeOptions | undefined;
  const agents: AgentsFacade = {
    get: () => undefined as never,
    resume: async () => { throw new Error("unused"); },
    create: async (options) => {
      captured = options;
      return { agent: makeFakeAgent({ messages: [], disposed: false, resumed: false, activeDuringFollowup: null }), dispose: async () => undefined };
    }
  };
  const driver = new WakeDriver({ agents, workspaces: port, modelSelection: () => undefined, store, config: cfg, log: () => undefined });
  try {
    const fire = await driver.fire(alarm("ws4", { mode: "workspace", workspaceId: "ws-a" }));
    assert.equal(fire.outcome, "ok");
    assert.ok(captured !== undefined);
    assert.equal(captured.meta?.cwd, "/repos/alpha"); // session lands inside the workspace dir
    assert.ok(captured.sessionId.startsWith("session-"));
    // ordering: the created session is grouped into the workspace BEFORE the
    // wake is delivered — a failed attach must never deliver an orphan.
    assert.deepEqual(trace, ["attach:" + captured.sessionId]);
    if (fire.outcome === "ok") assert.equal(fire.sessionId, captured.sessionId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace create arm failing the attach never delivers the wake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-wake-"));
  const cfg = resolveConfig(dir);
  const store = new ProactiveStore(dir);
  const rec: FakeRecording = { messages: [], disposed: false, resumed: false, activeDuringFollowup: null };
  const port: WorkspaceWakePort = {
    resolveTarget: async () => ({ kind: "create", cwd: "/repos/alpha" }),
    attach: async () => { throw new Error("attach failed: registry rejected"); },
    cwdOf: async () => "/repos/alpha"
  };
  const agents: AgentsFacade = {
    get: () => undefined as never,
    resume: async () => { throw new Error("unused"); },
    create: async () => ({ agent: makeFakeAgent(rec), dispose: async () => undefined })
  };
  const driver = new WakeDriver({ agents, workspaces: port, modelSelection: () => undefined, store, config: cfg, log: () => undefined });
  try {
    const fire = await driver.fire(alarm("ws5", { mode: "workspace", workspaceId: "ws-a" }));
    assert.equal(fire.outcome, "failed");
    if (fire.outcome === "failed") assert.ok(fire.error.includes("attach failed"));
    assert.equal(rec.messages.length, 0); // no wake delivered into the ungrouped session
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
