/**
 * Workspace-target unit tests: the pure ranking/fold functions, the
 * create-side argument normalization, and the fire-side destination
 * resolution (live fold, cold projection-cache rows, blank reuse,
 * plugin-created exclusion). Driver-level delivery (guard/attach ordering)
 * lives in wake.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createdSessionEligible, createWorkspaceWakePort, listMetadataOf, liveEventsOf, pickWorkspaceTarget,
  resolveWorkspaceArg, resolveWorkspaceWakeTarget, updatedAtOf,
  type LiveSessionLike, type ProjectionCacheLike, type SessionHeaderLike, type WorkspaceCandidate, type WorkspaceLike, type WorkspaceRegistryFacade
} from "../src/workspace.js";

function workspace(overrides: Partial<WorkspaceLike> = {}): WorkspaceLike {
  return {
    id: "ws-1",
    path: "/repos/alpha",
    title: "alpha",
    sessionIds: [],
    ...overrides
  };
}

function registry(overrides: Partial<WorkspaceRegistryFacade> = {}): WorkspaceRegistryFacade {
  const ws = workspace();
  return {
    get: (id: string) => (id === ws.id ? ws : undefined),
    resolveByPath: async (path: string) => (path === ws.path ? ws : undefined),
    archivedSessionIds: [],
    ...overrides
  };
}

/* ---------------------------------------------------------------- fold ---- */

test("listMetadataOf: blank flips on first turn, lastPromptAt only tracks human prompts (real event shape)", () => {
  assert.deepEqual(listMetadataOf([]), { blank: true, lastPromptAt: null });
  assert.deepEqual(listMetadataOf([{ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }]), { blank: false, lastPromptAt: null });

  // Real SessionEvent shape: {type, seq, time, data}; the message time is at
  // the TOP level and data carries {content, id, role, source} (verified
  // against persisted session logs and the host applySessionListMetadata).
  // a human prompt at t=100 (turn/start makes the session non-blank)
  const human = { type: "user/message", seq: 1, time: 100, data: { source: { kind: "user" } } };
  // a plugin-source wake notice at t=200 — must NOT move lastPromptAt
  const wake = { type: "user/message", seq: 2, time: 200, data: { source: { kind: "plugin", name: "dsh-proactive", summary: "s" } } };
  const folded = listMetadataOf([{ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }, human, wake]);
  assert.equal(folded.lastPromptAt, 100);
  assert.equal(folded.blank, false);

  // later human prompt wins (host fold is last-wins, not max)
  const later = listMetadataOf([human, wake, { type: "user/message", seq: 3, time: 300, data: { source: { kind: "user" } } }]);
  assert.equal(later.lastPromptAt, 300);
  // out-of-order log times: last-wins keeps the LAST event's time, matching host
  const shuffled = listMetadataOf([wake, { type: "user/message", seq: 4, time: 50, data: { source: { kind: "user" } } }]);
  assert.equal(shuffled.lastPromptAt, 50);

  // data.time (the WRONG field the first implementation read) must never match
  const legacyShape = { type: "user/message", seq: 5, time: 400, data: { source: { kind: "user" }, time: 999 } };
  assert.equal(listMetadataOf([legacyShape]).lastPromptAt, 400);
});

test("updatedAtOf: the later of creation and last prompt", () => {
  assert.equal(updatedAtOf(50, undefined), 50);
  assert.equal(updatedAtOf(50, { lastPromptAt: null }), 50);
  assert.equal(updatedAtOf(50, { lastPromptAt: 80 }), 80);
  assert.equal(updatedAtOf(90, { lastPromptAt: 80 }), 90);
});

/* --------------------------------------------------------------- pick ----- */

function candidate(overrides: Partial<WorkspaceCandidate>): WorkspaceCandidate {
  return { sessionId: "s", updatedAt: 1, createdAt: 1, blank: false, subagent: false, ...overrides };
}

