# 260907-proactive-alarm-v2.plan.md

闹钟模型 v2：干掉 heartbeat/alarm 分类 → 每闹钟"遵从免打扰时段"开关；类型改为 单次/循环/cron 三种、全部支持 jitter；目标会话支持 既有会话 / 从既有会话 fork / 新建会话 三种。

---

## 1. 目标

1. **去掉 wake_reason 分类**（heartbeat|alarm 及其 legacy 值）。门控语义收敛为单个开关：**`respect_quiet_hours`（遵从免打扰时段）**，每个闹钟独立设置。
2. **闹钟类型三选一**：`once`（单次）/ `every`（循环）/ `cron`（cron 表达式）。三类型全部支持 `jitter_seconds` 随机抖动。
3. **目标会话三选一**：`resume`（既有会话）/ `fork`（从既有会话分支）/ `new`（新建会话），与创建者（owner）解耦。
4. 迁移既有数据（v1 → v2）与 legacy wake_reason，面板、工具、framing 全链路同步。

## 2. 用户路径

### 2.1 模型视角（proactive_set）

- "提醒我明天早上 9 点喝水" → `{at, prompt, target_mode:"resume"(默认自身), respect_quiet_hours:false(默认)}`。
- "每 2 小时安静地检查一下我的进度，别在免打扰时段打扰" → `{every_seconds:7200, jitter_seconds:600, respect_quiet_hours:true, prompt}`。
- "每天早上 9 点（工作日）汇报天气，发到我的工作会话的分支里" → `{cron:"0 9 * * 1-5", target_session_id:工作会话, target_mode:"fork", prompt}`。
- "10 分钟后在新会话里提醒我拟邮件" → `{after_seconds:600, target_mode:"new", prompt}`。
- 唤醒回合与现状一致：framing 报文 + 可选择 `proactive_no_reply` 静默收尾。

### 2.2 面板视角（设置页全局 + 会话 tab）

- 新建/编辑表单：类型三选（单次=延迟秒数或选择本地日期时间 / 循环=间隔秒数 / Cron=表达式）；jitter 秒数（通用）；"遵从免打扰时段"勾选框；目标模式三选（既有会话=下拉选会话 / 分支=下拉选源会话 / 新建会话=无需选择）。
- 表格：类型徽标（单次/循环/Cron）、目标列、免打扰徽标、jitter 显示；原有 暂停/恢复/立即触发/编辑/取消/历史 不变。
- 设置页配置卡：删除"心跳默认词"输入框（收敛为 启用开关 + 每日预算 + 安静时段）。

### 2.3 唤醒回合视角

- resume：与现状相同（live 复用 / cold resume）。
- fork：到点后快照目标会话的**已完成回合前缀** → 创建子会话（侧边栏出现新会话，可继续跟进）→ 在子会话中跑唤醒回合 → 判定/计费不变。
- new：创建空会话 → 跑唤醒回合。
- 三种模式都可被 framing 引导静默收尾；run 记录落在实际唤醒的会话 id 上。

## 3. 领域模型 v2（src/domain.ts）

```ts
export type AlarmType = "once" | "every" | "cron";
export type TargetMode = "resume" | "fork" | "new";
export type AlarmTarget =
  | { mode: "resume"; sessionId: string }
  | { mode: "fork"; sessionId: string }
  | { mode: "new" };

export interface OnceTrigger  { at: string; }
export interface EveryTrigger { everySeconds: number; anchor: string; jitterSeconds?: number; }
export interface CronTrigger  { expr: string; jitterSeconds?: number; }

export interface Alarm {
  id: string;
  ownerSessionId: string;        // 创建者；工具 list/cancel、面板归属守卫用
  target: AlarmTarget;           // 唤醒目的地（与 owner 解耦）
  type: AlarmType;
  trigger: OnceTrigger | EveryTrigger | CronTrigger;
  prompt: string;                // 一律必填（删 heartbeat 的可空语义）
  respectQuietHours: boolean;    // 新开关
  timeZone: string;              // cron 对齐 + 免打扰判定展示（缺省 = 会话浏览器时区 → 宿主时区）
  status: AlarmStatus;           // 不变：scheduled|in-flight|completed|cancelled|failed|paused
  nextDueAt: string; createdAt: string; updatedAt: string;
  runCount: number; lastRunAt: string | null;
}
```

