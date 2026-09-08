/**
 * Panel + settings-wiring unit tests: the host side of the GUI feature.
 * Covers the closed action vocabulary end-to-end over an in-memory store,
 * hot-config application, and the store change hooks powering SSE.
 *
 * v2 (260907-proactive-alarm-v2): ownership is the alarm's creator
 * (ownerSessionId); fork/new child wakes appear in the owner's run history.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProactiveStore } from "../src/store.js";
import { ProactivePanelService } from "../src/panel/service.js";
import { applyHotConfig, hotSubset } from "../src/settings.js";
import { DEFAULT_CONFIG, type ProactiveConfig } from "../src/config.js";
import { createArgsFromForm, type PanelCreateForm } from "../src/panel/contract.js";

const NOW = Date.parse("2026-08-29T12:00:00.000Z");

interface Harness {
  store: ProactiveStore;
  service: ProactivePanelService;
  drives: () => number;
  config: ProactiveConfig;
  /** Advance the harness clock; alarms become overdue / anchor-aligned as time moves. */
  advance: (ms: number) => void;
}

async function harness(titleOverrides?: Record<string, string>): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-proactive-panel-"));
  const store = new ProactiveStore(dir);
  const config: ProactiveConfig = { ...DEFAULT_CONFIG, quietHours: { ...DEFAULT_CONFIG.quietHours } };
  const drives: { count: number } = { count: 0 };
  let clock = NOW;
  const service = new ProactivePanelService({
    store,
    config,
    scheduler: { requestDrive: () => { drives.count += 1; } },
    dataDir: dir,
    now: () => clock,
    log: () => undefined,
    sessionTitle: (sessionId) => titleOverrides?.[sessionId] ?? "",
    sessionEvents: (sessionId) => (sessionId.startsWith("sess-") ? [{ type: "user/message", source: { kind: "user", rpcId: "r1", clientTimeZone: "Asia/Tokyo" } }] : undefined)
  });
  return { store, service, drives: () => drives.count, config, advance: (ms) => { clock += ms; } };
}

function createAction(session: string, extra: Record<string, unknown> = {}): unknown {
  return { action: { kind: "create", sessionId: session, args: { prompt: "Check in with the user", after_seconds: 60, ...extra } } };
}

const row = (snap: { alarms: Array<Record<string, unknown>> }, index = 0): Record<string, unknown> => snap.alarms[index] as Record<string, unknown>;

test("panel: create -> visible in snapshot -> cancel -> not_found", async () => {
  const h = await harness();
  const created = await h.service.action(createAction("sess-a"));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const alarm = created.snapshot.alarms[0];
  assert.ok(alarm.id.startsWith("alarm_"));
  assert.equal(alarm.state, "scheduled");
  assert.equal(created.snapshot.alarms.length, 1);
  assert.equal(created.snapshot.runs.length, 0);
  const cancelled = await h.service.action({ action: { kind: "cancel", id: alarm.id } });
  assert.equal(cancelled.ok, true);
  if (!cancelled.ok) return;
  assert.equal(cancelled.snapshot.alarms.length, 0);
  const missing = await h.service.action({ action: { kind: "cancel", id: alarm.id } });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.error.code, "not_found");
});

test("panel: create rejects a bad trigger through the shared validator", async () => {
  const h = await harness();
  const bad = await h.service.action(createAction("sess-a", { after_seconds: 0 }));
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.error.code, "invalid_trigger");
  const twoSelectors = await h.service.action(createAction("sess-a", { every_seconds: 3600 }));
  assert.equal(twoSelectors.ok, false);
});

test("panel: toggle pauses then resumes an every alarm", async () => {
  const h = await harness();
  const created = await h.service.action({ action: { kind: "create", sessionId: "sess-a", args: { prompt: "Check in with the user", every_seconds: 3600 } } });
  assert.equal(created.ok, true, "every create must not silently fail");
  if (!created.ok) return;
  const id = created.snapshot.alarms[0].id;
  // Move the clock past the first occurrence so resume visibly re-anchors
  // instead of resolving to the same instant (constant-clock footgun).
  h.advance(7200_000);
  const paused = await h.service.action({ action: { kind: "toggle", id } });
  assert.equal(paused.ok, true);
  if (!paused.ok) return;
  assert.equal(paused.snapshot.alarms[0].state, "paused");
  const resumed = await h.service.action({ action: { kind: "toggle", id } });
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.snapshot.alarms[0].state, "scheduled");
  assert.ok(resumed.snapshot.alarms[0].nextDueAt > created.snapshot.alarms[0].nextDueAt, "every resumes to the next anchor");
});

