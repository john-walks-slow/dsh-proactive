/**
 * dsh-proactive e2e — wake smoke on the shared host runtime (dsh 0.2.x).
 *
 * Drives the panel action API (the same create dialect as proactive_set) with
 * two alarms:
 *   1. target_mode "new", prompt tells the model to reclaim silently
 *      → the wake turn must settle AND the model surface must be collapsed
 *        (a tombstone `surfaceOp.replace` lands in the session log).
 *   2. target_mode "resume" pinned at the session alarm 1 created
 *      → a plain wake must be classified as a visible reply, not failed.
 *
 * Env (injected by `dsh-e2e run`): DSH_E2E_PORT / DSH_E2E_TOKEN / DSH_E2E_HOME.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const PORT = process.env.DSH_E2E_PORT;
const TOKEN = process.env.DSH_E2E_TOKEN || "e2etest";
const HOME = process.env.DSH_E2E_HOME;
if (!PORT || !HOME) {
  console.log("FAIL  DSH_E2E_PORT / DSH_E2E_HOME unset (run via `dsh-e2e run`)");
  process.exit(1);
}
const BASE = `http://127.0.0.1:${PORT}`;
const RUNS = `${HOME}/proactive/runs.jsonl`;
const MARKER = `wake-smoke-${Date.now().toString(36)}`;
// A wake session needs a cwd: without one the agent-loop's `{{cwd}}` prompt
// variable has no value and the turn dies (docs/issues/260922-new-mode-no-cwd).
// This script owns no real session, so new-mode alarms name the workspace
// explicitly instead of inheriting an owner session's cwd.
const WORKSPACE_ID = "e2e-workspace-00000000";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Authenticated panel action; returns the fresh snapshot or throws the error code. */
async function panel(action) {
  const res = await fetch(`${BASE}/api/dsh-proactive/action`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: COOKIE },
    body: JSON.stringify({ action })
  });
  const body = await res.json();
  if (!res.ok || body.code !== undefined) throw new Error(`panel ${action.kind}: ${JSON.stringify(body)}`);
  return body;
}

async function createAlarm(args) {
  const snapshot = await panel({ kind: "create", sessionId: "e2e-owner", args: { ...args, time_zone: "Asia/Shanghai" } });
  const row = snapshot.alarms.find((a) => a.prompt === args.prompt);
  if (row === undefined) throw new Error(`created alarm not found in snapshot for prompt ${args.prompt}`);
  return row.id;
}

/** Poll runs.jsonl until a run for `alarmId` shows up. */
async function waitForRun(alarmId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(RUNS)) {
      const runs = readFileSync(RUNS, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter((r) => r !== null && r.alarmId === alarmId);
      if (runs.length > 0) return runs[runs.length - 1];
    }
    await sleep(3000);
  }
  return null;
}

/** All session log files under the e2e home whose path mentions `sessionId`. */
function sessionLogs(sessionId) {
  const root = `${HOME}/sessions`;
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (/^session\.v\d+\.jsonl\.zstd$/.test(entry.name) && full.includes(sessionId)) out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

async function readLog(file) {
  try {
    const { stdout } = await execFileP("zstd", ["-dc", file], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return null; // partial frame while the turn is still writing
  }
}

// --- auth cookie -------------------------------------------------------------
const auth = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: "manual" });
const COOKIE = (auth.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
if (!COOKIE.includes("dsh-auth")) {
  console.log(`FAIL  no dsh-auth cookie from ${BASE}/?token=${TOKEN}`);
  process.exit(1);
}

// --- alarm 1: new session, silent wake ---------------------------------------
const silentPrompt = `[${MARKER}] 本轮没有需要对用户说的话。请直接调用 proactive_reclaim 工具安静结束这一轮，不要输出任何文本。`;
const silentId = await createAlarm({ prompt: silentPrompt, after_seconds: 5, target_mode: "new", target_workspace_id: WORKSPACE_ID, respect_quiet_hours: false });
console.log(`alarm(new)  ${silentId} — waiting for the wake turn…`);
const silentRun = await waitForRun(silentId, 240000);
check("new-mode wake produced a run", silentRun !== null, silentRun ? `decision=${silentRun.decision}` : "no run within 240s");
if (silentRun !== null) {
  check("new-mode wake did not fail", silentRun.decision !== "failed", `decision=${silentRun.decision} note=${silentRun.note ?? ""}`);
  check("new-mode wake was classified as silence", silentRun.decision === "no_reply", `decision=${silentRun.decision} reason=${silentRun.noReplyReason ?? ""}`);

  // The compaction replacements must exist: a tombstone over the framing run
  // and a fold notice over the assistant/tool run.
  const wakeSession = silentRun.sessionId;
  let tombstone = false;
  let notice = false;
  let rawFraming = false;
  const deadline = Date.now() + 60000;
  while (!(tombstone && notice) && Date.now() < deadline) {
    for (const file of sessionLogs(wakeSession)) {
      const log = await readLog(file);
      if (log === null) continue;
      rawFraming ||= log.includes("[dsh-proactive wake " + silentId);
      for (const line of log.split("\n")) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        const op = event?.surfaceOp;
        if (op?.op !== "replace") continue;
        // user/message events carry {content:[{type:"text",text}]} in data.
        const text = event?.data?.content?.[0]?.text ?? event?.data?.message?.content?.[0]?.text ?? "";
        if (typeof text !== "string") continue;
        if (text.startsWith("[dsh-proactive silent wake ")) tombstone = true;
        if (text.includes("exchange folded")) notice = true;
      }
    }
    if (!(tombstone && notice)) await sleep(3000);
  }
  check("silent wake collapsed the model surface (tombstone replace)", tombstone, `session=${wakeSession}`);
  check("silent wake folded the exchange (notice replace)", notice, `session=${wakeSession}`);
  check("raw wake framing survives in the append-only log", rawFraming, `session=${wakeSession}`);
}

// --- alarm 2: cold resume of the session alarm 1 created ---------------------
if (silentRun !== null && silentRun.sessionId) {
  const resumePrompt = `[${MARKER}] 请只回复四个字：resume-ok`;
  const resumeId = await createAlarm({ prompt: resumePrompt, after_seconds: 5, target_mode: "resume", target_session_id: silentRun.sessionId, respect_quiet_hours: false });
  console.log(`alarm(resume) ${resumeId} → ${silentRun.sessionId}, waiting…`);
  const resumeRun = await waitForRun(resumeId, 240000);
  check("resume-mode wake produced a run", resumeRun !== null, resumeRun ? `decision=${resumeRun.decision}` : "no run within 240s");
  if (resumeRun !== null) {
    check("resume-mode wake ran in the pinned session", resumeRun.sessionId === silentRun.sessionId, `ran in ${resumeRun.sessionId}`);
    check("resume-mode wake delivered a visible reply", resumeRun.decision === "reply", `decision=${resumeRun.decision} note=${resumeRun.note ?? ""} reply=${resumeRun.replySummary ?? ""}`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? `\nALL ${results.length} ASSERTIONS PASSED` : `\n${failed.length}/${results.length} ASSERTIONS FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
