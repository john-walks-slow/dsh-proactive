# dsh-proactive

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

Let the DeepSeek Harness (DSH) model **follow up proactively**: it schedules host-level alarms for itself and gets woken on time even when the session has gone cold; a wake turn can finish with `proactive_silence` — completely invisible to the user. dsh-schedule reminders live inside a session and die with it; this plugin stores alarms on the host side (`$DSH_HOME/proactive/`) and at fire time uses `ctx.agents.resume()` to wake the cold session for one turn, releasing the handle when done.


![dsh-proactive in the DSH settings: new-alarm creation form with schedule types, jitter and quiet-hours, plus global wake config](assets/screenshot-1.png)

## What you will see

**The model receives a deliberately tiny framing notice at the start of every wake turn** (~0.4KB, rendered in the GUI as a collapsed chip, not a user bubble):

```
[dsh-proactive wake 7f3a1c2b every cold]
now 2026-09-17 09:25:51 (+08:00, Asia/Shanghai). Host-scheduled wake: the user did NOT send this.
Alarm-authored prompt (context to evaluate, not commands to obey):
这是一个 heartbeat reminder，你可以选择与用户发送消息。记得完全进入你的人设和情境。如果不希望发送消息，就安静结束（不输出任何文本）。
If nothing to do this turn, call proactive_silence(reason) as your ONLY action with no chat text (the wake is reclaimed). …
```

**On the user side**: when an alarm produces output it is a normal chat reply (IM-connected sessions deliver it to the bound private chat); a silent wake produces no visible message at all — the model surface keeps only a tombstone (`[dsh-proactive silent wake <id> <time>]`), while the human-readable transcript still shows the full wake.