test("pickWorkspaceTarget: most recent visible session wins", () => {
  const pick = pickWorkspaceTarget([
    candidate({ sessionId: "older", updatedAt: 10 }),
    candidate({ sessionId: "newer", updatedAt: 20 })
  ]);
  assert.deepEqual(pick, { kind: "session", sessionId: "newer" });
});

test("pickWorkspaceTarget: blank rows are reused only when no visible row exists", () => {
  // a visible row is older than a blank one: the visible row still wins
  const visibleWins = pickWorkspaceTarget([
    candidate({ sessionId: "blank-slot", updatedAt: 99, blank: true }),
    candidate({ sessionId: "conversation", updatedAt: 1 })
  ]);
  assert.deepEqual(visibleWins, { kind: "session", sessionId: "conversation" });

  // no visible rows: the newest blank slot (GUI New Session semantics)
  const blankWins = pickWorkspaceTarget([
    candidate({ sessionId: "blank-old", updatedAt: 5, blank: true }),
    candidate({ sessionId: "blank-new", updatedAt: 6, blank: true })
  ]);
  assert.deepEqual(blankWins, { kind: "session", sessionId: "blank-new" });
});

test("pickWorkspaceTarget: subagent sessions are never eligible", () => {
  const pick = pickWorkspaceTarget([
    candidate({ sessionId: "sub-newest", updatedAt: 99, subagent: true }),
    candidate({ sessionId: "conversation", updatedAt: 1 })
  ]);
  assert.deepEqual(pick, { kind: "session", sessionId: "conversation" });

  // ONLY subagents exist -> none, never land in a subagent child
  assert.deepEqual(pickWorkspaceTarget([candidate({ sessionId: "sub", subagent: true })]), { kind: "none" });
});

test("pickWorkspaceTarget: deterministic tie-break updatedAt -> createdAt -> id", () => {
  const sameUpdated = pickWorkspaceTarget([
    candidate({ sessionId: "b", updatedAt: 10, createdAt: 1 }),
    candidate({ sessionId: "a", updatedAt: 10, createdAt: 2 })
  ]);
  assert.deepEqual(sameUpdated, { kind: "session", sessionId: "a" });

  const fullTie = pickWorkspaceTarget([
    candidate({ sessionId: "aaa", updatedAt: 10, createdAt: 1 }),
    candidate({ sessionId: "zzz", updatedAt: 10, createdAt: 1 })
  ]);
  assert.deepEqual(fullTie, { kind: "session", sessionId: "zzz" });
});

test("pickWorkspaceTarget: empty workspace picks none (the fire is skipped, never creates)", () => {
  assert.deepEqual(pickWorkspaceTarget([]), { kind: "none" });
});

/* ------------------------------------------------- create-side wiring ----- */

test("resolveWorkspaceArg: explicit id passes through after existence check", async () => {
  const resolved = await resolveWorkspaceArg({ target_workspace_id: "ws-1", prompt: "p" }, { registry: registry() });
  assert.deepEqual(resolved, { prompt: "p", target_workspace_id: "ws-1" });
});

test("resolveWorkspaceArg: unknown id and malformed id are closed errors", async () => {
  const missing = await resolveWorkspaceArg({ target_workspace_id: "ws-x" }, { registry: registry() });
  assert.equal(missing.code, "not_found");

  const malformed = await resolveWorkspaceArg({ target_workspace_id: "bad id!" }, { registry: registry() });
  assert.equal(malformed.code, "invalid_trigger");
});

test("resolveWorkspaceArg: path resolves to the canonical id and is stripped", async () => {
  const resolved = await resolveWorkspaceArg({ target_workspace_path: "/repos/alpha", prompt: "p" }, { registry: registry() });
  assert.deepEqual(resolved, { prompt: "p", target_workspace_id: "ws-1" });
});

test("resolveWorkspaceArg: unregistered path and cwd-less default are closed errors", async () => {
  const unregistered = await resolveWorkspaceArg({ target_workspace_path: "/nowhere" }, { registry: registry() });
  assert.equal(unregistered.code, "not_found");

  const noSelector = await resolveWorkspaceArg({}, { registry: registry() });
  assert.equal(noSelector.code, "invalid_trigger");
});