- `WakeReason`、`AlarmMode("one-shot"|"repeat")` 删除；`AlarmTrigger` 泛型删除。
- jitter 常量：`MAX_JITTER_SECONDS = 86400`；`every` 校验 `jitterSeconds ≤ everySeconds`。
- `toAlarmView`（wire 视图）保留 `sessionId` 字段 = **owner**（面板过滤/排序/复制 id 零破坏），新增 `type/respectQuietHours/targetMode/targetSessionId?/jitterSeconds?/everySeconds?/cron?/at?`；不再输出 `wakeReason`/`mode`。

## 4. 门控与预算（src/scheduler.ts）

`fireOne` 判定顺序（对齐现状，仅把 wakeReason 换成 respectQuietHours）：

1. `quiet && alarm.respectQuietHours` → 5 分钟延迟重评估（deflect，现状 heartbeat 行为）。
2. `hourlyCapHit`（**所有**闹钟受 host 每小时上限约束，现状不变）。
3. `alarm.respectQuietHours && 日预算耗尽` → 记录 skip 并推进（现状非 alarm 行为）。
4. 其余照常触发。

> 语义说明：`respect_quiet_hours=true` = 模型自发/低打扰（尊重免打扰 + 受日预算约束）；`false` = 用户明确要求时刻唤醒（免打扰豁免 + 预算豁免）。这正好把现状 heartbeat/alarm 的全部门控差异收敛成一个开关。`maxWakeupsPerHour`、`maxRetriesPerFire`、boot 策略不变。

## 5. 调度：三类型 + 统一 jitter

### 5.1 jitter 统一语义（决策 D1）

`jitter_seconds`（整数 0..86400，0 = 精确）：**每个触发计划时刻之后追加均匀随机延迟 U(0, jitter_seconds)**，在创建/推进时刻用注入随机源预生成并固化进 `nextDueAt`（scheduler 无需等待逻辑，run 记录天然展示实际时刻）。

- once：`nextDueAt = at + U(0,j)`（创建/编辑时生成一次；暂停-恢复保留原计划）。
- every：每次推进取 anchor 网格的下一拍（严格 > 上一计划点，错过跳过），`nextDueAt = 网格拍 + U(0,j)`。网格不漂移（不改 anchor）。
- cron：`nextDueAt = nextCronOccurrence(expr, tz, 上次计划点) + U(0,j)`。

迁移：旧 repeat 记录的 `jitter 0..1` → `jitterSeconds = round(j × everySeconds)`（旧语义 ±j·every 的最大偏差与新语义 +j·every 对齐，线上无使用中 jitter，成本≈0）。

### 5.2 cron 求值器（新文件 src/cron.ts，决策 D3）

**官方 dsh-schedule 同样没有 cron**（用户纠正确认：其调度只有 after/at/every）——cron 为**完全自研、零运行时依赖**；dsh-schedule 仅作为调度语义风格参考（非功能复用）：
- 纯函数求值：仿 `resolveEveryOccurrence` 的形态（`nextCronOccurrence(expr, timeZone, afterEpoch)`，无副作用、可注入随机源）。
- 闭式错误码：沿用 `invalid_trigger` / `frequency_too_high`（与 dsh-schedule 的 ScheduleToolError 同构思路）。
- 频率下限与平台对齐：相邻两次出现 ≥ 300s，恰好等于 dsh-schedule `MIN_EVERY_INTERVAL_SECONDS`。
- 锚点对齐 + 错拍跳过：从"上一计划点"取严格下一次，忙/延迟导致错过时跳过不补跑（与 every 语义一致）。
- DST 正确：复用 domain.ts 已从 dsh-schedule 移植的 Intl 本地投影/时区解析机理，不信任进程时区。

