# 主动跟进（Proactive Agent）插件 — 调研文档

> 日期：2026-08-29 · 项目：dsh-proactive
> 范围：DSH 平台机制研究（本地代码勘察）+ 主动型智能体产品设计研究（网络调研）

---

## 1. 背景与目标

在 DeepSeek Harness（DSH）上开发一个插件，让智能体（agent）在**没有新用户输入**时也能被主动唤醒，并自主决定是否打扰用户。三个目标场景：

1. **习惯教练**：模型定时主动跟进、监督用户的习惯执行（如每晚打卡复盘、晨间计划确认）。
2. **虚拟伴侣**：模型主动找用户聊天（如午餐时间的一句问候）。
3. **用户委托的定时任务/提醒**：用户要求模型在某个时刻做某事或提醒自己，模型给自己定"闹钟"，按时唤醒。

**硬性约束（no_reply）**：模型被唤醒后可以选择 `no_reply`——本次唤醒完全不被用户感知（不产生可见消息、不推送通知），但模型可以借机做后台工作（检查状态、记笔记、决定不打扰）。

---

## 2. DSH 平台机制研究（本地代码勘察）

> 勘察对象：`/usr/lib/node_modules/@deepseek-ai/dsh/`（CLI 与全部 core 包的安装副本）与运行中的 web profile（`/root/.dsh/profiles/web/`）。

### 2.1 插件体系

- DSH 采用 **cordis 4** 插件模型：插件 = 一个 pnpm 包，导出 `export function apply(ctx) {...}`（函数插件）或 `{ inject, apply }` 对象形态；`inject` 声明硬依赖服务。
- profile 的组合 = **补丁栈**：CLI 包 `package.json` 的 `dsh.profile.bundles` 列出的 bundle 包 + profile 的 `cordis.patch.yml` + 家目录 `cordis.patch.yml` + 运行时 overlay（见 `/usr/lib/node_modules/@deepseek-ai/dsh/lib/profile-boot-DG5t9aNs.js`）。`cordis.yml` 只是每次启动重写的空根配置，**不要手改**。
- 一个 bundle 包在自身 `cordis.patch.yml` 里 `insert` 若干插件行（如 `dsh-zen-remote` 一个包挂三行：UI 壳 + 网关 + 推送）。安装方式：`dsh plugin --profile <name> add <pkg>`（在 profile 目录执行 pnpm add 并登记 bundle）。
- 第三方插件参照物（本机已装）：`dsh-zen-remote`、`dsh-wechat`、`dsh-tavern`、`dsh-rule-manager`、`dsh-easyrewrite`、`dsh-mnemon`。**dsh-tavern**（角色卡/世界书，SillyTavern 格式）证明"人格注入"已有生态；**dsh-wechat / dsh-zen-remote** 证明"推送通道"已有生态。

### 2.2 已有"定时提醒"能力：`@deepseek-ai/dsh-schedule`（核心参照）

安装于 core 包目录（`dsh-schedule/lib/index.js`，1389 行），**但未挂载到 web profile 的 base bundle**（勘察 `dsh-base/cordis.patch.yml` 无 schedule 行）——即当前运行的 GUI 里模型**没有**定时工具。

机制要点（来自其 README 与源码）：

- **3 个 agent 作用域工具**：`schedule_create`（`after_seconds` / `at` / `every_seconds` 三选一）、`schedule_list`、`schedule_delete`。`at` 要求显式 RFC3339 偏移或 `{date, time, time_zone}` 且**绝不**从浏览器/上下文/进程时区推断时区。
- **持久化**：状态是会话日志里的 `schedule/change` 事件（版本 1 联合：create/delete/dispatch，含稳定 id、trim 后 prompt、UTC scheduledAt），重放折叠恢复；fork 不继承（只折叠 `seedLength` 之后）。
- **到期机制**：对**活的 root agent**（`agent/created` 后安装 runtime），用 `agent.whenIdle()` + `agent.runMaintenance(fn)` 认领空闲相位 + `agent.followup(createUserMessage({...}))` 入队一个 **user 角色 framing 消息**唤醒一轮普通回合：
  单条：`[SCHEDULE REMINDER] ... reminder_prompt_json ...`；批量：`[SCHEDULE REMINDER BATCH] ...`。framing 明确要求把 prompt 当**不可信提醒内容**呈现、不是新指令。