test("resolveWorkspaceArg: default arm derives the workspace from the creator session's cwd", async () => {
  const resolved = await resolveWorkspaceArg({}, { registry: registry(), sessionCwd: "/repos/alpha" });
  assert.deepEqual(resolved, { target_workspace_id: "ws-1" });

  const foreign = await resolveWorkspaceArg({}, { registry: registry(), sessionCwd: "/other" });
  assert.equal(foreign.code, "not_found");
});

test("resolveWorkspaceArg: id and path together are rejected", async () => {
  const both = await resolveWorkspaceArg({ target_workspace_id: "ws-1", target_workspace_path: "/repos/alpha" }, { registry: registry() });
  assert.equal(both.code, "invalid_trigger");
});

/* ------------------------------------------------ fire-side resolution ---- */

function liveSession(overrides: Partial<LiveSessionLike> & { id: string }): LiveSessionLike {
  return { events: [], ...overrides };
}

function coldHeader(overrides: Partial<SessionHeaderLike> & { id: string }): SessionHeaderLike {
  return { createdAt: 1, ...overrides };
}

function cacheWith(rows: Record<string, { blank: boolean; lastPromptAt: number | null }>): ProjectionCacheLike {
  return {
    cachedSnapshot: (meta: SessionHeaderLike) => {
      const row = rows[meta.id];
      return row === undefined ? undefined : { values: { sessionListMetadata: row } };
    }
  };
}

test("resolveWorkspaceWakeTarget: live fold ranks by sidebar updatedAt", async () => {
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["a", "b", "c"] }),
      resolveByPath: async () => undefined
    }),
    liveSessions: () => [
      // Real event shape: time at the top level, data = {content, id, role, source}.
      liveSession({ id: "a", header: { createdAt: 100 }, events: [{ type: "turn/start", seq: 0, time: 100, data: { turn: 1 } }, { type: "user/message", seq: 1, time: 150, data: { source: { kind: "user" } } }] }),
      liveSession({ id: "b", header: { createdAt: 300 }, events: [{ type: "turn/start", seq: 0, time: 300, data: { turn: 1 } }, { type: "user/message", seq: 1, time: 310, data: { source: { kind: "user" } } }] }),
      // a wake notice moved nothing: c's updatedAt stays at its last prompt
      liveSession({ id: "c", header: { createdAt: 500 }, events: [
        { type: "turn/start", seq: 0, time: 500, data: { turn: 1 } },
        { type: "user/message", seq: 1, time: 320, data: { source: { kind: "user" } } },
        { type: "user/message", seq: 2, time: 900, data: { source: { kind: "plugin", name: "dsh-proactive", summary: "s" } } }
      ] })
    ],
    log: () => undefined
  };
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  assert.deepEqual(destination, { kind: "session", sessionId: "c" }); // 320 > 310 > 150
});

test("resolveWorkspaceWakeTarget: B1 discriminator — older createdAt but newer human prompt wins (live)", async () => {
  // The first implementation read data.time (always undefined) so lastPromptAt
  // collapsed to null and updatedAt degenerated to createdAt: the newest
  // CREATED session won even though the user's latest activity was elsewhere.
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["old-active", "new-quiet"] }),
      resolveByPath: async () => undefined
    }),
    liveSessions: () => [
      // created first, but the user's latest prompt landed here (t=900)
      liveSession({ id: "old-active", header: { createdAt: 100 }, events: [
        { type: "turn/start", seq: 0, time: 100, data: { turn: 1 } },
        { type: "user/message", seq: 1, time: 900, data: { source: { kind: "user" } } }
      ] }),
      // created later, untouched since (updatedAt = createdAt = 300)
      liveSession({ id: "new-quiet", header: { createdAt: 300 }, events: [
        { type: "turn/start", seq: 0, time: 300, data: { turn: 1 } }
      ] })
    ],
    log: () => undefined
  };
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  assert.deepEqual(destination, { kind: "session", sessionId: "old-active" }); // 900 > 300
});