test("panel: fire re-arms an alarm at now and requests a drive", async () => {
  const h = await harness();
  const created = await h.service.action(createAction("sess-a"));
  if (!created.ok) return;
  const id = created.snapshot.alarms[0].id;
  const fired = await h.service.action({ action: { kind: "fire", id } });
  assert.equal(fired.ok, true);
  if (!fired.ok) return;
  assert.equal(fired.snapshot.alarms[0].nextDueAt, new Date(NOW).toISOString());
  assert.ok(h.drives() >= 1);
});

test("panel: unknown action kind and malformed envelope are rejected", async () => {
  const h = await harness();
  const unknown = await h.service.action({ action: { kind: "explode" } });
  assert.equal(unknown.ok, false);
  if (unknown.ok) return;
  assert.equal(unknown.error.code, "bad_action");
  const noEnvelope = await h.service.action({ nope: true });
  assert.equal(noEnvelope.ok, false);
});

test("panel snapshot carries configuration summary (no heartbeat dial)", async () => {
  const h = await harness();
  const snap = await h.service.snapshot();
  assert.equal(snap.config.enabled, h.config.enabled);
  assert.equal(snap.config.quietHours.start, h.config.quietHours.start);
  assert.ok(!("heartbeatPrompt" in snap.config), "v2 config view has no heartbeatPrompt");
  assert.equal(snap.server.dataDir, h.store.dataDir);
});

test("panel: jittered every appears in the snapshot", async () => {
  const h = await harness();
  const created = await h.service.action({ action: { kind: "create", sessionId: "sess-a", args: { prompt: "p", every_seconds: 3600, jitter_seconds: 120 } } });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.snapshot.alarms[0].jitterSeconds, 120);
  assert.equal(created.snapshot.alarms[0].everySeconds, 3600, "every rows carry everySeconds for the edit form");
  const id = created.snapshot.alarms[0].id;
  // Pause + resume keeps the alarm alive; the resumed due is strictly future.
  const paused = await h.service.action({ action: { kind: "toggle", id } });
  assert.equal(paused.ok, true);
  if (!paused.ok) return;
  const resumed = await h.service.action({ action: { kind: "toggle", id } });
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.snapshot.alarms[0].state, "scheduled");
  assert.ok(Date.parse(resumed.snapshot.alarms[0].nextDueAt) > NOW);
});

test("panel: create without time_zone uses the selector session's browser zone", async () => {
  const h = await harness();
  const created = await h.service.action(createAction("sess-a"));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(h.store.listAlarms().find((alarm) => alarm.ownerSessionId === "sess-a")?.timeZone, "Asia/Tokyo");
  // A local at instant flows through the same chain when the form left the
  // at zone empty (the panel has no zone field at all).
  const at = await h.service.action({ action: { kind: "create", sessionId: "sess-a", args: { prompt: "p", at: { date: "2026-09-02", time: "14:30:00", time_zone: "" } } } });
  assert.equal(at.ok, true);
  if (!at.ok) return;
  const atAlarm = h.store.listAlarms().filter((alarm) => alarm.ownerSessionId === "sess-a").at(-1);
  assert.equal(atAlarm?.timeZone, "Asia/Tokyo");
  // explicit time_zone still wins
  const explicit = await h.service.action({ action: { kind: "create", sessionId: "sess-b", args: { prompt: "p", after_seconds: 60, time_zone: "UTC" } } });
  assert.equal(explicit.ok, true);
  if (!explicit.ok) return;
  assert.equal(h.store.listAlarms().find((alarm) => alarm.ownerSessionId === "sess-b")?.timeZone, "UTC");
});

