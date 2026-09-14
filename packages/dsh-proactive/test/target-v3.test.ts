/**
 * v3 target-dialect unit tests (260911-proactive-target-refactor).
 *
 * Covers the four layers the refactor touched:
 *  - domain: targetSourceOf + the AlarmView v3 fields;
 *  - alarm-factory: the new/resume/fork × session/workspace/preset dialect
 *    (inference, mutual exclusion, legacy workspace normalization);
 *  - store: targetIsValid for every stored shape;
 *  - workspace: resolvePresetWakeTarget (live fold, cold headers,
 *    exclusions, failed-listing conservatism);
 *  - wake: fire() preset-source arms + new-mode config/override flow;
 *  - panel contract: createArgsFromForm stale-field scrubbing and
 *    formFromAlarm round-trips.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { targetSourceOf, toAlarmView, type Alarm, type AlarmTarget } from "../src/domain.js";
import { validateCreateArgs } from "../src/alarm-factory.js";
import { resolvePresetWakeTarget, type PresetWakeDeps, type SessionHeaderLike } from "../src/workspace.js";
import { WakeDriver, type AgentHandleLike, type AgentPresetsPort, type AgentsFacade, type CreateFacadeOptions, type WakeFireResult } from "../src/wake.js";
import { createArgsFromForm, type PanelCreateForm } from "../src/panel/contract.js";
import { formFromAlarm } from "../src/client/sections.js";
import { ProactiveStore } from "../src/store.js";
import { resolveConfig } from "../src/config.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function v3Alarm(target: AlarmTarget): Alarm {
  return {
    id: "a-v3",
    ownerSessionId: "s-owner",
    target,
    type: "once",
    trigger: { at: "2026-09-12T00:00:00.000Z" },
    prompt: "跟进",
    respectQuietHours: false,
    timeZone: "UTC",
    status: "scheduled",
    nextDueAt: "2026-09-11T00:00:00.000Z",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    runCount: 0,
    lastRunAt: null
  };
}

/* ------------------------------------------------------- domain: source ---- */

test("targetSourceOf: explicit v3 sourceType wins; v2 records infer", () => {
  assert.equal(targetSourceOf({ mode: "resume", sourceType: "preset", presetId: "dev" }), "preset");
  assert.equal(targetSourceOf({ mode: "fork", sourceType: "workspace", workspaceId: UUID_A }), "workspace");
  assert.equal(targetSourceOf({ mode: "resume", sourceType: "session", sessionId: "s1" }), "session");
  // v2 spelling (no sourceType): ids infer the source, else session.
  assert.equal(targetSourceOf({ mode: "resume", sessionId: "s1" }), "session");
  assert.equal(targetSourceOf({ mode: "resume", workspaceId: UUID_A }), "workspace");
  assert.equal(targetSourceOf({ mode: "fork", presetId: "dev" }), "preset");
  // Legacy mode and the new mode.
  assert.equal(targetSourceOf({ mode: "workspace", workspaceId: UUID_A }), "workspace");
  assert.equal(targetSourceOf({ mode: "new" }), undefined);
  assert.equal(targetSourceOf({ mode: "new", workspaceId: UUID_A, presetId: "dev", provider: "p", model: "m" }), undefined);
});

test("toAlarmView: v3 fields surface for every arm", () => {
  const now = Date.parse("2026-09-11T00:00:00.000Z");
  const preset = toAlarmView(v3Alarm({ mode: "resume", sourceType: "preset", presetId: "dev" }), now);
  assert.equal(preset.targetMode, "resume");
  assert.equal(preset.targetSource, "preset");
  assert.equal(preset.targetPresetId, "dev");

  const fresh = toAlarmView(v3Alarm({ mode: "new", workspaceId: UUID_A, presetId: "dev", provider: "cpa", model: "gemini-3-flash" }), now);
  assert.equal(fresh.targetMode, "new");
  assert.equal(fresh.targetSource, undefined);
  assert.equal(fresh.targetWorkspaceId, UUID_A);
  assert.equal(fresh.targetPresetId, "dev");
  assert.equal(fresh.targetProvider, "cpa");
  assert.equal(fresh.targetModel, "gemini-3-flash");

  // Stored legacy records keep their mode spelling; new records converge.
  const legacy = toAlarmView(v3Alarm({ mode: "workspace", workspaceId: UUID_A }), now);
  assert.equal(legacy.targetMode, "workspace");
  assert.equal(legacy.targetSource, "workspace");
});