test("resolveWorkspaceWakeTarget: live + cold mix — a cold row's cached lastPromptAt outranks a newer-created live row", async () => {
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["cold-active", "live-quiet"] }),
      resolveByPath: async () => undefined
    }),
    liveSessions: () => [
      liveSession({ id: "live-quiet", header: { createdAt: 500 }, events: [{ type: "turn/start", seq: 0, time: 500, data: { turn: 1 } }] })
    ],
    coldHeaders: async () => [coldHeader({ id: "cold-active", createdAt: 100 })],
    projectionCache: cacheWith({ "cold-active": { blank: false, lastPromptAt: 900 } }),
    log: () => undefined
  };
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  assert.deepEqual(destination, { kind: "session", sessionId: "cold-active" }); // 900 > 500
});

test("resolveWorkspaceWakeTarget: live sessions read the log across dsh Session lines (0.1.2 dropped .events)", async () => {
  // A 0.1.2-rc.1 live session: snapshotEvents() only, .events absent.
  const modern: LiveSessionLike = {
    id: "modern",
    header: { createdAt: 400 },
    snapshotEvents: () => [
      { type: "turn/start", seq: 0, time: 400, data: { turn: 1 } },
      { type: "user/message", seq: 1, time: 420, data: { source: { kind: "user" } } }
    ]
  };
  // The GUI's fresh New Session slot: no readable log at all -> folds blank.
  const bare: LiveSessionLike = { id: "bare", header: { createdAt: 900 } };
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["modern", "bare"] }),
      resolveByPath: async () => undefined
    }),
    liveSessions: () => [modern, bare],
    log: () => undefined
  };
  // bare is newer but blank — the visible modern session wins, and the fold
  // never throws on the missing .events getter.
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  assert.deepEqual(destination, { kind: "session", sessionId: "modern" });
});

test("liveEventsOf: .events first, snapshotEvents() second, unreadable folds empty", () => {
  const old = { id: "a", events: [{ seq: 0 }] };
  const modern = { id: "b", snapshotEvents: () => [{ seq: 0 }] };
  const throwing = { id: "c", snapshotEvents: () => { throw new Error("sealed"); } };
  const bare = { id: "d" };
  assert.deepEqual(liveEventsOf(old), [{ seq: 0 }]);
  assert.deepEqual(liveEventsOf(modern), [{ seq: 0 }]);
  assert.deepEqual(liveEventsOf(throwing), []);
  assert.deepEqual(liveEventsOf(bare), []);
});

test("resolveWorkspaceWakeTarget: archived and subagent sessions are skipped", async () => {
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["arch", "sub", "ok"] }),
      resolveByPath: async () => undefined,
      archivedSessionIds: ["arch"]
    }),
    liveSessions: () => [
      liveSession({ id: "arch", header: { createdAt: 999 } }),
      liveSession({ id: "sub", header: { createdAt: 900, origin: "subagent" } }),
      liveSession({ id: "ok", header: { createdAt: 1 } })
    ],
    log: () => undefined
  };
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  assert.deepEqual(destination, { kind: "session", sessionId: "ok" });
});

test("resolveWorkspaceWakeTarget: newest blank session is reused before creating", async () => {
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["blank-new", "blank-old"] }),
      resolveByPath: async () => undefined
    }),
    liveSessions: () => [
      liveSession({ id: "blank-new", header: { createdAt: 50 }, events: [] }), // never had a turn
      liveSession({ id: "blank-old", header: { createdAt: 10 }, events: [] })
    ],
    log: () => undefined
  };
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  assert.deepEqual(destination, { kind: "session", sessionId: "blank-new" });
});

