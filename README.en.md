# dsh-proactive

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

Empower DeepSeek Harness (DSH) models with **proactive wake-ups**: models can schedule their own host-level alarms to wake target sessions on time — even if the session has gone cold and the browser page was closed long ago. When an alarm fires, the model evaluates the situation; if no message is needed, it calls `proactive_reclaim` to end silently. The silent wake exchange is automatically folded into a lightweight tombstone, keeping the long-term context clean and completely invisible to the user.

> **Why not standard in-session scheduling?**
> Standard in-session timers (such as setTimeout in a conversation turn) depend on an active session or frontend lifecycle; once the session goes cold, the page closes, or the process recycles, the timer dies silently. `dsh-proactive` elevates scheduling to the **host process level**, persisting alarms to disk at `$DSH_HOME/proactive/`. A single dedicated scheduler waits in the background, resumes cold sessions on demand via `resume`, releases the handle once finished, and self-heals across restarts.

![dsh-proactive in the DSH settings: new-alarm creation form with schedule types, jitter and quiet-hours, plus global wake config](packages/dsh-proactive/assets/screenshot-1.png)

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

Install from GitHub source (monorepo subdirectory; pnpm ≥10 requires allowing the build script):

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-proactive#path:/packages/dsh-proactive
# Prefer pinning a commit: github:john-walks-slow/dsh-proactive#<sha>&path:/packages/dsh-proactive
# The first add is blocked by pnpm: add the package name pnpm prints to
# allowBuilds in ~/.dsh/profiles/web/pnpm-workspace.yaml, then re-run
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
  - Applies to `resume` targets only (regardless of source): if the target session's latest activity is closer than this threshold, the wake is **deferred** (rechecked at most once a minute, no run audit recorded, no retry or budget consumed). Cold sessions count as already idle.
- **Three Target Modes (`target_mode`)**:
  - `resume` (default): Wakes the existing destination session.
  - `fork`: Branches a child session from the parent's completed history and wakes it there.
  - `new`: Wakes in a fresh, empty session.

## Tools

Registered on every root agent (active in both cold-wake and normal turns):

| Tool | Purpose & Parameters |
|---|---|
| `proactive_set` | **Create alarm**: `prompt` (required); one trigger of `at`, `after_seconds`, `every_seconds` (≥300), or `cron`; optional `jitter_seconds`, `min_idle_seconds`, `time_zone`, `respect_quiet_hours`, `target_mode`, `target_session_id`, `compaction`. |
| `proactive_list` | **List alarms**: lists active alarms for the current session; pass `all=true` to list host-wide across all sessions. |
| `proactive_update` | **Update alarm**: replaces the full spec by exact `id` (same dialect as set, preserves id, ownership, and history); declared alarms are protected from direct edits. |
| `proactive_cancel` | **Cancel alarm**: cancels by exact `id` across sessions; declared alarms are protected from direct cancellation. |
| `proactive_update_settings` | **Update settings**: partially updates host-level settings, atomic persists to `config.json` and hot-applies; supports configuring `schedule_files`. |
| `proactive_reclaim` | **Conclude silently**: **Only active during wake turns**. Call as your sole action without chat text; the host reclaims the wake turn and collapses it into a tombstone. |

## Declared Schedule Files

Alarms can also be declared declaratively: configure `config.scheduleFiles` with glob patterns (e.g. `"/srv/agents/*/.life/wake_schedule.json"`). The scheduler polls and syncs them at startup and every `schedulePollSeconds`.

- **File as Single Source of Truth**: Idempotent upsert, auto-healing on restart; deleting entries or files cleans up corresponding alarms; expired `at` entries are skipped cleanly.
- **Typical Use Case**: Living agents or simulated worlds emitting daily agendas can write `.life/wake_schedule.json` in their workspace; if located inside an agent workspace, **no target needs to be specified** (defaults to the containing workspace).

```json
{
  "version": 1,
  "time_zone": "Asia/Shanghai",
  "target": { "workspace_path": "/srv/agents/aoi" },
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
  "scheduleFiles": [],                         // Glob patterns for declared schedule files
  "schedulePollSeconds": 60,                   // Polling frequency in seconds (15..3600)
  "silentWakeCompaction": true                 // Enable tombstone compaction on silent wakes
}
```

## Permissions & Safety

- **Scheduled Wake-ups**: Runs an in-process timer loop on the host side; no root or crontab required; self-heals from disk on restart.
- **Notification Channels**: No external push services; visible replies reuse standard DSH message routing (Web and IM); silent turns generate zero delivery.
- **Network Requests**: The plugin initiates no external network requests; panel routes (`/api/dsh-proactive/*`) are strictly local.
- **File Writes**: Confined exclusively to `$DSH_HOME/proactive/`.

## Repository Layout

- `packages/dsh-proactive/` — plugin source, tests, and build output (`lib/`); the npm package `dsh-proactive`
- `docs/` — feature and issue records

## License

MIT
