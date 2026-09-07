# 260907-proactive-alarm-v2.research.md

调研阶段产出：闹钟模型 v2 重构（干掉 alarm/heartbeat 分类 → 遵从免打扰开关；类型 单次/循环/cron；目标会话 resume/fork/new）。

调研方法：精读 `packages/dsh-proactive/src/` 全部 21 个源文件 + 线上数据（`$DSH_HOME/proactive/`）；两个只读子代理分别梳理既有特性文档与 DSH 参考实现 API（`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 下 dsh-agent / dsh-agent-loop / dsh-schedule / dsh-session / dsh-session-persistence / dsh-host-apiproxy / dsh-headless）。

---

## 一、代码现状盘点（packages/dsh-proactive）

| 文件 | 职责 | v2 相关要点 |
|---|---|---|
| `src/domain.ts` | 领域模型、校验、DST 正确的时区/本地时间解析（移植自 dsh-schedule）、闭式错误码 | `WakeReason = "heartbeat" \| "alarm"`（注释还提及旧值 check_in/interval/companion）；`AlarmMode = "one-shot" \| "repeat"`；`AlarmTrigger = at \| everySeconds(+anchor+jitter 0..1)`；`Alarm.sessionId` 既是归属又是唤醒目标；`jitterInterval` 语义 = 间隔乘 (1 ± jitter·U(0,1)) 缩放，保底 300s |
| `src/alarm-factory.ts` | 工具/面板共用的创建校验与构建 | selector: at/after_seconds/every_seconds 恰一；heartbeat 允许空 prompt（用默认词）；`wake_reason` 默认 alarm |
| `src/scheduler.ts` | 串行 drive 循环 + 门控 + 重试 + 单定时器重臂 | `fireOne`：quiet && wakeReason!=="alarm" → 5min 延迟重评估；非 alarm 受日预算门控；hourlyCap 对所有闹钟生效；`advance`：repeat → nextEveryOccurrence/nextJitteredOccurrence（从 now 走，错拍跳过）；one-shot → completed |
| `src/wake.ts` | WakeDriver：live 复用 / cold resume（`ctx.agents.resume` + setup 装 `installModelSelection`，createWakeSelectionRef：会话 request header → agentDefaultModel → warn）；runMaintenance+followup、whenIdle、observer 判定 | 唤醒目标恒为 `alarm.sessionId`；即冷会话也能 resume（260906 修复） |
| `src/framing.ts` | 唤醒报文：wake_reason/quiet_hours/budget/presence + alarm_prompt_json + 2 条回复规则；notice-form 用户消息（summary≤120） | heartbeat 唤醒恒以 `heartbeatPrompt` 开头（effectiveWakePrompt） |
| `src/observer.ts` | 从提交后的会话日志切片判定 no_reply/reply/failed 与预算增量；leaked 标记；reasoning/reply 摘要截断（200 字符） | 与唤醒路径无关，v2 无需改动 |
| `src/store.ts` | alarms.json（version 1 原子写）/runs.jsonl/state.json（日预算） | `alarmIsValid` 只校验 id/sessionId/nextDueAt 字符串；加载不做字段归一化（旧字段如 deliveryHint 原样保留） |
| `src/tools.ts` | proactive_set/list/cancel/no_reply/update_settings | set 参数表含 wake_reason、jitter(仅 every)、prompt 可选（heartbeat）；update_settings 含 heartbeat_prompt |
| `src/settings.ts` | settings 命名空间 + 热更新 | HotConfig 含 heartbeatPrompt |
| `src/config.ts` | 默认配置 + config.json/env 覆盖 + 安静时段判定（Intl，跨午夜） | 含 heartbeatPrompt |
| `src/panel/*` | HTTP 路由（state/action/events）+ 服务（snapshot/actions 共享 alarm-factory）+ 契约 | PanelAction create/edit args 同工具方言；`sessionId` 归属与作用域校验 |
| `src/client/*` | settings.section 全局面板 + conversation.view 会话 tab | CreateForm：触发方式 after/every 二选、jitter ±比例 0-1、wakeReason 下拉；设置卡有心跳默认词输入框；表格按 sessionId/mode/wakeReason 过滤 |

线上数据（`/root/.dsh/proactive/`）：alarms.json 现存 4 条（3 条 completed one-shot + 1 条 failed repeat，wakeReason 含 legacy "companion"）；**无任何闹钟使用 jitter**（旧 0..1 语义迁移负担≈0）；config.json 仅覆盖 maxDeliveriesPerDay=20。

git 注意：工作区有他人未提交的 session-tab client 改动（host-api/panel/sections/session-panel/locales/index），实施时用 commit-own-changes 只收自己的 hunk。

---

## 二、平台 API 调研结论（直接验证 + 子代理交叉确认）

**1. 目标会话三模式原生可支撑：**

- resume：`ctx.agents.resume({resumeSessionId, agentOptions?, setup?}) → AgentHandle`（dsh-agent AgentRegistry）。冷会话经 `sessionPersistence.prepare` 加载（dsh-agent-loop `resumeWith`）。现 wake.ts 已在使用。
- 新建会话：`ctx.agents.create({sessionId, meta?: {cwd?, parentSession?, seedLength?, origin?, delegationDepth?, agentPreset?}, seed?: SessionEvent[], agentOptions?, setup?}) → AgentHandle`（CreateAgentOptions，dsh-agent/lib/types/index.d.ts）。seed 省略 = 空新会话。官方范本 dsh-headless：`agents.create` + `agent.followup(createUserMessage({source:{kind:'user'}}))` + `whenIdle`。
- fork：**没有 `agents.fork`、没有 forkOf query param**。宿主路径 = 客户端 `ctx.sessions.fork({sessionId, atSeq?, increaseTitle?})` → RPC `session.fork`（dsh-host-apiproxy api-proxy.js:1975）→ `agents.create({sessionId: "session-"+randomUUID(), seed: events.slice(0, cut), meta: {cwd, parentSession, seedLength: cut, agentPreset}})`，`atSeq` 锚定"第一个 ≥atSeq 的 turn/end"做已完成回合截断。内存层另有 `SessionStore.fork(source, boundary?, childId?)`（dsh-session）。
- seed 约束（agents.create 文档原话）：必须是自 seq 0 连续、仅 lossless-JSON 数据、**无未闭合 turn/step、无悬空 tool call** —— 调用方负责在已完成回合边界截断。
- `dispose()` 停止 loop、注销 agent、从**内存 store** 移除会话，**持久化会话保留**（现有 cold-resume 已在依赖此行为）。
- `AgentHandle.agent` 上 runMaintenance（忙时同步抛）/followup/whenIdle 与现有 wake.ts 使用点一致，create 出来的 agent 同样可用。
- 模型选择：create/resume 都经 `setup(agentCtx)` 安装 `installModelSelection(agentCtx, ref)`，ref 语义 = 会话 request header → `ctx.agentDefaultModel.currentSelection()` → warn（现成 createWakeSelectionRef 模式）。

**2. cron：平台无现成能力。**

- dsh-schedule 只有 `after | at | every`（kind 模型），**全依赖树无任何 cron 库**；every 最小 300s（与 dsh-proactive 的 MIN_EVERY_SECONDS 一致）、创建锚点对齐、错过不补跑、`resolveEveryOccurrence` 纯函数 —— 是"下一次出现"纯函数的现成范本，但**无 cron**。
- 结论：cron 表达式解析/求值需自研（推荐，保持零运行时依赖——本插件 peerDeps 无运行时依赖，部署在手机容器，加依赖需在 profile 里 pnpm install）或引外部库（cron-parser 带 luxon 时区依赖较重）。

**3. quiet hours / daily budget：平台无参考实现**（dsh 依赖树无 DND/budget 概念，命中全是 token/spill 预算）。dsh-proactive 继续自持，现有 proactive_update_settings 门控方向正确。

**4. notice/summary：** `ContextFormed {form:'notice', summary}`，summary ≤120 字符，来源 `kind: 'plugin'`（dsh-llm）—— 现成、无缺口。

**5. 冷会话可见性：** 不经过内存 `ctx.sessions`（live store），经 `ctx.sessionPersistence.list/inspect/prepare` 按需读盘；`inspect(id) → SessionInspection {meta, events}` 返回不可变平衡日志视图 —— fork 的 seed 可直接取自 inspect（冷父会话无需先 resume）。

**6. SessionId：** `Branded<'SessionId'>`，`SessionId(id)` 构造；宿主侧分配惯例 `session-${randomUUID()}`。

**7. 其他：** `agent/session-start` source ∈ startup|resume|clear|compact（唤醒即 resume/startup）；主注入 `["agents","tools","sessionPersistence"]` 已就位（sessionPersistence 是 resume 的前提，插件已注入）。

---

## 三、设计输入汇总

1. **heartbeat vs alarm 的全部差异点**（干掉分类前必须逐一处置）：
   - 门控：alarm 豁免 quiet + 预算；heartbeat 被两者门控 → 变成 `respectQuietHours` 开关（默认 false，行为对齐现状 alarm）。
   - prompt 必填性：alarm 必填、heartbeat 可空（默认词）→ v2 全部必填，删除 heartbeatPrompt。
   - framing 文案：wake_reason 行 + heartbeat 默认词前置 → 改为 type + respect 信息。
   - 面板设置卡"心跳默认词"输入框 → 删除。
2. **jitter 现状**：仅 every 支持，语义 = 间隔乘 (1 ± j·U)；线上无使用中的 jitter。v2 统一为"计划时刻 + U(0, jitter_seconds) 延迟"，三类型通用。
3. **目标会话现状**：创建即绑定，唤醒即 resume 该会话；面板已支持 host 面板选目标会话（v4）+ 会话 tab（归属守卫）。
4. **迁移负担**：4 条线上闹钟，无 jitter、含 legacy wakeReason —— 读时归一化即可，成本极低。
5. **风险清单**：
   - fork 的 seed 截断必须满足 agents.create 校验（已完成回合边界），live-busy 目标并发读 events 有极低竞态（读时截断容忍）。
   - 新建/分支会话在侧边栏成为真实会话（预期行为，需在计划中明示）。
   - 重启 dsh 安装验证会中断本会话（既有约束）。
   - 并发未提交工作（session-tab client 文件）与 v2 的 client 改动同文件，需分 hunk 提交。
   - cron 自研要覆盖 DST（与 domain.ts 现有机理一致，不信任进程时区）。

---

## 四、结论

- 三种目标会话模式全部由 `ctx.agents.resume / create` + seed 机制覆盖，无需平台补丁。
- cron 必须自研（零依赖，5 字段数字语法，DST 正确，纯函数求值 + 频率护栏）。
- 门控简化路径清晰：wakeReason → respectQuietHours；heartbeatPrompt → 删除。
- 整体为单 phase（预估改动 ~1400-1700 LOC，含测试），无需拆 phase。