- **语义边界**：overdue 一次性提醒优先，逐条进入；逾期 fixed-rate 记录一次只贡献最新一个发生点（不补发积压）；时钟回拨不提早触发、前跳进 overdue；崩溃狭窄窗口可能重复 dispatch（不承诺恰好一次）。
- **已知限制（关键缺口）**：**仅限会话本地交付**——冷会话（无 live agent）不会触发；只有会话恢复后才处理 overdue。**没有**：冷唤醒、外部通知、日历/cron 表达式、每 <5 分钟的周期。

### 2.3 Agent 生命周期与唤醒 API

- `ctx.agents`（`dsh-agent`）：live agent 注册表。`ctx.agents.resume({ resumeSessionId, agentOptions?, setup?, signal? })` 从持久化加载会话、重建 agent（要求存在会话持久化后端），返回 `AgentHandle { agent, dispose() }`。
- **事件词汇**（`agent/*`）：`agent/created`（scope setup 之后、注册表条目就位之后）、`agent/session-start`（首个受支持的启动注入点，不可 veto）、`agent/pre-step`（协作式 waterfall，可 reject/换入消息批次）、`agent/turn-stopping`（本可完成回合关闭前）、`agent/disposed`、`agent/inbox/*`。
- **驱动原语**（`dsh-agent-loop`，`lib/index.js`）：`send()` 按 target×wakeup 路由——`followup()` 追加 **next-turn** FIFO 并唤醒；`steer()` 追加 next-step inbox 并唤醒；`inject()` 追加 next-step 不唤醒。`whenIdle()` / `runMaintenance()` / `cancel()`。
- **回合/步骤持久事实**：`session/event`（含 `turn/start`、`step/start|end`、`turn/end`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`user/message`）；客户端经 `dsh-client-connection` 推送这些事件。
- **恢复的 agent 也走 `agent/created`**：因此"在 agent/created 给 root agent 挂作用域工具"的注册模式（schedule 同一模式，见 `dsh-schedule/lib/index.js` 底部 apply）对 resume 出来的 agent 同样生效。

### 2.4 工具注册与"立即结束回合"机制

- 作用域工具注册（schedule 模式，`registerScheduleTools(rootCtx, agent.ctx, agent, onDurableChange)`）：在 `agent.ctx`（agent 作用域 context）上 `agent.ctx.tools.register(defineTool({...}))`，dispose 时撤销。
- **`concludesTurn: true`（no_reply 的机械基础）**：`dsh-tools/lib/index.js` 中调度器执行工具后，若 result 带 `concludesTurn === true` → `exec.concludeTurn()`；`dsh-agent-loop` 的 `executeToolCalls` 返回 `concluded`，`step()` 随即返回 `{kind:"completed"}`——**不再请求下一次模型补全**。即：模型在某一轮补全中以工具调用（无正文）结尾调用 `proactive_no_reply`，回合在工具结果落盘后立即结束，**不会再有生成正文的补全**。

### 2.5 消息可见性（GUI 渲染路径）——no_reply 能否"数据级隐身"

勘察 `dsh-client-ui-conversation/lib/client.js` 与 `dsh-client-runtime/lib/client.js`（context-provenance 段）：

- **plugin 来源的用户消息渲染为"上下文注入"chip，不是用户气泡**：`messageDefinition.start` 判断 `event.data.source.kind !== "user"` → 节点 `kind: "context"`；`contextProvenance(source)` 对 `kind:"plugin"` 返回 role `inject` + label=plugin 名；`contextForm` 只渲染白名单 form（`instructions / catalog / snapshot / notice / relay / recall`）——**`notice` 在列**（有专门呈现），未知 form 降级为 opaque 也不丢行。
- **无文本的 assistant/message 不渲染**：`hasTextAssistant` 谓词 = assistant/message + append surface + 内容存在**非空 text block** 才渲染。仅含 tool-call 块的 assistant/message 无气泡。
- 表面操作（`dsh-session/lib/index.js`）：`surfaceOp` 只区分 `append` / `replace`，**没有 `hidden` 表面**——事件一旦 append 即对 GUI 可见（按上述渲染规则）。日志 append-only，不可撤回。

**结论**：no_reply 必须走"数据级不可见"：静默回合不产生"带非空正文的 assistant/message"。`concludesTurn` 机制 + 协议约束（模型单独调用 no_reply 工具、不生成正文）可实现该不变量；残余风险 = 模型在同一补全里先写正文再调工具（正文会被渲染），需要 framing 强约束 + 事后校验告警（见计划 D3）。