test("panel: one-shot rows carry the absolute at instant for the edit form", async () => {
  const h = await harness();
  const created = await h.service.action({ action: { kind: "create", sessionId: "sess-a", args: { prompt: "p", at: "2026-08-30T14:00:00+08:00" } } });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.snapshot.alarms[0].at, new Date(Date.parse("2026-08-30T14:00:00+08:00")).toISOString());
  assert.equal(created.snapshot.alarms[0].everySeconds, undefined);
});

test("panel: cron rows carry the expression for the edit form", async () => {
  const h = await harness();
  const created = await h.service.action({ action: { kind: "create", sessionId: "sess-a", args: { prompt: "p", cron: "0 9 * * 1-5", jitter_seconds: 60, time_zone: "Asia/Shanghai" } } });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.snapshot.alarms[0].cron, "0 9 * * 1-5");
  assert.equal(created.snapshot.alarms[0].jitterSeconds, 60);
});

test("panel: edit replaces prompt and trigger while keeping identity and history", async () => {
  const h = await harness();
  const created = await h.service.action(createAction("sess-a", { every_seconds: 3600 }));
  if (!created.ok) return;
  const original = created.snapshot.alarms[0];
  await h.store.appendRun({ id: "r1", alarmId: original.id, sessionId: "sess-a", firedAt: new Date(NOW).toISOString(), decision: "reply", budgetDelta: 1 });

  const edited = await h.service.action({ action: { kind: "edit", id: original.id, args: { prompt: "edited prompt", every_seconds: 1800, jitter_seconds: 60 } } });
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  const row = edited.snapshot.alarms[0];
  assert.equal(row.id, original.id, "edit keeps the alarm identity");
  assert.equal(row.prompt, "edited prompt");
  assert.equal(row.everySeconds, 1800);
  assert.equal(row.jitterSeconds, 60);
  assert.equal(edited.snapshot.runs.length, 1, "run history survives the edit");
  const stored = h.store.getAlarm(original.id);
  assert.equal(stored?.runCount, 0, "runCount untouched");
});

test("panel: edit of an in-flight or completed alarm is rejected", async () => {
  const h = await harness();
  const created = await h.service.action(createAction("sess-a"));
  if (!created.ok) return;
  const id = created.snapshot.alarms[0].id;
  const alarm = h.store.getAlarm(id);
  assert.ok(alarm !== undefined);
  h.store.replaceAlarm({ ...alarm, status: "in-flight" });
  const denied = await h.service.action({ action: { kind: "edit", id, args: { prompt: "x", after_seconds: 60 } } });
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.error.code, "invalid_action");
});

test("panel: edit respects the session ownership guard", async () => {
  const h = await harness();
  const created = await h.service.action(createAction("sess-a"));
  if (!created.ok) return;
  const id = created.snapshot.alarms[0].id;
  const denied = await h.service.action({ action: { kind: "edit", id, args: { prompt: "x", after_seconds: 60 } } }, "sess-b");
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.error.code, "forbidden");
  const allowed = await h.service.action({ action: { kind: "edit", id, args: { prompt: "mine", after_seconds: 120 } } }, "sess-a");
  assert.equal(allowed.ok, true);
  if (!allowed.ok) return;
  assert.equal(allowed.snapshot.alarms[0].prompt, "mine");
});

test("panel: create rolls back and reports persistence_uncertain when persist fails", async () => {
  const h = await harness();
  const originalPersist = h.store.persist.bind(h.store);
  h.store.persist = async () => { throw new Error("disk full"); };
  try {
    const created = await h.service.action(createAction("sess-a"));
    assert.equal(created.ok, false);
    if (created.ok) return;
    assert.equal(created.error.code, "persistence_uncertain");
    assert.equal(h.store.listAlarms().length, 0); // rolled back in memory
    assert.equal(h.drives(), 0); // no re-arm for a rolled-back change
  } finally {
    h.store.persist = originalPersist;
  }
});

test("panel: cancel rolls back and reports persistence_uncertain when persist fails", async () => {
  const h = await harness();
  const created = await h.service.action(createAction("sess-a"));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const id = created.snapshot.alarms[0].id;
  const originalPersist = h.store.persist.bind(h.store);
  h.store.persist = async () => { throw new Error("disk full"); };
  try {
    const cancelled = await h.service.action({ action: { kind: "cancel", id } });
    assert.equal(cancelled.ok, false);
    if (cancelled.ok) return;
    assert.equal(cancelled.error.code, "persistence_uncertain");
    assert.equal(h.store.listAlarms().length, 1); // alarm survives the rollback
  } finally {
    h.store.persist = originalPersist;
  }
});