/* ------------------------------------------------- alarm-factory dialect ---- */

test("factory: new mode accepts optional workspace/preset/model config and trims", () => {
  const spec = validateCreateArgs({
    prompt: "p", after_seconds: 60, target_mode: "new",
    target_workspace_id: UUID_A, target_preset_id: "dev",
    target_provider: "  cpa  ", target_model: " gemini-3-flash "
  }, "s-owner");
  assert.ok(!("code" in spec), "new-mode create must validate");
  if ("code" in spec) return;
  assert.deepEqual(spec.target, { mode: "new", workspaceId: UUID_A, presetId: "dev", provider: "cpa", model: "gemini-3-flash" });
});

test("factory: new mode rejects session-side fields", () => {
  for (const extra of [{ target_session_id: "s1" }, { target_source: "session" }]) {
    const spec = validateCreateArgs({ prompt: "p", after_seconds: 60, target_mode: "new", ...extra }, "s-owner");
    assert.ok("code" in spec, "must reject " + JSON.stringify(extra));
  }
  const bare = validateCreateArgs({ prompt: "p", after_seconds: 60, target_mode: "new" }, "s-owner");
  assert.ok(!("code" in bare));
  if ("code" in bare) return;
  assert.deepEqual(bare.target, { mode: "new" });
});

test("factory: resume/fork source dialect — explicit, inferred, mutually exclusive", () => {
  // Explicit preset source.
  const explicit = validateCreateArgs({ prompt: "p", after_seconds: 60, target_mode: "resume", target_source: "preset", target_preset_id: "dev" }, "s-owner");
  assert.ok(!("code" in explicit));
  if ("code" in explicit) return;
  assert.deepEqual(explicit.target, { mode: "resume", sourceType: "preset", presetId: "dev" });
  // Inference: a lone workspace id means workspace source.
  const inferred = validateCreateArgs({ prompt: "p", after_seconds: 60, target_mode: "fork", target_workspace_id: UUID_A }, "s-owner");
  assert.ok(!("code" in inferred));
  if ("code" in inferred) return;
  assert.deepEqual(inferred.target, { mode: "fork", sourceType: "workspace", workspaceId: UUID_A });
  // Inference: a lone preset id means preset source.
  const inferredPreset = validateCreateArgs({ prompt: "p", after_seconds: 60, target_preset_id: "dev" }, "s-owner");
  assert.ok(!("code" in inferredPreset));
  if ("code" in inferredPreset) return;
  assert.deepEqual(inferredPreset.target, { mode: "resume", sourceType: "preset", presetId: "dev" });
  // Mutual exclusions.
  assert.ok("code" in validateCreateArgs({ prompt: "p", after_seconds: 60, target_source: "preset", target_preset_id: "dev", target_session_id: "s1" }, "s-owner"));
  assert.ok("code" in validateCreateArgs({ prompt: "p", after_seconds: 60, target_source: "session", target_workspace_id: UUID_A }, "s-owner"));
  assert.ok("code" in validateCreateArgs({ prompt: "p", after_seconds: 60, target_source: "workspace", target_preset_id: "dev" }, "s-owner"));
  // Workspace source requires a registry-shaped id (slug/uuid charset).
  assert.ok("code" in validateCreateArgs({ prompt: "p", after_seconds: 60, target_source: "workspace", target_workspace_id: "not a uuid" }, "s-owner"));
  // Default session source falls back to the owner session.
  const sessionDefault = validateCreateArgs({ prompt: "p", after_seconds: 60 }, "s-owner");
  assert.ok(!("code" in sessionDefault));
  if ("code" in sessionDefault) return;
  assert.deepEqual(sessionDefault.target, { mode: "resume", sourceType: "session", sessionId: "s-owner" });
});

