# dsh-proactive 唤醒全失效 — 排障背景简报

> 供子代理使用。写于 2026-10-02 00:15 (Asia/Shanghai)。
> 本文件是**已核实的事实**，不需要重新采集；你的任务是补上「根因」与「修复」。

## 0. 环境

| 项 | 值 |
|---|---|
| 插件源码 | `/root/projects/dsh-proactive/packages/dsh-proactive/`（TS，`src/*.ts`，构建产物 `lib/`） |
| 线上 profile | `/root/.dsh/profiles/web/package.json`，`dsh` bundle 里含 `dsh-proactive`（**线上直接跑工作区的构建产物**） |
| DSH_HOME | `/root/.dsh` |
| 插件数据 | `/root/.dsh/proactive/{config.json,alarms.json,runs.jsonl,state.json}` |
| DSH 实例 | supervisor 托管，`dsh web --host 127.0.0.1 --port 4180 --token <dsh-token>`，**绝对不要 `supervisorctl restart dsh`**（会杀掉你所在的进程） |
| 工作区注册表 | `/root/.dsh/storages/workspace.json`（结构 `{tables:{workspaces:{<id>:{path,sessionIds,...}}}}`） |
| 会话落盘 | `/root/.dsh/sessions/--<path-escaped>--/` |
| 插件面板 HTTP | `GET /api/dsh-proactive/state`；鉴权 cookie 取法见 §5 |
| 已知 DSH 版本迁移 | 0.1.7（git log 有 `fix(proactive): restore load on dsh 0.1.7 core`） |

## 1. 用户报告

> 「确认一下本机现在 dsh-proactive 的情况，最近好像都没正常运行」

## 2. 已核实的事实（run 历史统计）

`/root/.dsh/proactive/runs.jsonl` 共 446 条，decision 分布：
`reply 87 / failed 174 / skipped 134 / no_reply 50 / push 1`。

**从 2026-09-28 起（声明式 wake_schedule 上线后），5 个 `decl_*` 闹钟的成功率是 0/100**：

| 闹钟 | target_mode / source | workspace | decision 统计 |
|---|---|---|---|
| `decl_b20c51533aa84e8f` luna-heartbeat | resume / workspace | luna | skipped ×12 |
| `decl_830c74233f1a629b` luna-midnight-free | **new** | luna | **failed ×9** |
| `decl_6c72518581c73211` rev-heartbeat | resume / workspace | rev | skipped ×21 |
| `decl_ad5ec12245b88ffd` yu-heartbeat | resume / workspace | yu | skipped ×21 |
| `decl_526aea698ea032b7` yu-diary-10pm | **fork** / workspace | yu | **failed ×9** |

### 缺陷 1：resume/workspace 心跳 100% skipped

`runs.jsonl` 的 note 原文（每个 workspace 反复出现）：

```
workspace <workspaceId> has no eligible session to wake (only archived, subagent-owned,
or this plugin's own created sessions); use target_mode new to wake a fresh session
```

对应 `src/wake.ts:622-625`（resume/workspace 分支的 `outcome:"skipped"`）。

### 缺陷 2：new / fork 唤醒 100% failed

`runs.jsonl` 的 note 原文：

```
wake failed (attempt 1) / (attempt 2) / (attempt 3)
```

**注意：note 里没有任何真实错误原因**。真实错误只经 `deps.log("warn", "wake failed for alarm …")` 打到 cordis logger，
而 cordis 的 info/warn **不落盘 `/var/log/dsh.log`**（这是本机已沉淀的教训）。所以缺陷 2 的根因**目前是未知的**，
必须由你去取真实错误 —— 这是本次排查最关键的一步。

### 缺陷 3：world-master 的 declared schedule 完全没注册

`/root/agents/world-master/.life/wake_schedule.json` 有 1 条 entry `world-evolution-5am`
（cron `0 5 * * *`，target `{mode:"new", workspace_path:"/root/agents/world-master"}`），
但 `/root/.dsh/proactive/alarms.json` 里**没有任何来自该文件的闹钟**。

已核实：`/root/.dsh/storages/workspace.json` 里 **`/root/agents/world-master` 根本没有注册为 workspace**。
而 luna / rev / yu 都注册了。所以疑似「declared 同步要求 workspace 必须已注册，否则静默丢弃」。

## 3. 关键代码位置