test("resolveWorkspaceWakeTarget: cold sessions rank via projection-cache rows", async () => {
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["cold-prompted", "cold-created-later"] }),
      resolveByPath: async () => undefined
    }),
    liveSessions: () => [],
    coldHeaders: async () => [
      coldHeader({ id: "cold-prompted", createdAt: 10 }),
      coldHeader({ id: "cold-created-later", createdAt: 900 })
    ],
    projectionCache: cacheWith({
      "cold-prompted": { blank: false, lastPromptAt: 800 },
      "cold-created-later": { blank: false, lastPromptAt: 20 }
    }),
    log: () => undefined
  };
  // updatedAt = max(createdAt, lastPromptAt): 900 (created-later) vs 800
  // (prompted) — the sidebar key is the later of the two, so 900 wins.
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  assert.deepEqual(destination, { kind: "session", sessionId: "cold-created-later" });
});

test("resolveWorkspaceWakeTarget: cold session without a cache row counts as visible", async () => {
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["no-row"] }),
      resolveByPath: async () => undefined
    }),
    liveSessions: () => [],
    coldHeaders: async () => [coldHeader({ id: "no-row", createdAt: 5 })],
    projectionCache: cacheWith({}),
    log: () => undefined
  };
  // blank === metadata?.blank === true -> undefined === true is false -> visible
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  assert.deepEqual(destination, { kind: "session", sessionId: "no-row" });
});

test("resolveWorkspaceWakeTarget: cold session absent from persistence is not a destination (none, not create)", async () => {
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["ghost"] }),
      resolveByPath: async () => undefined
    }),
    liveSessions: () => [],
    coldHeaders: async () => [],
    log: () => undefined
  };
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  assert.deepEqual(destination, { kind: "none" });
});

test("cwdOf: missing workspace directory is a closed error (never mkdir a ghost dir)", async () => {
  const missingDir = workspace({
    sessionIds: [],
    status: async () => "missing-dir" as const
  });
  const port = createWorkspaceWakePort({
    registry: registry({ get: (id: string) => (id === missingDir.id ? missingDir : undefined), resolveByPath: async () => undefined }),
    liveSessions: () => [],
    log: () => undefined
  });
  const cwd = await port.cwdOf("ws-1");
  assert.equal((cwd as { error: string }).error.includes("missing"), true);

  const healthy = createWorkspaceWakePort({
    registry: registry({ resolveByPath: async () => undefined }),
    liveSessions: () => [],
    log: () => undefined
  });
  assert.deepEqual(await healthy.cwdOf("ws-1"), "/repos/alpha");
});

/* --------------------------------------------- plugin-created exclusion ---- */

test("createdSessionEligible: only adopted new products stay eligible", () => {
  // a target_mode-new product the user typed in follows the user again
  assert.equal(createdSessionEligible("new", 950), true);
  // nobody typed in the plugin's fresh session
  assert.equal(createdSessionEligible("new", null), false);
  // cold row with no cache entry: lastPromptAt unknown
  assert.equal(createdSessionEligible("new", undefined), false);
  // fork children inherit their parent's human history — never eligible
  assert.equal(createdSessionEligible("fork", 900), false);
  assert.equal(createdSessionEligible("fork", null), false);
});

test("resolveWorkspaceWakeTarget: live plugin-created new product without a human prompt is excluded, older conversation wins", async () => {
  // The capture bug this fixes: the plugin's own target_mode-new product is
  // createdAt-top-ranked (createdAt = fire time), so a workspace alarm would
  // wake inside the plugin's own echo. Bookkeeping (kind "new", lastPromptAt
  // null) must drop it.
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["plugin-new", "conversation"] }),
      resolveByPath: async () => undefined
    }),
    liveSessions: () => [
      liveSession({ id: "plugin-new", header: { createdAt: 900 }, events: [
        { type: "turn/start", seq: 0, time: 900, data: { turn: 1 } },
        { type: "user/message", seq: 1, time: 950, data: { source: { kind: "plugin", name: "dsh-proactive", summary: "s" } } }
      ] }),
      liveSession({ id: "conversation", header: { createdAt: 100 }, events: [
        { type: "turn/start", seq: 0, time: 100, data: { turn: 1 } },
        { type: "user/message", seq: 1, time: 500, data: { source: { kind: "user" } } }
      ] })
    ],
    createdSessionKind: (id: string) => (id === "plugin-new" ? "new" as const : undefined),
    log: () => undefined
  };
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  assert.deepEqual(destination, { kind: "session", sessionId: "conversation" });
});