test("factory: resume/fork reject provider/model (new-mode-only override)", () => {
  assert.ok("code" in validateCreateArgs({ prompt: "p", after_seconds: 60, target_provider: "cpa" }, "s-owner"));
  assert.ok("code" in validateCreateArgs({ prompt: "p", after_seconds: 60, target_mode: "fork", target_model: "m" }, "s-owner"));
});

test("factory: legacy target_mode workspace normalizes to resume+workspace", () => {
  const spec = validateCreateArgs({ prompt: "p", after_seconds: 60, target_mode: "workspace", target_workspace_id: UUID_A }, "s-owner");
  assert.ok(!("code" in spec), "legacy spelling must stay accepted");
  if ("code" in spec) return;
  assert.deepEqual(spec.target, { mode: "resume", sourceType: "workspace", workspaceId: UUID_A });
  // ...but its session-side fields are rejected like the v3 workspace source.
  assert.ok("code" in validateCreateArgs({ prompt: "p", after_seconds: 60, target_mode: "workspace", target_workspace_id: UUID_A, target_session_id: "s1" }, "s-owner"));
  assert.ok("code" in validateCreateArgs({ prompt: "p", after_seconds: 60, target_mode: "workspace", target_workspace_id: UUID_A, target_preset_id: "dev" }, "s-owner"));
});

/* --------------------------------------------------------- store validity ---- */