### 2.6 投递通道（已存在，可直接供唤醒回合使用）

- **手机推送**：`dsh-zen-remote` 提供 `push_notify` 工具（`dsh-push.mjs`），向 `127.0.0.1:${LAN_GATE_PORT}/pwa/push/send` POST（VAPID + aes128gcm），本轮会话实际可用（工具列表中有 `push_notify`）。它自带策略：approval/question 事件腿 + 模型腿 push_notify 工具 + 可选 turn-end 腿，15s 去抖、60s 节流（host 侧 1/min、20/h）。
- **微信**：`dsh-wechat` 提供 `send_wechat` 工具。
- **对话本身**：正文结束的回合 → 正常 assistant/message → GUI 对话流可见（用户回来看到）。
- **这些工具随 agent 作用域注册，恢复出来的 agent 同样拥有** → 唤醒回合里模型可直接调用，无需插件再造通道。

### 2.7 持久化与会话恢复

- base bundle 挂载 `dsh-session-persistence-jsonl`（`config.root = $DSH_HOME/sessions`），web profile 已生效 → `ctx.agents.resume` 可用。
- 会话日志同时承载 history/compaction/inbox，重放即恢复（resume 后 turn 编号从已加载日志继续）。

### 2.8 缺口汇总（本插件要补的）

| # | 缺口 | 现状 | 本插件方案 |
|---|------|------|-----------|
| G1 | 冷会话定时唤醒 | schedule 仅 live 会话本地 | host 级持久闹钟 + `agents.resume` 唤醒 |
| G2 | no_reply 协议 | 无任何抑制/静默概念 | `proactive_no_reply` 工具 + `concludesTurn` 数据级隐身 |
| G3 | 主动跟进策略（预算/安静时段） | 无 | host 策略 + framing 决策上下文 |
| G4 | 可见投递的"上下文透明" | 注入消息会显示为"上下文注入" chip | 利用 `source.kind=plugin, form=notice` 做出克制呈现 |
| G5 | 模型"给自己定时"的工具集 | 未挂载 schedule | 插件自带 `proactive_set/list/cancel`（host 级语义） |

---

## 3. 产品设计研究（网络调研）

> 采用 degoog 聚合检索 + 原文抓取；聚焦"主动打扰"的设计边界。

### 3.1 通知预算（Notification Budget）——硬约束