test("panel: edit rolls back to the exact prior alarm when persist fails", async () => {
  const h = await harness();
  const created = await h.service.action({ action: { kind: "create", sessionId: "sess-a", args: { prompt: "Check in with the user", every_seconds: 3600 } } });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const id = created.snapshot.alarms[0].id;
  const before = h.store.getAlarm(id);
  const originalPersist = h.store.persist.bind(h.store);
  h.store.persist = async () => { throw new Error("disk full"); };
  try {
    const edited = await h.service.action({ action: { kind: "edit", id, args: { prompt: "changed", every_seconds: 7200 } } });
    assert.equal(edited.ok, false);
    if (edited.ok) return;
    assert.equal(edited.error.code, "persistence_uncertain");
    const after = h.store.getAlarm(id);
    assert.deepEqual(after, before); // identity, trigger, and history all preserved
  } finally {
    h.store.persist = originalPersist;
  }
});

test("panel: update_config persists and hot-applies a partial patch", async () => {
  const h = await harness();
  const result = await h.service.action({
    action: { kind: "update_config", patch: { max_deliveries_per_day: 5 } }
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.config.maxDeliveriesPerDay, 5);
  assert.ok(!("heartbeatPrompt" in result.snapshot.config));
  assert.equal(h.config.maxDeliveriesPerDay, 5, "hot apply reached the live config");
});

test("panel: update_config rejects invalid patches without side effects", async () => {
  const h = await harness();
  const bad = await h.service.action({ action: { kind: "update_config", patch: { enabled: "yes" } } });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.error.code, "invalid_trigger");
  assert.equal(h.config.enabled, true, "no hot apply on a rejected patch");
});

test("createArgsFromForm maps the v2 form to the tool dialect (once)", () => {
  const form: PanelCreateForm = { prompt: "p", kind: "once", afterSeconds: 900, timeZone: "Asia/Shanghai" };
  const args = createArgsFromForm(form);
  assert.equal(args["after_seconds"], 900);
  assert.equal(args["prompt"], "p");
  assert.equal(args["time_zone"], "Asia/Shanghai");
  assert.ok(!("every_seconds" in args) && !("cron" in args) && !("at" in args), "once selects exactly one selector");
  assert.ok(!("delivery" in args) && !("wake_reason" in args), "legacy dials never leak into the tool dialect");
});

test("createArgsFromForm maps local date/time for once", () => {
  const form: PanelCreateForm = { prompt: "p", kind: "once", atDate: "2026-09-02", atTime: "14:30", timeZone: "Asia/Shanghai" };
  const args = createArgsFromForm(form);
  assert.deepEqual(args["at"], { date: "2026-09-02", time: "14:30:00", time_zone: "Asia/Shanghai" });
  assert.ok(!("after_seconds" in args));
  // No zone field on the form (the panel never shows one): the at slot is left
  // empty and the host default chain (client zone -> host zone) fills it.
  const formless: PanelCreateForm = { prompt: "p", kind: "once", atDate: "2026-09-02", atTime: "14:30" };
  const wired = createArgsFromForm(formless);
  assert.deepEqual(wired["at"], { date: "2026-09-02", time: "14:30:00", time_zone: "" });
});

test("createArgsFromForm maps every/cron plus jitter, target and respect switch", () => {
  const every = createArgsFromForm({ prompt: "p", kind: "every", everySeconds: 3600, jitterSeconds: 120 } satisfies PanelCreateForm);
  assert.equal(every["every_seconds"], 3600);
  assert.equal(every["jitter_seconds"], 120);
  const cron = createArgsFromForm({ prompt: "p", kind: "cron", cron: "0 9 * * 1-5", jitterSeconds: 60 } satisfies PanelCreateForm);
  assert.equal(cron["cron"], "0 9 * * 1-5");
  assert.equal(cron["jitter_seconds"], 60);
  const target = createArgsFromForm({ prompt: "p", kind: "every", everySeconds: 300, respectQuietHours: true, targetMode: "fork", targetSessionId: "sParent" } satisfies PanelCreateForm);
  assert.equal(target["respect_quiet_hours"], true);
  assert.equal(target["target_mode"], "fork");
  assert.equal(target["target_session_id"], "sParent");
  const fresh = createArgsFromForm({ prompt: "p", kind: "new" as PanelCreateForm["kind"], cron: "0 9 * * *", targetMode: "new" } satisfies PanelCreateForm);
  assert.equal(fresh["target_mode"], "new");
  assert.ok(!("target_session_id" in fresh));
  // once also carries jitter (all three types support it in v2).
  const onceJittered = createArgsFromForm({ prompt: "p", kind: "once", afterSeconds: 900, jitterSeconds: 30 } satisfies PanelCreateForm);
  assert.equal(onceJittered["jitter_seconds"], 30);
});