**语法**：标准 5 字段 `分 时 日(dom) 月 周(dow)`，数字语法：
- 字段：minute 0-59、hour 0-23、dom 1-31、month 1-12、dow 0-7（0 与 7 均为周日）。
- 支持 `*`、范围 `a-b`、列表 `a,b,c`、步进 `*/n` 与 `a-b/n`。
- dom 与 dow 双受限时按 **OR**（Vixie cron 语义：周几或几号命中即匹配）；任一为 `*` 则只查另一方。
- **不支持**：`?`、英文月/周名、秒字段、时区偏移表达式（文档注明，错误均归 `invalid_trigger`）。

**求值（DST 正确，复用 domain.ts 的 Intl 本地投影机制，不信任进程时区）**：
`nextCronOccurrence(expr, timeZone, afterEpoch)`：从 after 所在日起逐日推进（≤ 10 年）——对每一天用 `localProjection` 取本地年/月/日/周几，过滤 month 与（dom OR dow），再对允许的 (h,m) 组合用 `resolveLocalInstant` 解析该本地时刻的 UTC 拍（DST 重叠取较早 / 间隙跳过），取严格 > after 的最小值。

**护栏**：
- 非法/越界表达式 → `invalid_trigger`（创建/编辑即失败）。
- 相邻两次出现 ≥ `MIN_EVERY_SECONDS`(300s)（校验时算两次，防 `* * * * *` 刷屏）→ `frequency_too_high`。
- 下一次必须严格 > 现在且 ≤ 10 年（复用 MAX_DELAY_SECONDS 概念）。

**时区**：cron 按 `alarm.timeZone` 对齐。`time_zone` 参数可选、绝大多数调用不传：缺省 = 该（目标）会话最近用户消息携带的 `clientTimeZone`（web 每轮 prompt 都带，与 dsh-time-context 同源），读不到则取宿主进程时区，最后兜底 UTC（src/zone.ts 的 `effectiveTimeZone`，工具与面板共用同一规则）。

## 6. 目标会话三模式（src/wake.ts）

平台事实（调研确认）：`ctx.agents.resume({resumeSessionId,...})` 恢复既有；**无 agents.fork**；fork = `ctx.agents.create({sessionId, seed, meta:{parentSession, seedLength}})`，seed 必须是"自 seq 0 连续、无未闭合 turn 的已完成回合前缀"（宿主 RPC session.fork 的既有语义）；新建 = `agents.create({sessionId})`（dsh-headless 为范本）。`dispose()` 后持久化会话保留 → fork/new 的子会话会留在侧边栏成为真实会话（决策 D5）。

WakeDriver.fire(alarm) 按 `alarm.target` 分派：

| mode | 步骤 |
|---|---|
| resume | 现有路径：`agents.get(sessionId)` 命中即 live 复用；否则 `agents.resume`（现成 setup 装 model selection）→ followup → whenIdle → analyze。 |
| fork | ① 读父日志：live → `agent.session.events`；cold → `ctx.sessionPersistence.inspect(parentId).events`（缺失 → failed："target session missing"）。② 截断 seed：保留到**最后一个 turn/end**（含）；无 turn/end → 空 seed。(extractPairCut helper，纯函数可测) ③ `childId = session-<randomUUID>`。④ `agents.create({sessionId: childId, seed, meta: {parentSession: parentId, seedLength: cut, cwd: 父 cwd}, agentOptions, setup: 装 createWakeSelectionRef})`。⑤ 在 child 上 runMaintenance+followup+whenIdle+analyze；finally dispose。 |
| new | 同 fork 但无 seed、meta 无 parentSession；run 在空会话。 |

- 模型选择：fork/new 的 child 一律走 `createWakeSelectionRef(undefined header, agentDefaultModel 回退)`（现状 warn 机制），fork 可选用父会话 request header 作为水位（实现时评估，二者皆可）。
- inflight 守卫按**实际唤醒会话 id**（child id）记账。
- run 记录 `sessionId` = 实际唤醒会话（fork/new 为 child id）；`alarmId` 不变。

## 7. 工具 schema（src/tools.ts）

### proactive_set

