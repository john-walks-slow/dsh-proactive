# workspace/preset 闹钟捕获 proactive 自建会话 — 排查指南

## 症状

一个 `target_mode: new`（或 `fork`）的 proactive 闹钟触发后新建了会话；紧接的 `target_mode: workspace` / `target_source: workspace|preset`（resume）闹钟**唤醒到了这个产物会话**里，而不是用户的会话。从用户视角看：心跳/跟进闹钟"跑偏"到了一个没人聊天的空会话，模型在那里自言自语。

## 根因

`resolveWorkspaceWakeTarget` / `resolvePresetWakeTarget` 的目的地排序键是侧边栏 `updatedAt = max(createdAt, lastPromptAt)`。proactive 自建会话的 `createdAt` = 唤醒时刻，天然是工作区/该 preset 里最新的，于是登顶排序，下一个 workspace/preset 闹钟就选中它——**插件捕获了自己的回声**。

语义法降级失败的路径：
- **fork 子会话**：live 折叠继承父会话的真人 `user/message`，`lastPromptAt` 非 null 但**不是子会话自己的活动**；cold 投影里 seeded header 无缓存行（host projectionsFor 语义），`lastPromptAt` unknown。两条路径都无法用"有没有真人 prompt"判别。
- 只有**记账法**（记录插件自己 create 的 session id）能可靠剔除。

收敛悖论：若"剔除产物"的同时保留 create arm，每次 fire 新建→新会话又登顶→下一个 wake 又进产物（自我捕获循环）。解法是**无候选就 skip**（不再 create）。

## 验证修复生效

1. 查记账：`$DSH_HOME/proactive/state.json` 的 `createdSessions` 数组应含 `{sessionId, kind:"new"|"fork", createdAt}`（new/fork 闹钟 fire 后写入）。
2. 查剔除：`runs.jsonl` 里 workspace/preset 闹钟的 `sessionId` 应是**用户会话**，不是 `state.json.createdSessions` 里的 id。
3. 查 skip：工作区/preset 无合格会话时，`runs.jsonl` 该次 `decision:"skipped"`、`note` 含 "no eligible session" / "no session is running preset"，`budgetDelta:0`；once 闹钟 → `completed`，every/cron → 推进到下一锚点。

## 回归检查项

- **真人豁免**：用户在 `target_mode: new` 产物会话里发过消息（`lastPromptAt != null`）后，该会话重新成为合格目的地——产物跟着用户走。fork **永不豁免**（继承历史不是本人活动）。
- **cold 缓存行三态**：缓存行 `lastPromptAt` 有值 → 豁免；`null` → 剔除；**无缓存行**（unknown）→ 保守剔除（不豁免）。
- **skip 不烧预算/hourly cap**：skip 是 `WakeOutcome:"skipped"`，scheduler 不 push `recentFires`、不 `spendBudget`、不重试。
- **attach 失败仍记账**：new+workspace 路径在 `agents.create` 返回后、`attach` 之前记账；attach 失败留下的孤儿会话也不会被后续捕获。
- **missing-dir**：原 create arm 的 missing-dir 检查保留在 `cwdOf`（服务 new+workspace 路径），workspace resolver 本身不再检查目录。

## E2E 隔离实例装配（已知项，非本改动引入）

本次尝试用隔离 E2E 实例（`DSH_HOME=/tmp/e2e-dsh-home`，端口 4599，profile e2e，包 link 指向工作区）做真实 host 验证，发现 **proactive 的面板 HTTP 路由（`/api/dsh-proactive/state|action|events`）返回 404、`proactive/` 数据目录不写盘**——即插件未在该实例装配（host 侧 panel routes 未注册、scheduler 未驱动）。

- dsh `0.1.2-rc.1`、`dsh web` 启动无 plugin load 报错（stderr 干净、端口正常监听）。
- `session/list` 等 typert 网关 RPC 正常，说明 webserver 本身活着。
- 推测：`installPanelRoutes` 里 `ctx.get("webServer", false)` 在该 profile 取空，或 0.1.2-rc.1 升级后 plugin 装配链路与 260910（0.1.1-rc.2 时期）不同。
- **非本次改动引入**：回滚到改动前 commit 同样 404（环境问题）。
- 处置：E2E 真实 host 装配修复另立排查；本次逻辑验证以 275/275 单测为准（fixture 用真实 SessionEvent 形状，覆盖记账/剔除/豁免/fork/cold 三态/skip 调度/wake 记账时序）。生产实例（端口 4175）部署+重启后的真实行为见 validation.md。
