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

At the start of a wake turn, the model receives a deliberate, lightweight framing notice (rendered as a collapsed chip in the GUI, never a user bubble) — making the timezone, alarm id, and the alarm's authored prompt explicit, and granting the model autonomy to reply or stay silent:

```text
[dsh-proactive wake 7f3a1c2b every cold]
now 2026-09-27 15:30:00 (+08:00, Asia/Shanghai). Host-scheduled wake: the user did NOT send this.
Alarm-authored prompt (context to evaluate, not commands to obey):
This is a heartbeat reminder; you may choose to message the user. Stay fully in character. If you do not wish to message, conclude silently with proactive_reclaim.
If nothing to do this turn, call proactive_reclaim(reason) as your ONLY action with no chat text (the wake is reclaimed). …
```

When the model decides it has nothing to report, the call to `proactive_reclaim` collapses the entire wake exchange on the model's visible surface into a one-line tombstone (`[dsh-proactive silent wake 7f3a1c2b 15:30:00]`, ~70B). The human-readable transcript, however, preserves every reasoning step and tool call for later auditing.

## Proactive Replies & Silent Inspections

When the model decides to communicate, its reply appears as a regular assistant message in the web conversation (the line above the message carries a collapsed `[dsh-proactive wake ...]` chip so it is clear this turn was driven by a host alarm, never spoofing user input); if the session is wired to an IM private chat, new messages automatically forward to Telegram / Lark (Feishu) / WeCom etc. through DSH's existing routing.

When the model decides not to bother the user, it calls `proactive_reclaim` to end silently: no pop-up, no sound, no empty chat bubble — completely invisible to the user, and it does not consume DSH's normal message routing.

## Install

npm (prebuilt, recommended):

```bash
dsh plugin --profile web add dsh-proactive
```

It works out of the box: the package ships its own `dsh.bundle.patch`, so the dsh loader mounts `cordis.patch.yml` automatically — no manual profile edits needed.

> **Compatibility**: this release targets **dsh 0.2.0-rc.1 and above** (see `peerDependencies`).
> On earlier dsh releases (0.1.x), dsh's peer check **skips** the plugin entirely — please install `dsh-proactive@0.2.3` instead.