```
prompt                必填（删 heartbeat 可空语义）
至少一个（恰一）：at | after_seconds | every_seconds | cron
jitter_seconds        integer 0..86400，默认 0；every 要求 ≤ every_seconds（三类型通用）
time_zone             IANA；缺省 = 会话浏览器时区（clientTimeZone）→ 宿主进程时区（一律不返显 UTC）
respect_quiet_hours   boolean，默认 false（决策 D2）
target_session_id     string，默认 = 当前 agent 会话
target_mode           enum resume|fork|new，默认 resume
```

类型由 selector 派生：at/after_seconds → once；every_seconds → every；cron → cron（保持"恰一 selector"方言，无冗余 type 字段）。

输出 ALARM_VIEW：`id / sessionId(=owner) / type / prompt / respect_quiet_hours / target_mode / target_session_id? / nextDueAt / state / deliveryMode:"host" / jitter_seconds? / every_seconds? / cron? / at?`。（工具输出 schema 每属性 required:true 的既有约定；可选字段照旧不入 required。）

### 其余工具

- `proactive_list`：按 ownerSessionId 过滤，返回新视图（读取时容忍 legacy 字段）。
- `proactive_cancel`：不变（owner 归属）。
- `proactive_no_reply`：措辞去掉"wake reason"表述（功能不变）。
- `proactive_update_settings`：删除 `heartbeat_prompt` 参数；其余不变（enabled / max_deliveries_per_day / quiet_hours / max_wakeups_per_hour / max_concurrent_per_session / boot_overdue_policy / max_retries_per_fire / max_prompt_length）。

## 8. 配置与文案

### 8.1 配置（src/config.ts / src/settings.ts）

- `ProactiveConfig` 删除 `heartbeatPrompt`：default、resolveConfig、hotSubset、applyHotConfig、validateSettingsPatch、proactiveSettingsSchema、settingsView 全链路删除。
- config.json 旧 `heartbeatPrompt` 键在热更新合并时保留无害（loadConfigFile 不读即不生效；update_config 的 patch 不含它时不覆盖）。

### 8.2 framing（src/framing.ts）

- FramingContext 删除 `heartbeatPrompt`，新增 `respectQuietHours`。
- 报文行替换：`wake_reason: ...` → `wake_type: once|every|cron` + `respect_quiet_hours: true|false`（附语义说明）。
- quiet_hours 行：
  - respect=false：可以触发但提示"当前在免打扰时段内，用户明确要求此刻唤醒，优先短回复或按需静默"。
  - respect=true：提示"本闹钟遵从免打扰时段，若此刻在时段内应保持克制（proactive_no_reply）"。
- `alarm_prompt_json` 字段：`{alarm_id, type, respect_quiet_hours, prompt}`。
- `effectiveWakePrompt` 删除 heartbeat 分支（恒返回 alarm.prompt）。

## 9. 面板（src/panel/* + src/client/*）

- **contract.ts**：`AlarmRowView` 增 `type/respectQuietHours/targetMode/targetSessionId?/jitterSeconds?/cron?/everySeconds?/at?`（`sessionId` 保持 owner）；`ConfigView` 删 `heartbeatPrompt`；`PanelCreateForm` 增 `type?/cron?/jitterSeconds?/respectQuietHours?/targetMode?/targetSessionId?`；`createArgsFromForm` 映射新字段（jitterSeconds 携带规则：every/cron 才有意义，与 selection 联动防 stale）。
- **service.ts**：snapshot 的 run 归属扩展：`run.sessionId === s || 该 run 所属 alarm 的 ownerSessionId === s`（fork/new 的 run 才会出现在 owner 表的"历史"里）；edit/toggle/fire 对 cron 与 jitter 的正确推进（resume 时按类型重算 nextDueAt）；create 的 target 校验（fork/new 时 target_session_id 规则、resume 必填 session）。
- **routes.ts**：不变（传输层）。
- **sections.tsx（CreateForm/AlarmTable）**：
  - CreateForm：类型三选（单次=延迟秒数或 datetime-local + 浏览器时区 / 循环=间隔秒数 / Cron=表达式输入）；jitterSeconds 输入（0..86400；循环时提示 ≤间隔）；"遵从免打扰时段"勾选框；目标模式三选（resume/fork=会话下拉、new=无需）；设置页显示会话选择器，会话 tab 固定当前会话。
  - AlarmTable：类型徽标（单次/循环/Cron）、目标列（会话标题 / 分支自… / 新会话）、免打扰徽标、jitter 显示（+≤Ns）；状态/模式筛选更新。
