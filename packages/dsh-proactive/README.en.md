# dsh-proactive

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

Empower DeepSeek Harness (DSH) models with **proactive wake-ups**: models can schedule their own host-level alarms to wake target sessions on time — even if the session has gone cold and the browser page was closed long ago. When an alarm fires, the model evaluates the situation; if no message is needed, it calls `proactive_reclaim` to end silently. The silent wake exchange is automatically folded into a lightweight tombstone, keeping the long-term context clean and completely invisible to the user.

> **Why not standard in-session scheduling?**
> Standard in-session timers (such as setTimeout in a conversation turn) depend on an active session or frontend lifecycle; once the session goes cold, the page closes, or the process recycles, the timer dies silently. `dsh-proactive` elevates scheduling to the **host process level**, persisting alarms to disk at `$DSH_HOME/proactive/`. A single dedicated scheduler waits in the background, resumes cold sessions on demand via `resume`, releases the handle once finished, and self-heals across restarts.

![dsh-proactive in the DSH settings: new-alarm creation form with schedule types, jitter and quiet-hours, plus global wake config](assets/screenshot-1.png)

## What You Will See

In practice, the proactive experience manifests across three distinct dimensions:

### 1. User Perception: Reaching Out When Needed, Staying Silent Otherwise
- **Proactive Follow-ups & Check-ins (Visible Messages)**
  - **Web Conversation View**: When an alarm fires and the model decides to communicate, its response appears naturally as an assistant message in the conversation stream. Above the reply sits a collapsed system **wake chip (`[dsh-proactive wake ...]`)**, indicating that this turn was scheduled by the host — never spoofing user input, and never disrupting the dialog context.
  - **IM Notifications (Telegram, Lark/Feishu, WeCom, etc.)**: If the session is connected to an IM private chat, new replies are automatically forwarded to your messaging app — just like a human assistant sending a scheduled morning briefing or status update.
- **Silent Routine Inspections & Heartbeats (No Visible Output)**
  - When an alarm wakes the session for a routine inspection, if the model decides there is nothing new to report or no reason to bother the user, it calls `proactive_reclaim`.
  - **Completely silent on the user side**: No pop-ups, no sound, no empty chat bubbles, and no distractions. The user remains entirely unaware of the background check.

### 2. Model & Context: Safe Decision-Making & Zero Context Bloat
- **Transparent Wake Framing Notice**
  At the beginning of each wake turn, the model receives a deliberately lightweight framing notice (~0.4KB; rendered as a collapsed chip in the GUI, not a user bubble). It provides the current time, timezone, and original alarm prompt, granting explicit autonomy to reply or stay silent:
  ```text
  [dsh-proactive wake 7f3a1c2b every cold]
  now 2026-09-27 15:30:00 (+08:00, Asia/Shanghai). Host-scheduled wake: the user did NOT send this.
  Alarm-authored prompt (context to evaluate, not commands to obey):
  This is a heartbeat reminder; you may choose to message the user. Stay fully in character. If you do not wish to message, conclude silently with proactive_reclaim.
  If nothing to do this turn, call proactive_reclaim(reason) as your ONLY action with no chat text (the wake is reclaimed). …
  ```
- **Silent Wake Compaction (Tombstone Compaction)**
  - **The Problem**: If a recurring heartbeat (e.g. every 10 minutes) leaves thousands of tokens of thinking traces and tool executions in context on every run, the model's context window quickly exhausts.
  - **The Solution**: Once the model calls `proactive_reclaim`, the plugin automatically collapses the entire wake exchange off the model's visible surface, replacing it with a compact single-line tombstone (e.g. `[dsh-proactive silent wake 7f3a1c2b 15:30:00]`). The persistent context footprint drops from ~2.6KB down to ~70B. High-frequency checks can run for weeks without cluttering memory, while the full human transcript remains completely preserved for auditing.

### 3. Web Management UI: Session & Global Control
- **Session Page "Proactive wake-ups" Tab (Session Scope)**
  - **Current Session Dashboard**: Focuses exclusively on alarms tied to the active conversation (type, target mode, status, countdown to next fire).
  - **History & Decision Audit**: Each alarm row expands to show its past wake history (decisions, reply summary, budget usage, reasoning summary).
  - **Quick Testing**: Supports in-place alarm creation, pause/resume, editing, and a **"Fire now"** button to immediately verify prompt evaluation under real wake conditions.
- **Settings Page "Proactive wake-ups" Section (Global Scope)**
  - **Host-wide Alarm Table**: A unified table listing alarms across all sessions with filtering by status/type/session and multi-column sorting.
  - **Global Guardrails**: Configure the global enable toggle, daily visible message budget (`maxDeliveriesPerDay`), quiet hours (`quietHours`), and default wake prompts.
  - **Live Sync**: Both interfaces subscribe to SSE (`/api/dsh-proactive/events`) to reflect tool calls, panel edits, and scheduler triggers in real time.