test("store: load accepts every stored target shape, drops malformed ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-store-"));
  const good = (id: string, target: Record<string, unknown>): Record<string, unknown> => ({
    id, ownerSessionId: "s-owner", target,
    type: "once", trigger: { at: "2026-09-12T00:00:00.000Z" },
    prompt: "p", respectQuietHours: false, timeZone: "UTC",
    status: "scheduled", nextDueAt: "2026-09-11T00:00:00.000Z",
    createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z",
    runCount: 0, lastRunAt: null
  });
  const bad = (id: string, target: Record<string, unknown>): Record<string, unknown> => good(id, target);
  await (await import("node:fs/promises")).writeFile(join(dir, "alarms.json"), JSON.stringify({
    version: 2,
    alarms: [
      good("ok-new", { mode: "new" }),
      good("ok-new-full", { mode: "new", workspaceId: UUID_A, presetId: "dev", provider: "p", model: "m" }),
      good("ok-preset", { mode: "resume", sourceType: "preset", presetId: "dev" }),
      good("ok-workspace", { mode: "fork", sourceType: "workspace", workspaceId: UUID_A }),
      good("ok-v2-session", { mode: "resume", sessionId: "s1" }),
      good("ok-legacy-workspace", { mode: "workspace", workspaceId: UUID_A }),
      // Malformed arms: preset source without an id; preset id with spaces;
      // workspace-mode record missing its id.
      bad("bad-preset-empty", { mode: "resume", sourceType: "preset" }),
      bad("bad-preset-spaces", { mode: "resume", sourceType: "preset", presetId: "has spaces" }),
      bad("bad-workspace-empty", { mode: "workspace" })
    ]
  }, null, 2), "utf8");
  try {
    const { store, corrupt } = await ProactiveStore.load(dir);
    assert.equal(corrupt, true, "the malformed records must mark the file partially corrupt");
    const ids = store.listAlarms().map((alarm) => alarm.id).sort();
    assert.deepEqual(ids, ["ok-legacy-workspace", "ok-new", "ok-new-full", "ok-preset", "ok-v2-session", "ok-workspace"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------- workspace: preset resolution ---- */

interface LiveFake {
  id: string;
  createdAt: number;
  agentPreset?: string;
  origin?: string;
  events?: Record<string, unknown>[];
}

function presetDeps(live: readonly LiveFake[], opts: {
  cold?: readonly SessionHeaderLike[];
  coldFails?: boolean;
  archived?: readonly string[];
  cache?: { rows: Map<string, { blank: boolean; lastPromptAt: number | null }> };
} = {}): PresetWakeDeps {
  const deps: PresetWakeDeps = {
    liveSessions: () => live.map((entry) => ({
      id: entry.id,
      header: {
        id: entry.id,
        createdAt: entry.createdAt,
        ...(entry.agentPreset !== undefined ? { agentPreset: entry.agentPreset } : {}),
        ...(entry.origin !== undefined ? { origin: entry.origin } : {})
      },
      events: entry.events ?? []
    })) as never,
    ...(opts.cold !== undefined || opts.coldFails === true ? {
      coldHeaders: async () => {
        if (opts.coldFails === true) throw new Error("cold list down");
        return opts.cold ?? [];
      }
    } : {}),
    ...(opts.cache !== undefined ? {
      projectionCache: {
        cachedSnapshot: (header: SessionHeaderLike) => {
          const row = opts.cache!.rows.get(header.id);
          if (row === undefined) return undefined;
          return { values: { sessionListMetadata: row } };
        }
      } as never
    } : {}),
    ...(opts.archived !== undefined ? { archivedSessionIds: () => opts.archived! } : {}),
    log: () => undefined
  };
  return deps;
}

test("resolvePresetWakeTarget: live fold (events win over header), cold headers match", async () => {
  const deps = presetDeps([
    // Header says "general", a later selected event switched to "dev" — the
    // fold must resolve "dev" (the same fold the wake composition uses). The
    // user turn keeps the row visible (non-blank), like a real conversation.
    { id: "s-live", createdAt: 200, agentPreset: "general", events: [
      { type: "agent-preset/selected", seq: 0, data: { agentPreset: "general" } },
      { type: "agent-preset/selected", seq: 1, data: { agentPreset: "dev" } },
      { type: "turn/start", seq: 2, data: { turn: 1 }, time: 250 },
      { type: "user/message", seq: 3, time: 250, data: { content: "hi", id: "m1", role: "user", source: { kind: "user", rpcId: "r1" } } }
    ] },
    // Different preset — not a candidate.
    { id: "s-other", createdAt: 300, agentPreset: "ops" }
  ], {
    cold: [{ id: "s-cold", createdAt: 100, agentPreset: "dev" }]
  });
  const target = await resolvePresetWakeTarget(deps, "dev");
  assert.ok(!("error" in target));
  if ("error" in target) return;
  assert.deepEqual(target, { kind: "session", sessionId: "s-live" }, "the visible live match must win over the older cold row");
});

test("resolvePresetWakeTarget: blank live rows lose to visible cold rows (sidebar semantics)", async () => {
  // The live session never had a turn (only its creation events) — it is the
  // workspace-tree blank slot, and a visible cold session outranks it.
  const deps = presetDeps([{ id: "s-blank", createdAt: 900, agentPreset: "dev" }], {
    cold: [{ id: "s-cold", createdAt: 100, agentPreset: "dev" }]
  });
  const target = await resolvePresetWakeTarget(deps, "dev");
  assert.deepEqual(target, { kind: "session", sessionId: "s-cold" });
});

test("resolvePresetWakeTarget: cold-only match, exclusions, and recency", async () => {
  const deps = presetDeps([], {
    cold: [
      { id: "s-cold-old", createdAt: 100, agentPreset: "dev" },
      { id: "s-cold-new", createdAt: 500, agentPreset: "dev" },
      { id: "s-archived", createdAt: 900, agentPreset: "dev" },
      { id: "s-subagent", createdAt: 900, agentPreset: "dev", origin: "subagent" },
      { id: "s-seeded", createdAt: 950, agentPreset: "dev", isSeeded: true },
      { id: "s-other-preset", createdAt: 990, agentPreset: "ops" }
    ],
    archived: ["s-archived"]
  });
  const target = await resolvePresetWakeTarget(deps, "dev");
  assert.ok(!("error" in target));
  if ("error" in target) return;
  assert.deepEqual(target, { kind: "session", sessionId: "s-seeded" }, "seeded headers carry no cache row -> conservatively visible and newest");
});

test("resolvePresetWakeTarget: none vs failed cold listing", async () => {
  // No candidates anywhere -> none (resume creates; fork fails).
  const empty = await resolvePresetWakeTarget(presetDeps([]), "dev");
  assert.deepEqual(empty, { kind: "none" });
  // Cold listing failed AND no live candidates -> closed error (retry path).
  const failed = await resolvePresetWakeTarget(presetDeps([], { coldFails: true }), "dev");
  assert.ok("error" in failed);
  if (!("error" in failed)) return;
  assert.ok(failed.error.includes("cold session listing failed"));
  // Cold listing failed but a live candidate exists -> the live match stands.
  const withLive = await resolvePresetWakeTarget(presetDeps([{ id: "s-live", createdAt: 1, agentPreset: "dev" }], { coldFails: true }), "dev");
  assert.deepEqual(withLive, { kind: "session", sessionId: "s-live" });
});

/* ------------------------------------------------------- wake fire() v3 ---- */

function fakeRecordingAgent(rec: { messages: unknown[] }) {
  const events: Record<string, unknown>[] = [];
  return {
    agent: {
      session: {
        id: "s1",
        events,
        seq: 0,
        // A roster-mounted setup folds the session preset off its header —
        // the same contract the real dsh agent surface provides.
        header: { version: 0, id: "s1", createdAt: 0, agentPreset: "standard" },
        requestHeader: () => ({ config: { provider: "test", model: "base" } })
      },
      followup: (message: unknown) => {
        rec.messages.push(message);
        events.push({ type: "turn/start", data: { turn: 1 } });
        events.push({ type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "no_reply", arguments: "{}" } });
        events.push({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
      },
      runMaintenance: async (task: () => Promise<unknown>) => { await task(); return true; },
      whenIdle: async () => undefined
    } as unknown as Agent,
    events
  };
}

async function wakeHarness(opts: {
  presetResolve?: () => Promise<{ kind: "session"; sessionId: string } | { kind: "none" } | { error: string }>;
  cwdOf?: (workspaceId: string) => Promise<string | { error: string }>;
  attach?: (workspaceId: string, sessionId: string) => Promise<void>;
  presets?: AgentPresetsPort;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-v3-"));
  const store = new ProactiveStore(dir);
  const rec = { messages: [] as unknown[] };
  const fake = fakeRecordingAgent(rec);
  let resumed = 0;
  let created: CreateFacadeOptions | undefined;
  const agents: AgentsFacade = {
    get: () => undefined as never,
    resume: async () => {
      resumed += 1;
      const handle: AgentHandleLike = { agent: fake.agent, dispose: async () => undefined };
      return handle;
    },
    create: async (options) => {
      created = options;
      return { agent: fake.agent, dispose: async () => undefined };
    }
  };
  const driver = new WakeDriver({
    agents,
    ...(opts.presetResolve !== undefined ? {
      presetTargets: { resolveTarget: opts.presetResolve }
    } : {}),
    ...(opts.cwdOf !== undefined || opts.attach !== undefined ? {
      workspaces: {
        resolveTarget: async () => { throw new Error("unused in these tests"); },
        attach: async (workspaceId: string, sessionId: string) => opts.attach?.(workspaceId, sessionId),
        cwdOf: (workspaceId: string) => opts.cwdOf!(workspaceId)
      }
    } : {}),
    ...(opts.presets !== undefined ? { agentPresets: opts.presets } : {}),
    modelSelection: () => ({ provider: "test", model: "base" }),
    store,
    config: resolveConfig(dir),
    log: () => undefined
  });
  return { driver, store, rec, dir, resumed: () => resumed, created: () => created, fakeAgent: fake.agent };
}

test("wake: preset-source resume lands in the resolved session", async () => {
  const h = await wakeHarness({ presetResolve: async () => ({ kind: "session", sessionId: "s-preset" }) });
  try {
    const fire = await h.driver.fire(v3Alarm({ mode: "resume", sourceType: "preset", presetId: "dev" }));
    assert.equal(fire.outcome, "ok");
    assert.equal(h.resumed(), 1);
    assert.equal(h.rec.messages.length, 1);
    if (fire.outcome === "ok") assert.equal(fire.sessionId, "s-preset");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("wake: preset-source resume with no session creates one composed on the preset", async () => {
  const h = await wakeHarness({ presetResolve: async () => ({ kind: "none" }) });
  try {
    const fire = await h.driver.fire(v3Alarm({ mode: "resume", sourceType: "preset", presetId: "dev" }));
    assert.equal(fire.outcome, "ok");
    assert.equal(h.resumed(), 0, "nothing to resume — the arm must create");
    const created = h.created();
    assert.ok(created !== undefined);
    assert.deepEqual(created.meta, { agentPreset: "dev" });
    assert.equal(created.seed, undefined, "resume-create is fresh, never seeded");
    if (fire.outcome === "ok") assert.equal(fire.sessionId, created.sessionId);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("wake: preset-source fork with no session fails closed", async () => {
  const h = await wakeHarness({ presetResolve: async () => ({ kind: "none" }) });
  try {
    const fire = await h.driver.fire(v3Alarm({ mode: "fork", sourceType: "preset", presetId: "dev" }));
    assert.equal(fire.outcome, "failed");
    if (fire.outcome === "failed") assert.ok(fire.error.includes("no session found running preset dev"));
    assert.equal(h.rec.messages.length, 0);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("wake: preset-source resume without a port fails loudly", async () => {
  const h = await wakeHarness({});
  try {
    const fire = await h.driver.fire(v3Alarm({ mode: "resume", sourceType: "preset", presetId: "dev" }));
    assert.equal(fire.outcome, "failed");
    if (fire.outcome === "failed") assert.ok(fire.error.includes("no preset roster"));
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("wake: new mode with workspace resolves cwd, creates, attaches BEFORE delivering", async () => {
  const trace: string[] = [];
  const h = await wakeHarness({
    cwdOf: async () => "/repos/alpha",
    attach: async (_workspaceId, sessionId) => { trace.push("attach:" + sessionId); },
    presets: { defaultId: "standard", mount: async () => undefined }
  });
  try {
    const fire = await h.driver.fire(v3Alarm({ mode: "new", workspaceId: UUID_A }));
    assert.equal(fire.outcome, "ok");
    const created = h.created();
    assert.ok(created !== undefined);
    assert.equal(created.meta?.cwd, "/repos/alpha");
    assert.equal(created.meta?.agentPreset, "standard");
    assert.ok(created.sessionId.startsWith("session-"));
    assert.deepEqual(trace, ["attach:" + created.sessionId], "attach must complete before the wake is delivered");
    if (fire.outcome === "ok") assert.equal(fire.sessionId, created.sessionId);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("wake: new mode with a missing workspace fails closed without creating", async () => {
  const h = await wakeHarness({
    cwdOf: async () => ({ error: "workspace registry has no workspace " + UUID_B })
  });
  try {
    const fire = await h.driver.fire(v3Alarm({ mode: "new", workspaceId: UUID_B }));
    assert.equal(fire.outcome, "failed");
    if (fire.outcome === "failed") assert.ok(fire.error.includes("no workspace " + UUID_B));
    assert.equal(h.created(), undefined, "no session may be created when the workspace is gone");
    assert.equal(h.rec.messages.length, 0);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("wake: new mode provider/model override threads into agentOptions and the fixed selection", async () => {
  const h = await wakeHarness({
    presets: { defaultId: "standard", mount: async () => undefined }
  });
  try {
    const fire = await h.driver.fire(v3Alarm({ mode: "new", provider: "cpa", model: "gemini-3-flash" }));
    assert.equal(fire.outcome, "ok");
    const created = h.created();
    assert.ok(created !== undefined);
    // Full override: AgentOptions carry it AND the installed selection is
    // fixed (never falls through to the base modelSelection).
    assert.deepEqual(created.agentOptions, { provider: "cpa", model: "gemini-3-flash" });
    assert.equal(typeof created.setup, "function");

    // Execute the real setup against a scoped context, then drive the
    // request waterfall: the override must win over the seed route.
    const agentCtx = new Context();
    Object.defineProperty(agentCtx, "agent", { value: h.fakeAgent, configurable: true });
    await (created.setup as (ctx: Context) => unknown)(agentCtx);
    const waterfall = (agentCtx as unknown as { waterfall: (subject: unknown, name: string, ...args: unknown[]) => Promise<unknown> }).waterfall;
    // system-prompt/assemble snapshots the fixed selection, then
    // agent/request stamps it over the seed route (the platform contract).
    const assembled = (await waterfall(agentCtx, "system-prompt/assemble", {}, {}, () => Promise.resolve({ variables: {} }))) as { variables: Record<string, unknown> };
    assert.deepEqual(assembled.variables, { provider: "cpa", model: "gemini-3-flash" });
    const request = (await waterfall(agentCtx, "agent/request", { turn: 1, step: 1 }, () => Promise.resolve({ provider: "seed", model: "seed", maxTokens: 64 }))) as { provider: string; model: string; maxTokens: number };
    assert.equal(request.provider, "cpa");
    assert.equal(request.model, "gemini-3-flash");
    assert.equal(request.maxTokens, 64);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("wake: new mode partial override merges over the base selection", async () => {
  const h = await wakeHarness({
    presets: { defaultId: "standard", mount: async () => undefined }
  });
  try {
    const fire = await h.driver.fire(v3Alarm({ mode: "new", model: "gemini-3-flash" }));
    assert.equal(fire.outcome, "ok");
    const created = h.created();
    assert.ok(created !== undefined);
    // Partial override: agentOptions merge (model from the alarm, provider
    // from the base selection).
    assert.deepEqual(created.agentOptions, { provider: "test", model: "gemini-3-flash" });
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------- panel contract v3 ---- */

test("createArgsFromForm: v3 arms and stale-field scrubbing", () => {
  const base: PanelCreateForm = { prompt: "p", kind: "every", everySeconds: 3600 };
  // new mode keeps its optional config.
  assert.deepEqual(createArgsFromForm({ ...base, targetMode: "new", targetWorkspaceId: " " + UUID_A + " ", targetPresetId: " dev ", targetProvider: " cpa ", targetModel: " m " }), {
    prompt: "p", every_seconds: 3600, target_mode: "new",
    target_workspace_id: UUID_A, target_preset_id: "dev", target_provider: "cpa", target_model: "m"
  });
  // preset source: leftover session/workspace ids must be scrubbed.
  assert.deepEqual(createArgsFromForm({ ...base, targetMode: "resume", targetSource: "preset", targetSessionId: "s-stale", targetWorkspaceId: UUID_A, targetPresetId: "dev" }), {
    prompt: "p", every_seconds: 3600, target_source: "preset", target_preset_id: "dev"
  });
  // workspace source: leftover session/preset ids scrubbed; legacy mode spelling rides along.
  assert.deepEqual(createArgsFromForm({ ...base, targetMode: "workspace", targetSessionId: "s-stale", targetWorkspaceId: UUID_A }), {
    prompt: "p", every_seconds: 3600, target_mode: "workspace", target_workspace_id: UUID_A
  });
  // session source (default): empty id means the owner session host-side.
  assert.deepEqual(createArgsFromForm({ ...base, targetMode: "resume", targetSource: "session" }), {
    prompt: "p", every_seconds: 3600
  });
  assert.deepEqual(createArgsFromForm({ ...base, targetMode: "resume", targetSource: "session", targetSessionId: " s-2 " }), {
    prompt: "p", every_seconds: 3600, target_session_id: "s-2"
  });
});

test("formFromAlarm: v3 round-trip + legacy folds", () => {
  const row: Parameters<typeof formFromAlarm>[0] = {
    id: "a1",
    sessionId: "s-owner",
    type: "every",
    targetMode: "resume",
    targetSource: "preset",
    targetPresetId: "dev",
    respectQuietHours: true,
    prompt: "p",
    nextDueAt: "2026-09-11T00:00:00.000Z",
    createdAt: "2026-09-11T00:00:00.000Z",
    state: "scheduled",
    compaction: "minimal",
    everySeconds: 3600
  };
  const form = formFromAlarm(row);
  assert.equal(form.targetMode, "resume");
  assert.equal(form.targetSource, "preset");
  assert.equal(form.targetPresetId, "dev");
  assert.equal(form.targetSessionId, undefined);
  // The scrubbed args round-trip back into the same alarm shape.
  const args = createArgsFromForm(form);
  assert.deepEqual(args, { prompt: "p", every_seconds: 3600, respect_quiet_hours: true, compaction: "minimal", target_source: "preset", target_preset_id: "dev" });

  // New-mode row keeps its config.
  const fresh = formFromAlarm({ ...row, targetMode: "new", targetSource: undefined, targetPresetId: "dev", targetProvider: "cpa", targetModel: "m", targetWorkspaceId: UUID_A });
  assert.equal(fresh.targetMode, "new");
  assert.equal(fresh.targetSource, undefined);
  assert.deepEqual(createArgsFromForm(fresh), {
    prompt: "p", every_seconds: 3600, respect_quiet_hours: true, compaction: "minimal",
    target_mode: "new", target_workspace_id: UUID_A, target_preset_id: "dev", target_provider: "cpa", target_model: "m"
  });

  // Legacy workspace-mode row folds to resume + workspace source; saving
  // converges the stored record onto the v3 spelling.
  const legacy = formFromAlarm({ ...row, targetMode: "workspace", targetSource: undefined, targetPresetId: undefined, targetWorkspaceId: UUID_A });
  assert.equal(legacy.targetMode, "resume");
  assert.equal(legacy.targetSource, "workspace");
  assert.deepEqual(createArgsFromForm(legacy), {
    prompt: "p", every_seconds: 3600, respect_quiet_hours: true, compaction: "minimal",
    target_source: "workspace", target_workspace_id: UUID_A
  });

  // v2 row (no targetSource on the wire): session id infers the session source.
  const v2 = formFromAlarm({ ...row, targetSource: undefined, targetPresetId: undefined, targetSessionId: "s-2" });
  assert.equal(v2.targetMode, "resume");
  assert.equal(v2.targetSource, "session");
  assert.equal(v2.targetSessionId, "s-2");
});

test("wake fire result type accepts the v3 outcomes (compile-time contract)", () => {
  // Guard the exported result union: failed carries an error, busy carries
  // nothing extra — the fire() v3 arms rely on exactly these shapes.
  const failed: WakeFireResult = { outcome: "failed", error: "x" };
  const busy: WakeFireResult = { outcome: "busy" };
  assert.equal(failed.outcome, "failed");
  assert.equal(busy.outcome, "busy");
});