test("applyHotConfig mutates only the hot subset and reports change", () => {
  const config: ProactiveConfig = { ...DEFAULT_CONFIG, quietHours: { ...DEFAULT_CONFIG.quietHours } };
  const next = hotSubset(config);
  next.maxDeliveriesPerDay = 5;
  next.bootOverduePolicy = "drop";
  const changed = applyHotConfig(config, next);
  assert.equal(changed, true);
  assert.equal(config.maxDeliveriesPerDay, 5);
  assert.equal(config.bootOverduePolicy, "drop");
  assert.equal(config.dataDir, DEFAULT_CONFIG.dataDir);
  const again = applyHotConfig(config, next);
  assert.equal(again, false);
});

test("store: change listeners fire on mutation and dispose works", async () => {
  const h = await harness();
  let fired = 0;
  const dispose = h.store.onChange(() => { fired += 1; });
  await h.service.action(createAction("sess-a"));
  assert.equal(fired, 1);
  dispose();
  await h.service.action({ action: { kind: "cancel", id: h.store.listAlarms()[0].id } });
  assert.equal(fired, 1);
});

test("panel: session-scoped snapshot filters alarms and runs", async () => {
  const h = await harness();
  const a = await h.service.action(createAction("sess-a"));
  const b = await h.service.action(createAction("sess-b"));
  if (!a.ok || !b.ok) return;
  // Snapshot rows come back host-wide; resolve each owner's actual alarm id
  // from the store instead of assuming snapshot order.
  const aId = h.store.listAlarms().find((alarm) => alarm.ownerSessionId === "sess-a")!.id;
  const bId = h.store.listAlarms().find((alarm) => alarm.ownerSessionId === "sess-b")!.id;
  await h.store.appendRun({ id: "r1", alarmId: aId, sessionId: "sess-a", firedAt: new Date(NOW).toISOString(), decision: "reply", budgetDelta: 1 });
  await h.store.appendRun({ id: "r2", alarmId: bId, sessionId: "sess-b", firedAt: new Date(NOW).toISOString(), decision: "no_reply", budgetDelta: 0 });
  // A fork/new child wake: its run session is NOT the owner, but the run still
  // belongs to the owner's history because the alarm is owned by sess-a.
  await h.store.appendRun({ id: "r3", alarmId: aId, sessionId: "session-child-1", firedAt: new Date(NOW).toISOString(), decision: "reply", budgetDelta: 1 });

  const global = await h.service.snapshot();
  assert.equal(global.alarms.length, 2);
  assert.equal(global.runs.length, 3);

  const scoped = await h.service.snapshot("sess-a");
  assert.equal(scoped.alarms.length, 1);
  assert.equal(scoped.alarms[0].sessionId, "sess-a");
  assert.equal(scoped.runs.length, 2);
  assert.deepEqual(scoped.runs.map((run) => run.id).sort(), ["r1", "r3"], "owner runs + fork-child runs both show");
});

test("panel: alarm rows carry the resolved session title", async () => {
  const h = await harness({ "sess-a": "我的会话标题" });
  const created = await h.service.action(createAction("sess-a"));
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.snapshot.alarms[0].sessionTitle, "我的会话标题");
  // Unknown sessions degrade to an empty title (panel renders the raw id).
  const unknown = await h.service.action(createAction("sess-x"));
  assert.equal(unknown.ok, true);
  if (!unknown.ok) return;
  const row = unknown.snapshot.alarms.find((alarm) => alarm.sessionId === "sess-x");
  assert.ok(row !== undefined);
  assert.equal(row.sessionTitle, "");
});

