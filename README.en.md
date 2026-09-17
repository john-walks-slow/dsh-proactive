# dsh-proactive

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

Let the DeepSeek Harness (DSH) model **follow up proactively**: the model schedules its own host-level alarms, and when one is due the host wakes the target session to run a turn — even if the session went cold long ago and the page was closed. Turns with nothing worth reporting can end silently and get folded away, invisible to the user.


![dsh-proactive in the DSH settings: new-alarm creation form with schedule types, jitter and quiet-hours, plus global wake config](assets/screenshot-1.png)

## What you will see

- **Scheduled reminders**: when an alarm fires, the session wakes and the model produces a normal chat reply per the alarm's instruction, delivered through DSH's regular delivery rules (sessions connected to an IM private chat get it delivered there; web sessions show it inline).
- **Silent heartbeats**: when nothing is worth bothering the user, the model calls `proactive_silence` and ends silently — no visible message is produced, and the whole wake exchange is folded into a small tombstone on the model surface (`[dsh-proactive silent wake <id> <time>]`) so it never pollutes long context.
- **Web management panel**: a "Proactive wake-ups" section appears in settings (global config plus an alarm table across all sessions), and every session page gains a "Proactive wake-ups" tab (this session's alarms and wake history), refreshed live via SSE.

## Alarm model

- **Three types**: `once` / `every` (recurring interval) / `cron` (five-field expression), all with optional `jitter_seconds` random delay.
- **One switch**: `respect_quiet_hours` — `false` (default) means a user-delegated reminder: it fires inside quiet hours and does not count against the daily budget; `true` means model-initiated follow-up: it respects quiet hours and the daily delivery budget.
- **Three targets**: `resume` (existing session, default) / `fork` (branch from the source session) / `new` (fresh empty session).

## Install

npm (prebuilt, recommended):

```bash
dsh plugin --profile web add dsh-proactive
```

Install from GitHub source (monorepo subdirectory; pnpm ≥10 requires allowing the build script):

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-proactive#path:/packages/dsh-proactive
# Prefer pinning a commit: github:john-walks-slow/dsh-proactive#<sha>&path:/packages/dsh-proactive
# The first add is blocked by pnpm: add the package name pnpm prints to
# allowBuilds in ~/.dsh/profiles/web/pnpm-workspace.yaml, then re-run
```

Full configuration, the GUI panel, the tool list, and behavior details live in [packages/dsh-proactive/README.md](packages/dsh-proactive/README.md) (Chinese).

## Permissions & compatibility

- **Scheduled wake-ups**: the plugin runs a scheduler on the host side (single re-armed timer) and wakes the target session for one turn when an alarm is due; alarms are restored from `$DSH_HOME/proactive/` after a service restart.
- **Notification channels**: no push service, no external integrations — visible replies from wake turns go through DSH's normal message delivery; `proactive_silence` turns deliver nothing.
- **Network requests**: the plugin itself makes no external network requests; the panel's HTTP/SSE routes (`/api/dsh-proactive/*`) are served only by the local dsh webserver; wake turns call the LLM gateway the user has already configured, through dsh as usual.
- **File writes**: only `$DSH_HOME/proactive/` (alarms.json / runs.jsonl / state.json / config.json).

## Repository layout

- `packages/dsh-proactive/` — plugin source, tests, and build output (`lib/`); the npm package `dsh-proactive`
- `docs/` — feature and issue records

## License

MIT