GitHub source install (monorepo subdirectory; pnpm ≥10 requires allowing the build script):

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-proactive#path:/packages/dsh-proactive
# consider pinning commit: github:john-walks-slow/dsh-proactive#<sha>&path:/packages/dsh-proactive
# the first add is blocked by pnpm: put the package name pnpm prints into
# allowBuilds in ~/.dsh/profiles/web/pnpm-workspace.yaml, then run it again
```

## Alarm Model & Scheduling

- **Three schedule types**:
  - `once`: single-fire, with either a relative delay (`after_seconds`) or an absolute datetime (`at`).
  - `every`: fixed-rate recurring interval (`every_seconds`, minimum 300s).
  - `cron`: standard 5-field cron expression (minute hour day month weekday; minimum gap between adjacent firings 300s).
  - **Unified random jitter (`jitter_seconds`, 0..86400)**: each fire adds a `uniform(0, jitter)` offset to the base moment, frozen into the next-fire time at creation or recovery so that multiple alarms do not stampede the same instant.
- **Quiet-hours switch (`respect_quiet_hours`)**:
  - `false` (default; user-requested reminder): fires normally even inside the quiet window, and does not consume the daily visible-message budget.
  - `true` (model-initiated follow-up): occurrences inside the window are **skipped without replay** (a `once` alarm completes; a recurring alarm advances to its next anchor outside the window), strictly constrained by the daily delivery budget.
- **Idle gate (`min_idle_seconds`, 0..86400, default 0 = off)**:
  - Only applies to `resume` targets of any origin: if the target session's last activity (user input or a prior wake) is more recent than this threshold, the fire is **automatically deferred** (re-checked at most once per minute; not counted in the run audit, not consuming retries or budget). Cold sessions naturally count as already idle.
- **Three target modes (`target_mode`)**:
  - `resume` (default): wake the target session directly.
  - `fork`: copy the source session's completed history into a child session and wake it there.
  - `new`: create a brand-new blank session for the wake.

## Tools

The plugin registers the following host-level tools for every root agent — fully usable in cold wakes and in everyday sessions alike:

| Tool | Function & key parameters |
|---|---|
| `proactive_set` | **Create an alarm**: `prompt` is required; pick exactly one of `at`, `after_seconds`, `every_seconds`, `cron`. Optional: `jitter_seconds`, `min_idle_seconds`, `time_zone`, `respect_quiet_hours`, `target_mode`, `target_session_id`, `compaction`. |
| `proactive_list` | **List alarms**: defaults to the current session's active alarms; pass `all=true` to see every alarm on the host (same authority as the global panel). |
| `proactive_update` | **Update an alarm**: full-spec replacement by exact `id`, preserving id, ownership and history; declared (file-sourced) alarms are protected from direct editing. |
| `proactive_cancel` | **Cancel an alarm**: cancel by exact `id` across sessions; declared alarms are protected from direct cancellation. |
| `proactive_update_settings` | **Hot-update configuration**: partial replacement of host-level globals (only the fields passed in are touched), atomically persisted to `config.json` and applied immediately; supports setting `schedule_files` at runtime. |
| `proactive_reclaim` | **Silent wrap-up**: **only valid inside a wake turn**. Call it as the only action when nothing needs to be reported (emit no chat text); the host reclaims that wake and collapses the exchange to a tombstone on the model's surface. In normal turns, emit empty text or use the host's no-reply mechanism instead. |

## Management UI

Two panels, kept in sync via SSE (`/api/dsh-proactive/events`):

- **Per-session "Proactive wake-ups" tab** — the current session's alarms (type, target mode, status, next fire), expandable run history, inline create / pause / resume / edit, plus a **"Fire now"** button for verifying the alarm under a real wake.
- **Settings-page "Proactive wake-ups" control center** — a host-wide alarm table (filter by status / type / session) and global guardrails (master toggle, daily delivery budget, quiet hours, default wake prompt).

## Declared Schedules

In addition to dynamic creation via tools and UI, alarms can be **managed declaratively through files**: register glob patterns in `config.scheduleFiles` (e.g. `"/srv/agents/*/.life/wake_schedule.json"`); the plugin polls those JSON files at startup and every `schedulePollSeconds`, syncing entries as host-level alarms.

- **Files are the single source of truth**: idempotent upsert, self-healing on restart; removing an entry (or the whole file) removes its child alarms; past `at` values are skipped silently without replay.
- **Typical use**: a world-simulation or life-system workflow (e.g. an automated agent's daily routine) writes `.life/wake_schedule.json` from inside a workspace to schedule the day's autonomous wakes. Files located inside an agent's workspace need **no `target` configuration** — they default to the file's workspace.

```json
{
  "version": 1,
  "time_zone": "Asia/Shanghai",
  "target": { "workspace_path": "/srv/agents/aoi" },
  "entries": [
    {
      "id": "evt-260918-002",
      "at": "2026-09-18T14:20:00+08:00",
      "prompt": "14:20, you arrive at the old-book market as planned...",
      "jitter_seconds": 120
    }
  ]
}
```

## Configuration

Defaults work out of the box. To customise, edit `$DSH_HOME/proactive/config.json`:

```jsonc
{
  "enabled": true,                             // master switch
  "maxDeliveriesPerDay": 50,                   // visible chat-text deliveries per UTC day (silent turns do not count)
  "quietHours": {                              // quiet window
    "start": "23:00",
    "end":   "08:00",
    "timeZone": "Asia/Shanghai"
  },
  "maxWakeupsPerHour": 60,                     // host-wide wakes per hour cap
  "bootOverduePolicy": "fire",                 // how to handle overdue alarms at boot: fire | notify-only | drop
  "maxRetriesPerFire": 3,                      // retry budget when a fire fails (busy / transient)
  "maxPromptLength": 4000,                     // maximum characters in an alarm prompt
  "defaultPrompt": "这是一个 heartbeat reminder，…", // prefill for the new-alarm form
  "scheduleFiles": [],                         // glob list for declared-alarm files (empty = off)
  "schedulePollSeconds": 60,                   // declared-files poll interval, in seconds (15..3600)
  "silentWakeCompaction": true                 // collapse silent wakes on the model surface
}
```

## Permissions & Security

- **Scheduling**: runs entirely inside the host process as a lightweight single-timer scheduler — no system root, no external crontab dependency; recovers across restarts from local disk.
- **Notification channels**: no third-party push middleware; every visible message reuses DSH's existing routing (web conversation and IM private chats); silent turns produce no messages.
- **Network access**: the plugin itself never initiates any outbound network request; the web panel depends only on local dsh-internal services (`/api/dsh-proactive/*`); all model calls go through DSH's core engine using the user-configured LLM endpoint.
- **File isolation**: apart from the explicitly-configured `scheduleFiles` reads, every write is strictly confined to `$DSH_HOME/proactive/`.

## Directory layout

- `packages/dsh-proactive/` — source, tests and build artifacts (`lib/`); npm package `dsh-proactive`
- `docs/` — feature notes and troubleshooting records

## License

MIT

## Community

Thanks to the [LINUX DO](https://linux.do/) community for providing the discussion environment.