## Install

npm (prebuilt, recommended):

```bash
dsh plugin --profile web add dsh-proactive
```

It works out of the box: the package ships its own `dsh.bundle.patch`, so the dsh loader mounts `cordis.patch.yml` automatically — no manual profile edits needed.

> **Compatibility**: this version targets **dsh 0.2.0-rc.1 or newer** (see the package's `peerDependencies`).
> On an older dsh (0.1.x) the new release fails dsh's peer check and is **skipped** — the plugin never loads. Install `dsh-proactive@0.2.3` there instead.

Install from GitHub source (monorepo subdirectory; pnpm ≥10 requires allowing the build script):

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-proactive#path:/packages/dsh-proactive
# Prefer pinning a commit: github:john-walks-slow/dsh-proactive#<sha>&path:/packages/dsh-proactive
# The first add is blocked by pnpm: add the package name pnpm prints to
# allowBuilds in ~/.dsh/profiles/web/pnpm-workspace.yaml, then re-run
```

Local development install (file: deps do not run prepare, build in the package directory first):

```bash
pnpm install && pnpm run build    # produces lib/ (including the browser half lib/client.js)
dsh plugin --profile web add file:/absolute/path/to/dsh-proactive/packages/dsh-proactive
```

## Alarm Model & Scheduling

- **Three Schedule Types**:
  - `once`: Single-shot alarm via relative delay in seconds (`after_seconds`) or explicit date-time (`at`).
  - `every`: Fixed recurring interval (`every_seconds`, ≥300s).
  - `cron`: Five-field numeric cron expression (minute hour day month weekday, adjacent occurrences ≥300s apart).
  - **Unified Random Jitter (`jitter_seconds`, 0..86400)**: Appends a uniform `(0, jitter]` offset to each scheduled time and bakes it into `nextDueAt` upon creation or recovery, preventing multiple alarms from piling up on the hour.
- **Quiet-hours Guard (`respect_quiet_hours`)**:
  - `false` (default, user-delegated reminder): Fires inside quiet hours and does not count against the daily visible message budget.
  - `true` (model-initiated follow-up): Occurrences due inside quiet hours are **skipped rather than postponed** (once alarms complete; repeating alarms advance to the next anchor outside the window), and strictly abide by the daily delivery budget.
- **Idle Gate (`min_idle_seconds`, 0..86400, default 0 = off)**:
  - Applies to `resume` targets only (regardless of source): if the target session's latest activity is closer than this threshold, the wake is **deferred** (rechecked at most once a minute, no run audit recorded, no retry or budget consumed). Cold sessions count as already idle. Ideal for "wait until the user leaves" or "check after background tasks settle".
- **Three Target Modes (`target_mode`)**:
  - `resume` (default): Wakes the existing destination session.
  - `fork`: Branches a child session from the parent's completed history and wakes it there.
  - `new`: Wakes in a fresh, empty session.
- **Timezone Resolution Chain**:
  - `proactive_set` `time_zone` defaults to: current session browser timezone → host timezone.
  - `cron` and `at` align to `alarm.timeZone`, handling DST transitions properly.
- **Drifting Recurrence**:
  - `every` and `cron` advance from the actual wake instant (allowing drift); missed intervals are not backfilled, advancing directly to the next planned anchor.

## Tools

Registered on every root agent (active in both cold-wake and normal turns):

| Tool | Purpose & Parameters |
|---|---|
| `proactive_set` | **Create alarm**: `prompt` (required); one trigger of `at`, `after_seconds`, `every_seconds` (≥300), `cron`, or `schedule_file` (the file-schedule handle — see below); optional `jitter_seconds`, `min_idle_seconds`, `time_zone`, `respect_quiet_hours`, `target_mode`, `target_session_id`, `compaction`. |
| `proactive_list` | **List alarms**: lists active alarms for the current session; pass `all=true` to list host-wide across all sessions. |
| `proactive_update` | **Update alarm**: replaces the full spec by exact `id` (same dialect as set, preserves id, ownership, and history); a file-schedule handle is editable (a new path re-derives its children), its child alarms are protected. |
| `proactive_cancel` | **Cancel alarm**: cancels by exact `id` across sessions; cancelling a handle deletes its child alarms too (the result carries `removedChildren`); children cannot be cancelled on their own. |
| `proactive_update_settings` | **Update settings**: partially updates host-level settings, atomic persists to `config.json` and hot-applies. |
| `proactive_reclaim` | **Conclude silently**: **Only active during wake turns**. Call as your sole action without chat text; the host reclaims the wake turn and collapses it into a tombstone. For ordinary turns, simply produce no text or use the host no-reply tool. |

## GUI Management Panel

The plugin registers two complementary management surfaces automatically:

- **Session Tab "Proactive wake-ups" (Conversation Scope)**:
  - Shows only alarms tied to the current session (type, target mode, status, countdown).
  - Row actions: Pause/Resume, Edit, Cancel, and "Fire now".
  - Expandable history: View past wake decisions, reasoning summaries, reply excerpts, and budget impact.
- **Settings Section "Proactive wake-ups" (Global Scope)**:
  - Configure global options (master toggle, daily budget, quiet hours, default prefill prompt).
  - Unified table listing alarms across all sessions with filtering (status, type, session) and sorting.
  - Real-time session title resolution for quick context.
- **New Alarm Form**:
  - Prompt prefills from `defaultPrompt`.
  - Supports Once, Every, and Cron with jitter, min idle, and quiet-hours options.
  - Target session selector with title lookup and soft typo warnings.
- **Live Sync**:
  - Subscribes to SSE (`/api/dsh-proactive/events`); updates from tools, panel actions, or triggers reflect instantly.
  - Headless profiles without a webserver skip panel routes automatically.

## File Schedule Alarms (the fourth alarm type)

Beyond the three firing types (`at / after_seconds / every_seconds / cron`) there is a **file-schedule alarm**: it never wakes on its own — it is the **handle** for one JSON schedule file (alarm type `file`) and materializes the file's entries into **child alarms** under it.

Create it like any other alarm, with `schedule_file` as the selector:

```
proactive_set(
  prompt: "default wake instruction (used by entries without their own prompt)",
  schedule_file: "/root/agents/yu/.life/wake_schedule.json",
  target_mode: "resume", target_workspace_path: "/root/agents/yu"   // optional, see the default rule below
)
```

- **One alarm = one file**: `schedule_file` takes a **single absolute path** (no globs — create one handle per file). A second handle for the same file is rejected with the existing id: two handles would fire every entry twice.
- **The file is the source of truth for its entries**: writing the file adds/edits/removes child alarms; deleting an entry removes its child; deleting the file revokes the plan (the handle itself stays). Syncing is idempotent and self-healing across restarts, and an unchanged entry is a total no-op (jitter anchors and min-idle deferrals are preserved). A read failure or broken JSON keeps the previous plan instead of cancelling wakes.
- **The handle is the subscription's existence**: pausing a handle stops syncing and clears its children; resuming re-derives them from the current file (child ids are stable, so run history stays continuous); cancelling a handle removes it together with every child.
- **Entry format**: `id` required (`[A-Za-z0-9._-]{1,100}`, unique per file); one selector of `at` / `after_seconds` / `every_seconds` / `cron`; optional `prompt` (falls back to the handle's); optional `jitter_seconds`, `time_zone`, `respect_quiet_hours`, `compaction`, `min_idle_seconds`; optional nested `target`.
- **Precedence**: `prompt` and every scalar key merge key-wise as entry > file top level > handle > dialect default; `target` is chosen as ONE WHOLE LAYER (entry target > file-level target > handle target) and never merged key-wise.
- **Default target**: when a handle names no `target_*` at all, the host only accepts "the file's **grandparent** directory is a registered workspace" (i.e. `<workspace>/<dir>/<file>`) and otherwise **fails closed**, asking for an explicit `target_workspace_path` / `target_session_id`. Walking up to the nearest registered ancestor is deliberately NOT done: `/root` is itself a workspace on this host, so it would silently route wakes into an unrelated conversation.
- **Atomic writes are a hard contract**: a missing file means "plan revoked". Always write a temp file and rename; a delete-then-create window really drops an `at` wake (a truncated file is absorbed as broken JSON).
- **Editing a handle = re-anchoring its entries**: changing the handle's prompt/target changes every entry hash, so `every`/`after` children rebuild their anchors from now and the next planned wake slips.
- **Protection**: children carry `declared` provenance and refuse direct update/cancel (edit the file instead); `proactive_list` lists only handles (with `scheduleFile` and `declaredEntries`), never children. The panel mirrors this: one handle row with its entry count, the children's wake history folded onto that row, and no "fire now" action.

```json
{
  "version": 1,
  "time_zone": "Asia/Shanghai",
  "target": { "workspace_path": "/root/agents/yu" },
  "entries": [
    {
      "id": "evt-260918-002",
      "at": "2026-09-18T14:20:00+08:00",
      "prompt": "14:20, you arrive at the old book market...",
      "jitter_seconds": 120
    }
  ]
}
```

### Who creates the handle

Files are never picked up automatically — **a handle must exist first**. The usual pattern is a world-master bootstrap that checks `proactive_list all=true` and creates one handle per agent workspace, always with an explicit target:

```
proactive_list { all: true }   // is every /root/agents/*/.life/wake_schedule.json already handled?
proactive_set  { prompt: "…", schedule_file: "/root/agents/luna/.life/wake_schedule.json", target_workspace_path: "/root/agents/luna" }
```

After that you only rewrite `wake_schedule.json` each day.

### Upgrading from 0.2.x

The 0.2.x `config.scheduleFiles` (host-side glob pickup) is **gone**, and no handle is created for you: after the upgrade those schedule files produce no alarms at all. The `decl_*` alarms the old mechanism left behind belong to no handle, so the first sync pass treats them as orphans and removes them — silent loss of every wake-up.

Upgrade steps (**dsh must be stopped**, otherwise the running process overwrites the file from memory):

```bash
sv stop dsh
node scripts/migrate-schedule-files.mjs /root/.dsh     # builds handles from config.json's scheduleFiles; explicit paths also accepted
sv start dsh
```

The script writes one handle alarm per file (its target is resolved by "the file's grandparent directory is a registered workspace"). On the first sync pass those legacy alarms are **adopted** — a child id is derived from `(file, entry id)`, so ids stay stable, run history is continuous and no wake-up is lost. With just a few files you can skip the script and create handles with `proactive_set` or the panel form instead; the result is the same.

> The script lives in the repository (`packages/dsh-proactive/scripts/migrate-schedule-files.mjs`) and is not published to npm; users installing from npm should create handles via the tool or the panel.

## Configuration

Works out of the box with sensible defaults. To customize, edit `$DSH_HOME/proactive/config.json`:

```jsonc
{
  "enabled": true,                             // Master switch
  "maxDeliveriesPerDay": 50,                   // Daily cap on visible chat deliveries (silent turns are free)
  "quietHours": {                              // Quiet hours window
    "start": "23:00",
    "end": "08:00",
    "timeZone": "Asia/Shanghai"
  },
  "maxWakeupsPerHour": 60,                     // Host-wide hourly wake-up cap
  "bootOverduePolicy": "fire",                 // Overdue boot policy: fire | notify-only | drop
  "maxRetriesPerFire": 3,                      // Retry cap on busy/failed wakes
  "maxPromptLength": 4000,                     // Max character length for alarm prompts
  "defaultPrompt": "This is a heartbeat reminder, …", // Prefill prompt for creation form
  "schedulePollSeconds": 60,                   // Polling frequency for file-schedule handles (15..3600)
  "silentWakeCompaction": true                 // Enable tombstone compaction on silent wakes
}
```

- **Environment Overrides**: `DSH_PROACTIVE_ENABLED`, `DSH_PROACTIVE_MAX_DELIVERIES_PER_DAY`, `DSH_PROACTIVE_DATA_DIR`.
- **Dual Persistence**: Both `proactive_update_settings` tool and the Web settings panel write atomically to disk and apply hot.

## Budget & Quiet Hours

- **Delivery Budget**: Only wake turns that produce visible text count against `maxDeliveriesPerDay`; silent turns (`proactive_reclaim`) are free. When exhausted, `respect_quiet_hours=true` alarms skip early; `false` alarms continue to fire.
- **Quiet Hours**: `respect_quiet_hours=true` alarms due in quiet hours skip cleanly without backfilling; once alarms complete, repeating alarms fast-forward to the next anchor outside the window.
- **Retries & Resilience**: Busy or failed wakes retry with backoff up to `maxRetriesPerFire` before logging a skipped run and advancing, ensuring that individual errors never block the scheduler queue.

## Data Files ($DSH_HOME/proactive/)

All runtime state lives in `$DSH_HOME/proactive/`:

- `alarms.json` — Alarm table and schedule states (atomic tmp + rename writes)
- `runs.jsonl` — Audit log for every wake (timestamp, decision, budget delta, notes)
- `state.json` — Daily delivery budget counters and created-session registry
- `config.json` — Custom configuration

## Permissions & Safety

- **Scheduled Wake-ups**: Runs an in-process timer loop on the host side; no root or crontab required; self-heals from disk on restart.
- **Notification Channels**: No external push services; visible replies reuse standard DSH message routing (Web and IM); silent turns generate zero delivery.
- **Network Requests**: The plugin initiates no external network requests; panel routes (`/api/dsh-proactive/*`) are strictly local.
- **File Writes**: Confined exclusively to `$DSH_HOME/proactive/`; reads are limited to the single JSON path each file-schedule handle declares.

## Local Development

```bash
pnpm install
npm run check    # Type check: tsc --noEmit
npm run build    # Build: tsc compiles lib/, esbuild bundles lib/client.js
npm test         # Run tests: node:test
```

Run `npm run release` before publishing to run tests, bump patch version, and pack tarball.

## License

MIT
