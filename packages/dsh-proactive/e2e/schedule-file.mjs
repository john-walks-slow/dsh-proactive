/**
 * dsh-proactive e2e — schedule-file handles (261009), data plane only.
 *
 * No model turn is involved: this exercises the handle lifecycle through the
 * real host plugin + panel API and asserts the on-disk alarms.json:
 *   create handle → children materialize; edit file → children reconcile;
 *   delete file → children revoked (handle kept); pause → children drop;
 *   resume → re-derived; duplicate handle refused; handle never fires.
 *
 * The handle always names an explicit target_session_id so the run needs no
 * workspace registry (and never walks an ancestor workspace).
 *
 * Env (injected by `dsh-e2e run`): DSH_E2E_PORT / DSH_E2E_TOKEN / DSH_E2E_HOME.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = process.env.DSH_E2E_PORT;
const TOKEN = process.env.DSH_E2E_TOKEN || "e2etest";
const HOME = process.env.DSH_E2E_HOME;
if (!PORT || !HOME) {
  console.log("FAIL  DSH_E2E_PORT / DSH_E2E_HOME unset (run via `dsh-e2e run`)");
  process.exit(1);
}
const BASE = `http://127.0.0.1:${PORT}`;
const STORE = `${HOME}/proactive/alarms.json`;
const OWNER = "e2e-owner";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const auth = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: "manual" });
const COOKIE = (auth.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
if (!COOKIE.includes("dsh-auth")) {
  console.log(`FAIL  no dsh-auth cookie from ${BASE}/?token=${TOKEN}`);
  process.exit(1);
}

async function action(act) {
  const res = await fetch(`${BASE}/api/dsh-proactive/action`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: COOKIE },
    body: JSON.stringify({ action: act })
  });
  const body = await res.json();
  // The route returns the fresh snapshot on success and the closed error
  // object with HTTP 400 on failure (never an {ok, snapshot} envelope).
  if (!res.ok) return { ok: false, error: body };
  return { ok: true, snapshot: body };
}

function store() {
  return JSON.parse(readFileSync(STORE, "utf8"));
}
const childrenOf = (id) => store().alarms.filter((a) => a.declared?.sourceId === id);

/** Wait until `predicate(store)` holds (the poll tick is up to 60s). */
async function waitStore(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = store();
      if (predicate(last)) return true;
    } catch { /* store mid-rename */ }
    await sleep(2000);
  }
  return false;
}

const dir = mkdtempSync(join(tmpdir(), "dsh-proactive-e2e-"));
const scheduleFile = join(dir, ".life", "wake_schedule.json");
mkdirSync(join(dir, ".life"), { recursive: true });
const canonical = join(realpathSync(dir), ".life", "wake_schedule.json");
/** Atomic rewrite, as the README/skill contract requires. */
function writeSchedule(entries) {
  const tmp = scheduleFile + ".tmp";
  writeFileSync(tmp, JSON.stringify({ version: 1, entries }), "utf8");
  renameSync(tmp, scheduleFile);
}
writeSchedule([
  { id: "e2e-every", every_seconds: 3600, prompt: "child every" },
  { id: "e2e-cron", cron: "0 6 * * *", prompt: "child cron" }
]);

try {
  const created = await action({ kind: "create", sessionId: OWNER, args: { prompt: "e2e handle", schedule_file: scheduleFile, target_session_id: OWNER } });
  check("create a schedule-file handle", created.ok === true, created.ok ? "" : JSON.stringify(created.error));
  if (!created.ok) throw new Error("cannot continue without a handle");
  // The e2e home is reused across runs: identify THIS run's handle by its
  // canonical path instead of "the first file alarm" (stale handles from
  // earlier runs point at deleted temp dirs and would poison every check).
  const handle = created.snapshot.alarms.find((a) => a.type === "file" && a.scheduleFile === canonical);
  check("handle row carries type=file, the canonical path and its entry count",
    handle?.scheduleFile === canonical && handle?.declaredEntries === 2,
    `file=${handle?.scheduleFile} entries=${handle?.declaredEntries}`);
  const ownRows = created.snapshot.alarms.filter((a) => a.scheduleFile === canonical).length;
  check("children are not separate alarm rows", ownRows === 1, `rows=${ownRows}`);
  if (handle === undefined) throw new Error("no handle row");
  const kids = childrenOf(handle.id);
  check("children land in alarms.json with sourceId + stable ids",
    kids.length === 2 && kids.every((k) => k.declared.sourceId === handle.id && k.ownerSessionId === OWNER),
    JSON.stringify(kids.map((k) => k.declared.entry)));
  const cron = kids.find((k) => k.declared.entry === "e2e-cron");
  check("entry parameters survive the sync", cron?.type === "cron" && cron?.trigger?.expr === "0 6 * * *", JSON.stringify(cron?.trigger));

  // A second handle for the same file would fire every entry twice.
  const dup = await action({ kind: "create", sessionId: OWNER, args: { prompt: "dup", schedule_file: scheduleFile, target_session_id: OWNER } });
  check("a duplicate handle is refused", dup.ok === false && dup.error.code === "invalid_action", JSON.stringify(dup.error));

  // A handle never fires on its own.
  const fired = await action({ kind: "fire", id: handle.id });
  check("fire is refused for a handle", fired.ok === false && fired.error.code === "invalid_action", JSON.stringify(fired.error));

  // Editing the file reconciles the children (drop + change).
  writeSchedule([{ id: "e2e-cron", cron: "30 7 * * *", prompt: "child cron v2" }]);
  const edited = await waitStore((s) => s.alarms.filter((a) => a.declared?.sourceId === handle.id).length === 1, 90000);
  check("removing an entry removes its child (poll tick)", edited);
  const cron2 = childrenOf(handle.id)[0];
  check("editing an entry replaces its child", cron2?.declared.entry === "e2e-cron" && cron2?.trigger?.expr === "30 7 * * *" && cron2?.prompt === "child cron v2", JSON.stringify(cron2?.trigger));

  // Pausing the handle drops the children immediately (no poll wait).
  const paused = await action({ kind: "toggle", id: handle.id });
  check("pausing a handle drops its children at once", paused.ok === true && childrenOf(handle.id).length === 0, `children=${childrenOf(handle.id).length}`);
  const stillThere = store().alarms.some((a) => a.id === handle.id);
  check("the paused handle itself survives", stillThere);
  const resumed = await action({ kind: "toggle", id: handle.id });
  check("resuming re-derives the children from the current file",
    resumed.ok === true && childrenOf(handle.id).length === 1 && childrenOf(handle.id)[0]?.trigger?.expr === "30 7 * * *");

  // Deleting the file revokes the plan but keeps the subscription.
  rmSync(scheduleFile);
  const revoked = await waitStore((s) => s.alarms.filter((a) => a.declared?.sourceId === handle.id).length === 0, 90000);
  check("deleting the file revokes its children (poll tick)", revoked);
  check("the handle survives an emptied plan", store().alarms.some((a) => a.id === handle.id));

  const snap = await action({ kind: "create", sessionId: OWNER, args: { prompt: "e2e second handle", schedule_file: join(dir, "other", "w.json"), target_session_id: OWNER } });
  check("a handle for a file that does not exist yet is accepted", snap.ok === true, snap.ok ? "" : JSON.stringify(snap.error));
  check("the snapshot exposes the last sync summary", typeof snap.snapshot?.server?.sync?.lastAt === "string", JSON.stringify(snap.snapshot?.server?.sync));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