| 关注点 | 文件:行 |
|---|---|
| resume/workspace 分支返回 skipped | `src/wake.ts:588-626` |
| fork 分支 | `src/wake.ts:673-729` |
| `resolveWorkspaceWakeTarget` | `src/workspace.ts:322-387` |
| 候选筛选（archived / subagent / plugin-created / live-vs-cold） | `src/workspace.ts:341-377` |
| 目标排序 `pickWorkspaceTarget` | `src/workspace.ts:266-274` |
| plugin-created 会话资格 `createdSessionEligible` | `src/workspace.ts:288-290` |
| host 依赖装配（`coldHeaders` / `projectionCache` / `createdSessionKind` / `archivedSessionIds`） | `src/index.ts:109-154` |
| inject 声明 | `src/index.ts:32` → `["agents","tools","sessionPersistence","workspaceRegistry"]` |

`resolveWorkspaceWakeTarget` 的关键剪枝（`workspace.ts:359-360`）：

```ts
const header = coldById.get(sessionId);
if (header === undefined) continue; // neither live nor materialized: not a real destination
```

即：**既不在 live store、也不在 `ctx.sessionPersistence.list()` 返回结果里的 sessionId，直接被丢弃**。
若 `deps.coldHeaders` 为 `undefined`（`index.ts:141` `persistenceService === undefined ? undefined : ...`），
则所有冷会话都会被静默丢弃 → 候选为空 → 返回 `{kind:"none"}` → 缺陷 1 的 skip。
（注意 `coldListFailed` 只在 `list()` **抛异常**时置位；`list()` 返回空/少数据不会置位。）

## 4. 现场数据（已核实）

三个 workspace 在注册表里**都有大量 sessionIds**（luna 28 / rev 12 / yu 14），且不是 archived
（`archivedSessionIds` 字段为 None/空）。所以「工作区根本没有会话」这条假设**不成立**。

`/root/.dsh/sessions/--root-agents-yu--/` 下同时存在**三种目录形态**：

- `session-<uuid>/session.jsonl.zstd`（旧，如 session-032ac2fe…，header 里 `"origin": null`）
- `<uuid>/`（无 `session-` 前缀，Sep 23 17:20 批量出现）
- `session-<uuid>/session.v3.jsonl.zstd`（新，Sep 28 17:24）

`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 下存在
`dsh-session-format` / `-v0-to-v1` / `-v1-to-v2` / `-v2-to-v3` / `-v3-to-v4` 一整套格式迁移包，
说明 DSH 0.1.7 前后会话落盘格式有多次演进。**`ctx.sessionPersistence.list()` 能否覆盖上述全部形态，是缺陷 1 的头号嫌疑。**

## 5. 可用的线上探针（只读，安全）

```bash
# 换鉴权 cookie（注意 cookie 名带 #HttpOnly_ 前缀，awk 取 $6/$7）
curl -s -c /tmp/ck.txt 'http://127.0.0.1:4180/?token=<dsh-token>' -o /dev/null
CK=$(grep 'dsh-auth' /tmp/ck.txt | awk '{print $6"="$7}')

# 插件面板快照（含 config / alarms / 最近 200 条 runs）
curl -s "http://127.0.0.1:4180/api/dsh-proactive/state" -H "Cookie: $CK"

# session/list：args 必须用 _request 这个键（不是 request，否则报 arguments-invalid）
curl -s -X POST "http://127.0.0.1:4180/api/session/list" -H "Cookie: $CK" \
  -H 'Content-Type: application/json' \
  -d '{"type":"client-request","rpcId":"p1","method":"session/list",
       "payload":{"args":{"_request":{"workspaceId":"e047a43b-98bf-4da5-93e6-ae7fa514eb61"}}}}'
```

⚠️ `session/list` 在本机实测**会挂住超过 60s**（未返回）。若你也遇到，不要反复重试，
改走源码分析或隔离 e2e 实例。

## 6. 隔离验证环境（绝对不要碰线上）

按 `~/.dsh/skills/dsh-e2e` 技能，在插件 worktree 里起最小实例：
`DSH_HOME=<worktree>/.dsh-e2e-home`，端口用 `acquire-port` 动态分配，token `e2etest`。
隔离实例随便折腾，不需要用户同意。技能入口：`npx dsh-e2e start --wait-ready`（若已装）。

## 7. 红线

- **禁止** `supervisorctl restart dsh`、禁止改 `/root/.dsh/settings.yaml*`、禁止 `git stash/checkout/restore/reset --hard`。
- 线上 dsh 直接跑 `/root/projects/dsh-proactive/packages/dsh-proactive/lib/` 的构建产物；
  改 `src/` 不重建**不会**影响线上，但重建后**会**立刻影响线上 —— 所以改代码阶段请先在隔离实例验证。
- 仓库是 git 管理的，`git status` 当前干净。最近提交：`80bf0d9 fix(proactive): restore load on dsh 0.1.7 core`。