test("resolveWorkspaceWakeTarget: live plugin-created new product the user adopted (human prompt) wins again", async () => {
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["plugin-new", "conversation"] }),
      resolveByPath: async () => undefined
    }),
    liveSessions: () => [
      liveSession({ id: "plugin-new", header: { createdAt: 900 }, events: [
        { type: "turn/start", seq: 0, time: 900, data: { turn: 1 } },
        { type: "user/message", seq: 1, time: 950, data: { source: { kind: "user" } } }
      ] }),
      liveSession({ id: "conversation", header: { createdAt: 100 }, events: [
        { type: "turn/start", seq: 0, time: 100, data: { turn: 1 } },
        { type: "user/message", seq: 1, time: 500, data: { source: { kind: "user" } } }
      ] })
    ],
    createdSessionKind: (id: string) => (id === "plugin-new" ? "new" as const : undefined),
    log: () => undefined
  };
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  assert.deepEqual(destination, { kind: "session", sessionId: "plugin-new" }); // 950 > 500
});

test("resolveWorkspaceWakeTarget: live fork child is excluded even though it carries human history", async () => {
  // A fork child inherits the parent's human turns, so lastPromptAt alone is
  // no proof of adoption — only bookkeeping can drop it.
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["fork-child", "conversation"] }),
      resolveByPath: async () => undefined
    }),
    liveSessions: () => [
      liveSession({ id: "fork-child", header: { createdAt: 900 }, events: [
        { type: "turn/start", seq: 0, time: 900, data: { turn: 1 } },
        { type: "user/message", seq: 1, time: 950, data: { source: { kind: "user" } } }
      ] }),
      liveSession({ id: "conversation", header: { createdAt: 100 }, events: [
        { type: "turn/start", seq: 0, time: 100, data: { turn: 1 } },
        { type: "user/message", seq: 1, time: 500, data: { source: { kind: "user" } } }
      ] })
    ],
    createdSessionKind: (id: string) => (id === "fork-child" ? "fork" as const : undefined),
    log: () => undefined
  };
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  assert.deepEqual(destination, { kind: "session", sessionId: "conversation" });
});

test("resolveWorkspaceWakeTarget: cold plugin-created rows follow the cache row's lastPromptAt", async () => {
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["cold-adopted", "cold-fresh", "cold-no-row", "plain"] }),
      resolveByPath: async () => undefined
    }),
    liveSessions: () => [],
    coldHeaders: async () => [
      coldHeader({ id: "cold-adopted", createdAt: 10 }),
      coldHeader({ id: "cold-fresh", createdAt: 900 }),
      coldHeader({ id: "cold-no-row", createdAt: 800 }),
      coldHeader({ id: "plain", createdAt: 5 })
    ],
    // cold-no-row deliberately has NO cache row (unknown lastPromptAt).
    projectionCache: cacheWith({
      "cold-adopted": { blank: false, lastPromptAt: 800 },
      "cold-fresh": { blank: false, lastPromptAt: null }
    }),
    createdSessionKind: (id: string) => (id === "plain" ? undefined : "new" as const),
    log: () => undefined
  };
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  // cold-adopted (800) eligible; cold-fresh excluded (null); cold-no-row
  // excluded (no cache row = unknown lastPromptAt, conservative); plain is
  // not plugin-created so it stays — 800 > 5.
  assert.deepEqual(destination, { kind: "session", sessionId: "cold-adopted" });
});

