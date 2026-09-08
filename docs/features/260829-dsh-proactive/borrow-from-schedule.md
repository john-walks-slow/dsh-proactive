# 从官方 dsh-schedule 借鉴清单

> 日期:2026-09 · 前提决策:基于 dsh-proactive 自有架构继续开发(host 级闹钟 + 冷唤醒),不 fork 官方。
> 本文记录官方实现中所有值得吸收/对齐的点,按「已吸收 / 真实 gap / 文档纪律 / 测试基建 / 新需求参考」分类,每条附官方源码出处。
> 官方参考对象:`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-schedule/`(lib/index.js、lib/invariant.js、README.zh.md)。

## 1. 已吸收(无需动作)

| 机制 | 官方出处 | 我们位置 |
|---|---|---|
| DST 正确本地时间解析(overlap 选较早、缺口拒绝、绝不导入进程/浏览器时区) | lib/index.js:135-255(parseOffsetInstant / canonicalizeTimeZone / resolveLocalInstant) | src/domain.ts(注释明说移植该算法) |
| framing 动态值 JSON 转义 + "untrusted reminder content" 标注 | lib/index.js:547 renderReminderFraming;README「模型体验」 | src/framing.ts:61(JSON.stringify + alarm_prompt_json) |
| runMaintenance + whenIdle 维护准入,绝不中途引导/中断当前对话 | lib/index.js:813-850 driveOnce + waitForIdle;README「交付生命周期」 | src/wake.ts:152-161 |
| 工具写路径持久化屏障 + persistence_uncertain 回滚 | lib/index.js:593 flushSchedulePersistence;README「组合」 | src/tools.ts 161-166 / 211-216 / 279-283(set/cancel/update_settings 先持久化,失败回滚内存 + 返回 persistence_uncertain) |
| 变更前校验前移(不改事实源先验输入) | lib/index.js:1120 preflight;README「管理工具」 | src/alarm-factory.ts validateCreateArgs + tools.ts:154 |
| 闭式错误码 + 稳定诊断文本(不暴露后端异常) | README「管理工具」错误码段;renderThrown | src/domain.ts ProactiveErrorCode + internalError() |
| 每次成功管理操作后触发 owner 重算 | README「管理工具」末段 | tools.ts:167/217 scheduler.requestDrive() |

> 注意:早期评审曾认为 persistence_uncertain 是 gap —— 已核实 tools.ts 三个写工具全部实现(先持久化、失败回滚 + 报错),此条**闭合**,真正的缺口在面板路径,见 2.1。

## 2. 真实 gap(按优先级)

### P1-1 面板写路径持久化失败静默(5 处)
- **现象**:`src/panel/service.ts` 110 / 140 / 150 / 178 / 192 全部 `void store.persist().catch(() => undefined)`,仅 update_config(206)返回 persistence_uncertain。工具路径已对齐,面板不一致 — 用户"保存成功"实际可能因崩溃丢失,且无任何痕迹。
- **官方对照**:任何变更都等 post-append barrier 确认(README「组合」);工具路径已示范回滚语义。
- **建议**:面板 mutation 仿 tools.ts — 失败回滚内存 + 返回 error(前端可经 SSE 感知),或至少记一条 warn 审计到 runs.jsonl。

### P2-1 调度器推进路径持久化失败不可见
- **现象**:`src/scheduler.ts` advancePast(272)/ terminate(307)/ deflect(319)/ deferRetry(325) 均 `persist().catch(() => undefined)`。内存语义本身成立(事实源在内存,下次 drive 重算),但崩溃后磁盘回退旧 nextDueAt → 重复闹钟重启时可能被 boot 策略补跑 → 重复送达,即官方「窄崩溃重复窗口」描述的情形。
- **官方对照**:post-append barrier 失败 → persistence_uncertain + 保留 batch + 活动驱动恢复(README「交付生命周期」);官方明示"不承诺恰好一次"。
- **建议**:不改架构;persist 失败记 runs.jsonl warn 审计 + 状态标 dirty,重启 boot 对 dirty 记录按"已推进未落盘"处理(避免补跑);至少把该窗口写进已知限制。

### P2-2 三入口写事务串行化审查
- **现象**:工具(tools.ts) / 面板(panel/service.ts) / 调度器(drive 链)直写同一 store;JS 单线程下同步段安全,但 persist 的异步交错窗口存在。
- **官方对照**:per-agent WeakMap tail 队列把所有事务(含读)串行化(lib/index.js:611 runScheduleTransaction)。
- **建议**:与后续新需求(create/fork 目标)一起评估 — 引入 store 级轻量 mutation 队列或复用 driveChain;勿过度设计(我们 store 同步内存,风险低)。

### P3-1 id 分配确定性
- **现象**:alarm-factory.ts:156 allocateId("alarm") 随机生成;官方 allocateScheduleId(folded) 确定性 + 永不复用(lib/index.js:441)。
- **价值**:崩溃后重试创建不会撞旧 id、审计可追溯;碰撞概率极低,优先级低。