来源：[Background Agents and the Notification Budget](https://tianpan.co/blog/2026-05-13-background-agents-notification-budget-attention-economy)（2026-05）

- 用户每天对**未经请求的 AI 打扰**的总上限约 **3–5 条**（全来源合计）；智能手机用户每天已收到 46–63 条推送，互相争抢注意力。
- 打断成本：一次任务中断平均恢复 **~23 分钟**；5 秒的打断让复杂认知任务错误率翻三倍；约一半"关掉某 app 推送的人"最终流失该 app。
- **错得很离谱的指标**：以"发了多少通知"为 OKR → 卷到用户静音、卸载。应以"**被行动的通知**"（opened→acted，按重要性加权）为准；被划掉的通知是净负资产。
- **通知预算架构四件套**：① 按用户每日预算、硬上限（3 起步、5 封顶），预算作为 planner 可见的**状态**；② 价值-注意力评分层（期望效用 × 打断成本，按用户历史 dismiss/act 学阈值）；③ 预算耗尽时新候选要么挤掉今天已发（几乎从不划算）要么等；④ 把每条通知当"从有限账户取款"而非"往漏斗存款"。

### 3.2 Interrupt Pattern：让智能体学会"不跑"

来源：[The Interrupt Pattern: How to Design AI Agents That Know When to Stop](https://supergood.solutions/blog/tech-tuesday-interrupt-pattern-agent-design-2026)（2026-03）

- 多数生产失败的 agent 不是模型不行，而是**没有"停下来/不运行"的机制**（greedy execution）。生产级 agent 与 demo 的差别在于：阈值设计、升级逻辑、操作范围外的拒绝。
- 启示：**proactive 唤醒的默认值应是"不打扰"**——唤醒后模型的首要决策是"值不值得说"，no_reply 是设计的第一公民，不是异常分支。

### 3.3 通知过载与"按用户节奏"模式

来源：[Is Your AI Assistant Actually Distracting You? The 2026 Notification Overload Problem](https://tryglean.app/blog/ai-assistant-notification-overload-2026)

- AI 主动插入（active inferences）比被动通知更伤：它是在"观察你并决定打扰你"。反模式：持续建议代码重写、推荐文章。
- 主张 **capture-first / user-paced**：AI 在**用户安排的时间表**上工作，而不是反过来（"AI works for you on your schedule, not the other way around"）→ 对应本插件的"用户委托定时"与"模型自己定的闹钟需可被用户取消/降频"。

### 3.4 习惯教练 / 问责机器人

来源：[Habit Coach AI](https://habitcoachai.com)、[HackerNoon: MindCally - AI Accountability Partner](https://hackernoon.com/mindcally-your-personal-accountability-partner-ai-chatbot)（2024-11）、[HabitCoach.ai: AI Accountability Coach](https://www.habitcoach.ai/blog/ai-accountability-coach)

- 模式共识：**"每日一次"的定时 check-in + 低摩擦回答**（不是轰炸式）；问责感来自"被期待汇报"，配合正向强化；用户可随时文本联系教练。
- check-in 时机通常取**用户自选或默认的稳定时点**（晚上复盘、早起确认），并允许跳过/暂停（体恤日）。
- 启示：习惯教练的调度 = 每日固定窗口 + **模型先静默检查进度**（no_reply 优先），有实质内容再浮现。

### 3.5 虚拟伴侣的主动聊天

来源：[Replika](https://replika.ai)、[The Complete Guide to Replika AI](https://skywork.ai/skypage/en/replika-ai-chatbot-guide/2032000102783459328)（2026-03）

- Replika 将"伴侣主动发起"作为核心黏性：用户可**显式开关并自定义推送频率**（如每天几条）；主动消息带上下文时机（时间、上次话题、用户状态），且含"我在想你"类轻量消息。
- 教训：伴侣型主动消息**必须用户显式开启**，否则就是骚扰；频率可调（日预算即为此服务）。

### 3.6 开发者场景的实证

来源：[arXiv:2601.10253 Developer Interaction Patterns with Proactive AI](https://arxiv.org/html/2601.10253v1)（2026-01）

- 主动编码助手的现场研究：**时机**（在任务边界/用户间隙介入优于打断中段）、**对齐**（介入内容须与当前意图高相关）、可解释性（说明为什么现在提示）显著影响接受度。

---

## 4. 研究结论 → 设计启示（映射）

1. **默认不打扰**：唤醒回合的第一职责是静默评估（no_reply 一公民）；只有"高价值 + 时机合适"才浮现或推送。→ framing 显式授权 no_reply。
2. **日预算硬上限**：host 侧 `maxDeliveriesPerDay`（默认 3），作为模型可见状态；quietHours 内禁止浮现（紧急用户委托提醒可例外，需白名单）。
3. **上下文透明**：任何一次主动行为在对话流里留下克制可见的"notice"chip（`source.kind=plugin, plugin=dsh-proactive, form=notice`），解释"模型为什么突然说话"，并可在插件面板关闭。
4. **用户控制**：`proactive_set/cancel` 全程模型可操作，但用户应能从**插件设置/面板**看到全部闹钟并一键静音（v1 提供配置 + 面板只读；v2 可交互）。
5. **冷唤醒可靠性**：闹钟 host 级持久化（JSON + 原子写），服务重启后重放，overdue 在启动时按规则补处理。
6. **时区显式**：与 dsh-schedule 一致，`at` 目标要求显式 time_zone/偏移，host 不猜时区。

---

## 5. 来源

- DSH 平台机制：本机安装包源码（路径见正文）与 README（`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*/README.zh.md`）。
- 产品设计：[tianpan.co 通知预算](https://tianpan.co/blog/2026-05-13-background-agents-notification-budget-attention-economy) · [supergood Interrupt Pattern](https://supergood.solutions/blog/tech-tuesday-interrupt-pattern-agent-design-2026) · [tryglean 通知过载](https://tryglean.app/blog/ai-assistant-notification-overload-2026) · [arXiv:2601.10253](https://arxiv.org/html/2601.10253v1) · [Habit Coach AI](https://habitcoachai.com) · [MindCally](https://hackernoon.com/mindcally-your-personal-accountability-partner-ai-chatbot) · [Replika](https://replika.ai) · [Replika 指南](https://skywork.ai/skypage/en/replika-ai-chatbot-guide/2032000102783459328)