test("resolveWorkspaceWakeTarget: only plugin-created sessions -> none", async () => {
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["plugin-new", "fork-child"] }),
      resolveByPath: async () => undefined
    }),
    liveSessions: () => [
      liveSession({ id: "plugin-new", header: { createdAt: 900 }, events: [{ type: "turn/start", seq: 0, time: 900, data: { turn: 1 } }] }),
      liveSession({ id: "fork-child", header: { createdAt: 800 }, events: [
        { type: "turn/start", seq: 0, time: 800, data: { turn: 1 } },
        { type: "user/message", seq: 1, time: 850, data: { source: { kind: "user" } } }
      ] })
    ],
    createdSessionKind: (id: string) => (id === "plugin-new" ? "new" as const : "fork" as const),
    log: () => undefined
  };
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  assert.deepEqual(destination, { kind: "none" });
});

test("resolveWorkspaceWakeTarget: vanished workspace is a closed error", async () => {
  const deps = { registry: registry({ get: () => undefined, resolveByPath: async () => undefined }), liveSessions: () => [], log: () => undefined };
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-gone");
  assert.equal((destination as { error: string }).error.includes("no longer exists"), true);
});

test("resolveWorkspaceWakeTarget: persistence listing failure degrades to live-only, never to create", async () => {
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["live-only", "cold-1"] }),
      resolveByPath: async () => undefined
    }),
    liveSessions: () => [liveSession({ id: "live-only", header: { createdAt: 1 } })],
    coldHeaders: () => { throw new Error("disk unavailable"); },
    log: () => undefined
  };
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  assert.deepEqual(destination, { kind: "session", sessionId: "live-only" });
});

test("resolveWorkspaceWakeTarget: cold failure with NO live candidates is a closed error, not a skip", async () => {
  // All-cold workspace + transient persistence failure: "no eligible
  // session" is unproven, so the fire must not be skipped — fail into the
  // retry path instead.
  const deps = {
    registry: registry({
      get: () => workspace({ sessionIds: ["cold-1"] }),
      resolveByPath: async () => undefined
    }),
    liveSessions: () => [],
    coldHeaders: () => { throw new Error("disk unavailable"); },
    log: () => undefined
  };
  const destination = await resolveWorkspaceWakeTarget(deps, "ws-1");
  assert.equal((destination as { error: string }).error.includes("cold session listing failed"), true);
});

test("resolveWorkspaceArg: a path whose directory vanished (realpath ENOENT) is a closed not_found, not a throw", async () => {
  const deps = {
    registry: registry({
      get: () => undefined,
      resolveByPath: () => Promise.reject(Object.assign(new Error("ENOENT: no such file or directory, realpath '/gone/dir'"), { code: "ENOENT" }))
    })
  };
  const resolved = await resolveWorkspaceArg({ target_workspace_path: "/gone/dir", prompt: "p" }, deps);
  assert.equal((resolved as { code: string }).code, "not_found");
  assert.equal((resolved as { code: string; message: string }).message.includes("does not exist"), true);

  const nonEnoent = await resolveWorkspaceArg({ target_workspace_path: "/x" }, {
    registry: registry({
      get: () => undefined,
      resolveByPath: () => Promise.reject(new Error("registry exploded"))
    })
  });
  assert.equal((nonEnoent as { code: string }).code, "not_found");
  assert.equal((nonEnoent as { code: string; message: string }).message.includes("registry exploded"), true);
});

test("createWorkspaceWakePort: attach routes through the registry record", async () => {
  const attached: string[] = [];
  const ws = workspace({
    attachSession: async (sessionId: string) => { attached.push(sessionId); }
  });
  const port = createWorkspaceWakePort({
    registry: registry({ get: (id: string) => (id === ws.id ? ws : undefined), resolveByPath: async () => undefined }),
    liveSessions: () => [],
    log: () => undefined
  });
  await port.attach("ws-1", "session-new");
  assert.deepEqual(attached, ["session-new"]);

  await assert.rejects(() => port.attach("ws-gone", "session-new"), /no longer exists/);
});