## 3. 文档纪律(官方成熟度的直接体现,零代码成本)

- **已知限制清单**:官方 README 列 7 条(会话内触发、活动驱动重试、显式时区、固定间隔、只追最新一次、崩溃重复窗口、加载顺序边界);我们 README 只 3 条且仍标 "v1"(现状已 v4)。补齐:persist 失败静默面、corrupt 整表降级丢闹钟、配置双入口语义、30s 定时重试 vs 活动驱动、budget 判定时区、崩溃重复窗口精确表述。
- **Token / KV cache 影响**:官方 README「模型体验」为每个 framing 量化 token 追加与前缀稳定性;我们可补"唤醒回合 = 一条 notice 用户消息 + N 条后续回复"的模型体验节。
- **错误码表**:官方 README 列 10 个封闭码;我们 ProactiveErrorCode 已定义但 README 未列全。
- **加载顺序**:官方记载"不接管加载时已 live 的 Agent"是限制;我们是超集(启动扫描 roots,index.ts:119-121),文档标注以免误读为同限制。

## 4. 测试基建(对新需求最关键的借鉴)

- **官方做法**:devDependencies 声明 @deepseek-ai/dsh-agent-loop-testkit + dsh-session-persistence-jsonl,可本地跑真实 agent-loop 集成测试(折叠/回放/维护准入)。
- **我们现状**:AGENTS.md 明确"涉及真实 agent 的路径只能 E2E 验收(重启 dsh)"— 每次验证都打断会话、成本高。
- **价值**:后续新需求(create 新会话 / fork 目标)的生命周期语义 — create+dispose 后是否落盘、冷重启是否可见、fork seed 校验(contiguous from seq 0 / 平衡 completed-turn / 无 open turn)— **恰好是最需要反复验证的部分**,testkit 能把它变成可重复的本地测试。
- **动作**:本机运行时装未打包 testkit(已核实 node_modules 无),需 `pnpm add -D @deepseek-ai/dsh-agent-loop-testkit@^0.1.1-rc.2` 后先验证其 API 再接入。

## 5. 新需求(fork / 新会话目标)直接参考的官方语义

- **fork 继承边界**:官方 "fork 只折叠 session.events.slice(session.header.seedLength ?? 0),因此不会继承父会话的提醒"(README「持久状态」)— 我们 host 级闹钟天然不随会话继承,方向一致;但 child seed 构造必须满足平台契约:`CreateAgentOptions.seed` = contiguous from seq 0、平衡已完成回合前缀、无 open turn/dangling tool call(dsh-agent lib/types/index.d.ts:80-95 与 SessionForkError 码 dsh-session lib/types/index.d.ts:268-284)。官方 seedLength 用法是现成参照。
- **"fork 不转移提醒"的决策理由**(避免继承父会话语义污染)可直接作为我们"fork 目标的闹钟归属"设计参考:闹钟始终挂在 host,child 只接收一次唤醒 framing。

## 6. 工具能力逐项对照(2026-09 补)

> 对照对象:官方三个工具执行体(lib/index.js:1159-1389 registerScheduleTools + validateCreateArgs:1129)vs 我们 tools.ts / alarm-factory.ts。

### 6.1 共同核心(create/set、list、delete/cancel)已对齐的部分

- 三 selector(after_seconds / at / every_seconds)恰一、prompt trim 非空(alarm 语义下)、every>=300 → frequency_too_high、at 严格偏移 RFC3339 或本地对象、校验全部前移(不改事实源先验输入)、写成功后触发 owner 重算(requestDrive)、未知/已终结 id 删除 → not_found 族错误、输出 schema per-property required / additionalProperties:false / 判别 union。

### 6.2 真实缺口

| 缺口 | 官方行为 | 我们现状 | 级别 |
|---|---|---|---|
| **list 视图不回显间隔数值** | 视图含 afterSeconds / everySeconds | AlarmView 无 everySeconds(jitter 有),模型无法凭视图确认周期 | **P1-2**(改动小:AlarmView + toAlarmView + ALARM_VIEW_SCHEMA + 测试) |
| 错误码粒度 | invalid_selector / invalid_rule / time_out_of_range 三个独立码 | 合并为 invalid_trigger(消息文本带细节) | P2-3,API 契约变化需权衡 |
| delete 空白/空 id | preflight 前显式拒绝(invalid_rule) | 落到 not_found | P3 |
| exec.signal 取消 | 队列 FIFO 轮次前可取消返回(cancellationPlaceholder) | 未用 | P3(我们工具执行近乎同步,窗口小) |

### 6.3 我们的超集(官方没有,无需对齐)

- proactive_no_reply(静默收尾)、proactive_update_settings(host 配置热更新)、jitter、wake_reason、顶层 time_zone、prompt 4000 上限、6 态视图 + 面板历史、quiet_hours/budget 门控。

### 6.4 等价但命名不同(不建议改)

- schedule_delete ↔ proactive_cancel;{id,deleted:false,code:"schedule_not_found"} ↔ not_found 错误 union(官方失败也携带 id,更结构化,消息里已含)。