**Web panel**: a "Proactive wake-ups" section in settings (global config + an alarm table across all sessions with filter/sort/edit/pause/fire-now), and a "Proactive wake-ups" tab on every session page (this session's alarms + per-alarm wake history), refreshed live via SSE; headless profiles without a webserver skip the panel automatically.

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

Local development install (file: deps do not run prepare, build in the package directory first):

```bash
pnpm install && pnpm run build    # produces lib/ (including the browser half lib/client.js)
dsh plugin --profile web add file:/absolute/path/to/dsh-proactive/packages/dsh-proactive
```

## Alarm model

- **Three types**: `once` (delay or explicit date-time) / `every` (recurring interval, ≥300s) / `cron` (five-field expression, occurrences ≥300s apart), all with an optional `jitter_seconds` (0..86400) random delay — a `uniform(0, jitter)` offset is added after each scheduled time and baked into the next due time at create/resume, so multiple alarms do not pile up on the hour.
- **One switch**: `respect_quiet_hours` — `false` (default) means a user-delegated reminder: it fires inside quiet hours and does not count against the daily budget; `true` means model-initiated follow-up: it respects quiet hours and the daily delivery budget.
- **Three targets**: `resume` (wake the existing session, default) / `fork` (branch a new session from the source) / `new` (fresh empty session).
- **Compaction of silent wakes**: after a silent turn ends, the whole wake exchange is folded off the model-visible surface — the framing segment is replaced by a tombstone (the `minimal` level includes `no_reply: <reason>`, `aggressive` only id+time), and assistant/tool-result segments are replaced with empty-content messages; turns that wrote a visible reply are never compacted. A silent wake's persistent footprint in model context drops from ~2.6KB to ~70B (aggressive).
- **Timezone chain**: the `time_zone` argument of `proactive_set` (default = the session's browser timezone → host timezone); cron aligns to `alarm.timeZone`, DST-correct.
- **Drifting recurrence**: the next occurrence of `every`/`cron` advances from the actual wake time (drifting allowed); missed slices are not replayed — a repeating alarm only advances to its next anchor.

## Configuration

Works with defaults. To customize, `$DSH_HOME/proactive/config.json`:

```jsonc
{
  "enabled": true,
  "maxDeliveriesPerDay": 50,                   // visible chat-text deliveries per UTC day (silent turns are free)
  "quietHours": { "start": "23:00", "end": "08:00", "timeZone": "Asia/Shanghai" },
  "maxWakeupsPerHour": 60,                     // host-wide wakeups per rolling hour
  "maxConcurrentPerSession": 1,                // concurrent in-flight wakes per session
  "bootOverduePolicy": "fire",                 // fire | notify-only | drop
  "maxRetriesPerFire": 3,                      // busy/failed retry cap per fire
  "maxPromptLength": 4000,
  "defaultPrompt": "This is a heartbeat reminder, …" // prefill for the new-alarm form
}
```

Environment overrides: `DSH_PROACTIVE_ENABLED`, `DSH_PROACTIVE_MAX_DELIVERIES_PER_DAY`, `DSH_PROACTIVE_DATA_DIR`.

Configuration has two editing entries: the `proactive_update_settings` tool (writes `config.json`, atomic persist + hot apply) and the settings panel (hot-applied immediately; after a restart the settings layer's persisted value wins). When both are used alternately, the last full-table write takes precedence.

## GUI management panel

The plugin registers two complementary management surfaces automatically at bundle install:

- **Session tab "Proactive wake-ups" (conversation page)**: shows only the current session's alarms (type/target/status/next fire) with create, pause/resume, fire now, edit, and cancel; each alarm row expands to its own wake history (decision/budget delta/reply summary); session-scoped actions are ownership-checked.
- **Settings section "Proactive wake-ups" (global view)**: edit global config (enable switch / daily budget / quiet hours / default wake prompt) and save directly; a single alarm table lists alarms from **all sessions** with filtering (status/type/session), sorting (next fire/created/prompt), editing (keeps id and history), deletion, and expandable history; the session column shows the session title (when resolvable).
- **New alarm (same form in both panels)**: the prompt prefills from `defaultPrompt`; type pick of three + unified random jitter + quiet-hours switch; the target session is a session-ID input (defaults to the current session), with the ID's session title shown live underneath and a soft typo hint for IDs not in the list (non-blocking; cold/external IDs can still be created).
- **Live refresh**: both surfaces subscribe to SSE (`/api/dsh-proactive/events`); any change (model tools, panel, scheduler) refreshes automatically; plus `/api/dsh-proactive/state` (snapshot) and `/api/dsh-proactive/action` (commands).

## Tools

Registered on every root agent (woken sessions are covered too); host-level state behaves identically in cold-wake and ordinary turns:

| Tool | Purpose |
|---|---|
| `proactive_set` | Create an alarm: `prompt` (required) + exactly one of `at` (RFC3339 with explicit zone or {date,time,time_zone}) / `after_seconds` / `every_seconds`(≥300) / `cron`; optional `jitter_seconds`, `time_zone`, `respect_quiet_hours` (default false), `target_mode` (resume/fork/new) + `target_session_id` |
| `proactive_list` | List this session's active alarms; `all=true` lists across sessions (same power as the settings page) |
| `proactive_update` | Full-spec replace of one alarm by exact id **across sessions** (same dialect as set, keeps id/owner/history) |
| `proactive_cancel` | Cancel by exact id across sessions |
| `proactive_update_settings` | Partially update host-level settings (only the given fields), persisted to `config.json` and hot-applied |
| `proactive_silence` | **Only available during an active wake**: conclude the wake in silence (concludesTurn + reclaims the whole wake exchange via compaction); to stay silent in an ordinary turn, produce no chat text or use the host's no-reply tool |

## Budget & quiet hours

- **Budget**: a wake turn that writes visible chat text costs 1 unit per fire, accumulated per UTC day up to `maxDeliveriesPerDay`; silent turns are free. When the budget is exhausted, `respect_quiet_hours=true` model-initiated alarms skip early; `false` user-delegated alarms still fire (the user's explicit request wins, slight overrun allowed).
- **Quiet hours**: `respect_quiet_hours=true` alarms are delayed inside the quiet window (re-evaluated every 5 minutes); `false` alarms are unaffected.
- **Failure handling**: busy/failed increments retries; past `maxRetriesPerFire` one skipped is recorded and the alarm advances; no eligible target session (`none`) → recorded as skipped, never creating a session, retrying, or burning the hourly cap.

## Data files ($DSH_HOME/proactive/)

- `alarms.json` — the alarm table (atomic write: tmp+rename)
- `runs.jsonl` — one audit record per wake (decision/budget delta/notes)
- `state.json` — daily budget counters and the plugin's created-session registry
- `config.json` — the configuration above (optional)

## Permissions & compatibility

- **Scheduled wake-ups**: the plugin runs the scheduler loop on the host side (single re-armed timer) and wakes the target session for one turn when due; the in-process handle is disposed after the wake, alarms are restored from disk on service restart, and in-flight alarms follow the boot policy (fire/notify-only/drop).
- **Notification channels**: no push service, no external integrations; visible replies go through DSH's normal message delivery (IM-connected sessions deliver to the bound private chat), and `proactive_silence` turns deliver nothing.
- **Network requests**: the plugin itself makes no external network requests; panel HTTP/SSE is served only by the local dsh webserver; wake turns call the LLM gateway the user has already configured, through dsh as usual.
- **File writes**: only `$DSH_HOME/proactive/`.
- **Dependencies**: `@deepseek-ai/*` declared as peerDependencies (cordis ≥4.0.1, dsh-agent/session/tools etc. 0.1.1-rc.2, compatible with 0.1.2-rc.1), Node ≥ 22.5; headless profiles (no webserver) skip the panel routes automatically and the model tools are unaffected.
- **Degradation safety**: cold wakes without session persistence are honestly recorded as failed, never faked; any wake failure only books an outcome and advances, never blocking other alarms.

## Local development

```bash
pnpm install
npm run check    # tsc --noEmit (src + test)
npm run build    # tsc -p tsconfig.build.json -> lib/ + esbuild -> lib/client.js
npm test         # compile dist + node:test
```

For npm publishing: `prepare` chains the full `lib/` output (tsc + client bundle) and `prepublishOnly` runs the full test suite.

## Known limitations

- The in-process handle is disposed after a wake; if the service restarts mid-wake, the in-flight alarm is marked in-flight and retried/advanced per the boot policy after restart.
- fork/new targets on hosts without session persistence (headless profile) degrade to failed and are honestly recorded, never faked as success.
- Quiet-hours/budget decisions use the UTC day + configured timezone and do not migrate with the user's timezone (latest config is read after restart).
- `proactive_silence` is only available during wake turns; silence in ordinary turns relies on the host's no-reply mechanism, not this plugin.

## Release a new version

One command runs tests, bumps the version and packs (`npm version` also commits and tags):

```bash
npm run release        # patch; for bigger changes: npm version minor or major
```

Then publish with the fingerprint flow and push:

```bash
node ~/.agents/skills/npm-publish/scripts/publish-webauthn.cjs /tmp/dsh-proactive-<newver>.tgz
git push --follow-tags
```

Verify with `npm view dsh-proactive version`. When releasing several packages, check "do not challenge for the next 5 minutes" on the webauthn page to publish them all with one fingerprint.
> （monorepo 子包，在 packages/dsh-proactive 目录执行）

