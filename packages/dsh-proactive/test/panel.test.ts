/**
 * Panel + settings-wiring unit tests: the host side of the GUI feature.
 * Covers the closed action vocabulary end-to-end over an in-memory store,
 * hot-config application, and the store change hooks powering SSE.
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
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-proactive-panel-"));
  const store = new ProactiveStore(dir);
  const config: ProactiveConfig = { ...DEFAULT_CONFIG, quietHours: { ...DEFAULT_CONFIG.quietHours } };
  const drives: { count: number } = { count: 0 };
  const service = new ProactivePanelService({
    store,
    config,
    scheduler: { requestDrive: () => { drives.count += 1; } },
    dataDir: dir,
    now: () => NOW,
    log: () => undefined
  });
  return { store, service, drives: () => drives.count, config };
}

function createAction(session: string, extra: Record<string, unknown> = {}): unknown {
  return { action: { kind: "create", sessionId: session, args: { prompt: "Check in with the user", after_seconds: 60, delivery: { chat: true, push: true, wechat: false }, ...extra } } };
}

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

test("panel: toggle pauses then resumes a repeat alarm", async () => {
  const h = await harness();
  const created = await h.service.action(createAction("sess-a", { every_seconds: 3600 }));
  if (!created.ok) return;
  const id = created.snapshot.alarms[0].id;
  const paused = await h.service.action({ action: { kind: "toggle", id } });
  assert.equal(paused.ok, true);
  if (!paused.ok) return;
  assert.equal(paused.snapshot.alarms[0].state, "paused");
  const resumed = await h.service.action({ action: { kind: "toggle", id } });
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.snapshot.alarms[0].state, "scheduled");
  assert.ok(resumed.snapshot.alarms[0].nextDueAt > created.snapshot.alarms[0].nextDueAt, "repeat resumes to the next anchor");
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

test("panel snapshot carries configuration summary", async () => {
  const h = await harness();
  const snap = await h.service.snapshot();
  assert.equal(snap.config.enabled, h.config.enabled);
  assert.equal(snap.config.quietHours.start, h.config.quietHours.start);
  assert.equal(snap.config.heartbeatPrompt, h.config.heartbeatPrompt);
  assert.equal(snap.config.heartbeatEverySeconds, h.config.heartbeatEverySeconds);
  assert.equal(snap.server.dataDir, h.store.dataDir);
});

test("createArgsFromForm matches the tool dialect (after_seconds form)", () => {
  const form: PanelCreateForm = { prompt: "p", afterSeconds: 900, timeZone: "Asia/Shanghai", wakeReason: "heartbeat" };
  const args = createArgsFromForm(form);
  assert.equal(args["after_seconds"], 900);
  assert.equal(args["prompt"], "p");
  assert.equal(args["wake_reason"], "heartbeat");
  assert.deepEqual(args["delivery"], { chat: true, push: false, wechat: false });
});

test("applyHotConfig mutates only the hot subset and reports change", () => {
  const config: ProactiveConfig = { ...DEFAULT_CONFIG, quietHours: { ...DEFAULT_CONFIG.quietHours } };
  const next = hotSubset(config);
  next.maxDeliveriesPerDay = 5;
  next.bootOverduePolicy = "drop";
  next.heartbeatEverySeconds = 7200;
  next.heartbeatPrompt = "hb";
  const changed = applyHotConfig(config, next);
  assert.equal(changed, true);
  assert.equal(config.maxDeliveriesPerDay, 5);
  assert.equal(config.bootOverduePolicy, "drop");
  assert.equal(config.heartbeatEverySeconds, 7200);
  assert.equal(config.heartbeatPrompt, "hb");
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