test("panel: ownership guard rejects session-scoped mutations of foreign alarms", async () => {
  const h = await harness();
  const created = await h.service.action(createAction("sess-a"));
  if (!created.ok) return;
  const id = created.snapshot.alarms[0].id;

  const denied = await h.service.action({ action: { kind: "cancel", id } }, "sess-b");
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.error.code, "forbidden");
  assert.equal(h.store.listAlarms().length, 1, "foreign cancel must not remove the alarm");

  const allowed = await h.service.action({ action: { kind: "cancel", id } }, "sess-a");
  assert.equal(allowed.ok, true);
  if (!allowed.ok) return;
  assert.equal(allowed.snapshot.alarms.length, 0);
});

test("panel: toggle/fire ownership guard", async () => {
  const h = await harness();
  const created = await h.service.action(createAction("sess-a", { every_seconds: 600 }));
  if (!created.ok) return;
  const id = created.snapshot.alarms[0].id;

  const denied = await h.service.action({ action: { kind: "toggle", id } }, "sess-b");
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.error.code, "forbidden");

  const fired = await h.service.action({ action: { kind: "fire", id } }, "sess-a");
  assert.equal(fired.ok, true);
  if (!fired.ok) return;
  assert.equal(fired.snapshot.alarms[0].state === "scheduled" || fired.snapshot.alarms[0].state === "overdue", true);
});

test("panel: host-wide cancel still works without a session scope", async () => {
  const h = await harness();
  await h.service.action(createAction("sess-a"));
  await h.service.action(createAction("sess-b"));
  const id = h.store.listAlarms()[0].id;
  const result = await h.service.action({ action: { kind: "cancel", id } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.alarms.length, 1);
  assert.equal(h.store.listAlarms()[0].ownerSessionId, "sess-b");
});

test("panel: scope rule — create under a session scope must name that session", async () => {
  const h = await harness();
  const cross = await h.service.action(createAction("sess-b"), "sess-a");
  assert.equal(cross.ok, false);
  if (cross.ok) return;
  assert.equal(cross.error.code, "scope_mismatch");
  assert.equal(h.store.listAlarms().length, 0);
  const ok = await h.service.action(createAction("sess-a"), "sess-a");
  assert.equal(ok.ok, true);
});

test("panel: host-wide create names an explicit session (settings page picker)", async () => {
  const h = await harness();
  const result = await h.service.action(createAction("sess-picked"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.alarms[0].sessionId, "sess-picked");
  const blank = await h.service.action({ action: { kind: "create", sessionId: "", args: { prompt: "x", after_seconds: 60 } } });
  assert.equal(blank.ok, false);
  if (blank.ok) return;
  assert.equal(blank.error.code, "invalid_trigger");
});

test("panel: snapshot rejects unsafe session ids (path traversal fails closed)", async () => {
  const h = await harness();
  await assert.rejects(() => h.service.snapshot("../../evil"), /invalid session id/);
  await assert.rejects(() => h.service.snapshot(".."), /invalid session id/);
});
test("createArgsFromForm: a stale target id left over from switching to new never leaks", () => {
  const args = createArgsFromForm({ prompt: "p", kind: "every", everySeconds: 3600, targetMode: "new", targetSessionId: "sess-stale" } satisfies PanelCreateForm);
  assert.equal(args["target_mode"], "new");
  assert.ok(!("target_session_id" in args), "target_session_id must be omitted when target_mode is new");
});

test("createArgsFromForm: the target session id is sent trimmed", () => {
  const args = createArgsFromForm({ prompt: "p", kind: "every", everySeconds: 3600, targetMode: "resume", targetSessionId: "  sess-x  " } satisfies PanelCreateForm);
  assert.equal(args["target_session_id"], "sess-x");
  assert.ok(!("target_mode" in args), "resume is the default mode and stays implicit");
});

test("panel snapshot exposes the defaultPrompt prefill in the config view", async () => {
  const h = await harness();
  const snapshot = await h.service.snapshot();
  assert.equal(snapshot.config.defaultPrompt, h.config.defaultPrompt);
});