- **panel.tsx / session-panel.tsx**：删除"心跳默认词"输入框与默认词预填（formFromSnapshot 默认 prompt 为空）；表单状态适配新字段。
- **host-api.ts**：PanelSnapshotDto 字段更新。
- **locales.ts**：新增 类型/目标/免打扰/jitter 秒/Cron 文案；删除 wake_reason 文案。

## 10. 数据迁移（src/store.ts）

- `STORE_VERSION` 1 → 2；load 时逐条归一化（读时迁移，下次 persist 落 v2）：
  - `sessionId` → `ownerSessionId` + `target = {mode:"resume", sessionId}`。
  - `mode`：one-shot → `type:"once"`；repeat → `type:"every"`。
  - `trigger.jitter 0..1` → `jitterSeconds = round(j × everySeconds)`（仅 repeat）。
  - `wakeReason`：`"alarm"` → `respectQuietHours=false`；其余一切（heartbeat/check_in/interval/companion）→ `true`。
  - 未知 legacy 字段（如 deliveryHint）在归一化时丢弃（v2 落盘后不再保留）。
- `alarmIsValid` v2：校验 `id/ownerSessionId/type/nextDueAt`；结构异常的记录按既有 corrupt 语义处理。
- runs.jsonl / state.json 不变；PanelSnapshot server 透出 `storeVersion` 供面板显示迁移状态。

## 11. 文件级改动清单

| 文件 | 改动 |
|---|---|
| `src/domain.ts` | 删 WakeReason/AlarmMode；加 AlarmType/TargetMode/AlarmTarget/CronTrigger；Alarm v2；jitter 秒常量；toAlarmView v2 |
| `src/cron.ts`（新） | parse/normalize/validate + nextCronOccurrence + 频率护栏（~200 行） |
| `src/alarm-factory.ts` | CreateSpec v2（4 selector + jitterSeconds + respectQuietHours + target）；validateCreateArgs；buildAlarm 三类型 |
| `src/scheduler.ts` | 门控换 respectQuietHours；advance 三类型 + jitter 延迟 |
| `src/wake.ts` | 目标分派 resume/fork/new；seed 截断 helper；child 生命周期 |
| `src/framing.ts` | 删 heartbeatPrompt；wake_type/respect 文案 |
| `src/config.ts` / `src/settings.ts` | 删 heartbeatPrompt 全链路 |
| `src/store.ts` | version 2 + 读时归一化 |
| `src/tools.ts` | set/list/update_settings schema 与描述 |
| `src/panel/contract.ts` / `service.ts` | 契约 + snapshot/action 适配（run 归属、cron resume） |
| `src/client/sections.tsx` / `panel.tsx` / `session-panel.tsx` / `host-api.ts` / `locales.ts` | 表单三类型+target+respect；表格列/徽标；DTO；文案 |
| `test/*` | 全量适配 + `cron.test.ts` 新增 |

预估 ~1400-1700 LOC（含测试），单 phase，不拆。

## 12. 测试计划

- **cron.test.ts**（新）：解析（合法/越界/非法字符/步进/列表/范围/0与7周日）；求值（普通日、上海时区跨午夜、America/New_York DST 跳变日、dom/dow OR、dom 限制时 2 月 30 日跳过）；频率护栏（* * * * * → frequency_too_high）；jitter 注入 random。
- **domain.test.ts**：jitter 新语义（once/every/cron 延迟窗口 + random 注入）、视图字段、legacy view 容忍。
- **scheduler.test.ts**：门控矩阵（respect × quiet × 预算）、cron/every advance、jitter advance。
- **wake.test.ts**：目标分派（mock agents 带 create/resume；fork 截断含 open-turn 剥离；new 空 seed；cold 父走 inspect；missing → failed）。
- **tools.test.ts**：set 校验（selector 恰一、cron、respect、target、jitterSeconds ≤ every）；view 输出。
- **store.test.ts**：v1→v2 归一化（legacy wakeReason、jitter 0..1、deliveryHint 丢弃）。
- **framing.test.ts**：新文案快照。
- **panel.test.ts**：create/edit/toggle/fire 走 cron 闹钟；run 归属规则。

## 13. 验收清单（validation doc 将细化）

- **模型工具**：三类型创建成功；respect 门控差异（安静时段内 true 延迟/false 照常）；fork/new 唤醒落在新会话且 runs.jsonl 的 sessionId=子会话；list 显示新字段；旧 JSON 升级后仍可 list/edit/cancel。
- **面板**：三类型与目标模式、jitter、免打扰勾选；表格新列与徽标；配置卡无心跳词；owner 表历史能看到 fork/new 的 run。
- **实机 E2E**：① 冷会话 once resume 唤醒 reply（回归）；② fork 唤醒 → 侧边栏出现子会话（历史前缀正确）+ decision 判定；③ new 唤醒 → 新空会话出现；④ 安静时段 respect=true 延迟 / false 触发；⑤ jitter 实际生效（runs firedAt 与计划差 ≤ jitter）；⑥ 重启恢复 in-flight（回归）。
- 回归项：no_reply 静默、leaked 标记、预算日重置、boot overdue 策略。

## 14. 决策记录与风险

| # | 决策 | 理由 |
|---|---|---|
| D1 | jitter 统一为 `jitter_seconds`（计划时刻后 U(0,j) 延迟），三类型通用 | 单一可解释语义；对齐 systemd RandomizedDelaySec；线上无旧 jitter 使用 |
| D2 | `respect_quiet_hours` 默认 false | 行为对齐现状 wake_reason=alarm（用户委托提醒豁免）；模型自发循环显式给 true（等同现状显式 heartbeat） |
| D3 | cron 完全自研零依赖（官方 dsh-schedule 也无 cron；仅其调度语义作风格参考：纯函数、闭式错误码、300s 频率下限对齐 MIN_EVERY_INTERVAL_SECONDS、错拍跳过、DST 复用其移植算法） | 平台无 cron 库；保持零运行时依赖；与官方调度语义保持一致口径 |
| D4 | 日预算门控随 respect 开关 | 完全复刻现状 alarm/heartbeat 差异，行为不漂移 |
| D5 | fork/new 子会话保留为真实会话（侧边栏可见） | 目标会话模式的本意：唤醒后可继续跟进该线程 |
| D6 | wire `sessionId` 保留为 owner，新增 target 字段 | 面板过滤/排序/复制 id 零破坏；内部改名 ownerSessionId |
| D7 | cron 按 alarm.timeZone 对齐 | 缺省走会话浏览器时区/宿主时区，用户无需显式传参 |

**风险**：
1. fork 的 seed 必须过 agents.create 校验（已完成回合前缀）；live-busy 父并发读 events 概率极低，截断逻辑容忍（读时快照）。
2. `agents.create` 对新会话的 cwd 要求：fork 继承父 cwd；new 留空观察，失败时降级记录 failed（验收项⑥回归路径兜底）。
3. 安装验证需重启 dsh（中断本会话）——安排验收时段。
4. 工作区存在他人未提交 client 改动（session-tab）——实施提交用 commit-own-changes 分 hunk。
5. 面板 client 改动需要重新构建 client bundle（npm run build）并安装到 web profile 后刷新验证。

## 15. 不做的事（排除项）

- 不做 delivery 通道（chat/push/wechat）：legacy deliveryHint 随迁移丢弃（线上无依赖）。
- 不做 cron 英文月/周名、秒字段、`?`、时区偏移语法（文档注明限制）。
- 不做全局"默认尊重免打扰"配置；开关只存在每个闹钟上。
- 不做"循环=每天固定时刻"的快捷类型（cron `0 9 * * *` 可表达；面板有 cron 输入）。
- 不动 dsh-schedule 会话内提醒；不动 apps/web 外壳。