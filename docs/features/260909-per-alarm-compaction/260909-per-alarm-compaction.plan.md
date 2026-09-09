# 260909-per-alarm-compaction 计划

## 背景与需求

两个关联需求，一次交付：

1. **no_reply reason 保留**：当前静默唤醒压缩后，模型 surface 只剩 ~70B tombstone `[dsh-proactive silent wake <id> <time>]`，no_reply 的 reason 随 assistant/message eraser 一起从模型上下文消失；且 observer 没有把 reason 提取进 run history（runs.jsonl / 面板也看不到）。reason 对后续唤醒的决策连贯性有价值（让 Agent 知道"上一轮为什么静默了"），应保留。

2. **tombstone 压缩 per-alarm 可配，默认温和**：当前所有静默唤醒一律激进压缩成 70B tombstone。用户要求改成逐闹钟可配，且默认不要这么激进。

## 设计决策

### compaction 三态模型（per-alarm）

Alarm 新增必填字段 `compaction: AlarmCompaction`，值域三态：

| 值 | 行为 | tombstone 内容 | 模型 surface 残留（典型） |
|---|---|---|---|
| `off` | 不压缩，保留完整唤醒交换 | — | ~2.6KB（framing v3 ~430B + assistant + tool result） |
| `minimal`（**默认**） | 温和压缩 | `[dsh-proactive silent wake <id> <time> no_reply: <reason>]` | ~200-400B（tombstone 带 reason，擦除 assistant reasoning + tool result） |
| `aggressive` | 激进压缩（当前行为） | `[dsh-proactive silent wake <id> <time>]` | ~70-90B |

**reason 在 run history（runs.jsonl / 面板）无条件保留**，不受 compaction 级别影响——这是持久化记录，跟上下文压缩正交。

### 默认值选择理由

选 `minimal` 作为默认（而非 `off`）：用户诉求是"不要这么激进"但没说"完全不压缩"。`off` 会让高频闹钟回弹到 ~2.6KB/次污染（260908 要解决的痛点），`minimal` 既省 token 又让模型保留"上一轮为什么静默"的 reason，不至于失忆。需要完全不压缩的场景（低频、长记忆重要）可显式设 `off`；需要最省 token（每小时高频）可显式设 `aggressive`。

### reason 提取路径

`tool/call` 事件的 `data.arguments` 是 JSON 字符串（observer.test.ts:12、compact.test.ts:51 确认）。observer.analyzeWakeTurn 扫到 `name === "no_reply"` 时 `JSON.parse(arguments)` 取 `reason`，用 `truncateSummary` 截断（上限 200，与 `MAX_NO_REPLY_REASON_LENGTH` 一致），加 `noReplyReason` 字段到 WakeAnalysis。

## 逐文件改动点

### 需求 1：reason 保留

- **observer.ts**：`analyzeWakeTurn` 扫 tool/call 时，`name === "no_reply"` 从 `data.arguments`(JSON 字符串) parse reason；`WakeAnalysis` 加 `noReplyReason?: string`；返回值带上。
- **domain.ts**：`RunRecord` 加 `noReplyReason?: string`。
- **store.ts**：`listRecentRuns` 已透传 parsed 对象（push as RunRecord），无需改；`recordRun`（在 scheduler）加参数。
- **scheduler.ts**：`recordRun` 签名加 `noReplyReason?: string`，存进 RunRecord；`runWake` 的 outcome 类型 + 调用点透传。
- **wake.ts**：`WakeAnalysisResult` 加 `noReplyReason?`；`fire` 返回 analysis 时带上 `analysis.noReplyReason`；`compactWake` 接收 reason 传给 compact（见需求 2）。
- **panel/contract.ts**：`RunView` 加 `noReplyReason?: string`。
- **panel/service.ts**：RunView 映射加 noReplyReason（实施时读确认映射点）。
- **client/host-api.ts**：runs 类型加 `noReplyReason?: string`（实施时读确认）。
- 面板展示 reason 文案（client/locales + sections）：可选增强，本次至少数据通路打通。

### 需求 2：per-alarm compaction

- **domain.ts**：
  - 新增 `export type AlarmCompaction = "off" | "minimal" | "aggressive";`
  - 新增 `export const DEFAULT_COMPACTION: AlarmCompaction = "minimal";`
  - 新增 `export const COMPACTION_MODES: readonly string[] = ["off", "minimal", "aggressive"];`
  - `Alarm` 接口加 `compaction: AlarmCompaction`（必填）
  - `AlarmView` 加 `compaction: AlarmCompaction`
  - `toAlarmView` 映射 compaction
- **store.ts**：
  - `alarmIsValid`：compaction 缺 → 合法（视为待补默认）；存在但非合法值 → false
  - `load` v2 分支：对通过的 record，缺 compaction 则补 `DEFAULT_COMPACTION`（inline，不 bump STORE_VERSION）
  - `normalizeV1`：补 `compaction: DEFAULT_COMPACTION`
- **alarm-factory.ts**：
  - `CreateSpec` 加 `compaction: AlarmCompaction`
  - `validateCreateArgs`：allowed set 加 `compaction`；校验（缺=默认，非法值=invalid_trigger）；返回 spec 带 compaction
  - `buildAlarm`：`compaction: spec.compaction`
- **tools.ts**：`proactive_set` parameters 加 `compaction`（enum off/minimal/aggressive，描述默认 minimal）
- **panel/contract.ts**：`PanelCreateForm` 加 `compaction?: AlarmCompaction`；`createArgsFromForm` 映射（缺=不传，validateCreateArgs 补默认）；`AlarmRowView` 已 extends AlarmView 自带 compaction
- **compact.ts**：
  - `tombstoneText` 按 compaction 级别 + reason 渲染：
    - `off`：不调用（wake.ts 调用点拦截）
    - `minimal`：`[dsh-proactive silent wake <id> <time> no_reply: <reason>]`（reason 缺则退化成 aggressive 文本）
    - `aggressive`：`[dsh-proactive silent wake <id> <time>]`（当前行为）
  - `applyWakeCompaction` 签名加 `compaction: AlarmCompaction` + `reason?: string`，按级别决定 tombstoneText
- **wake.ts**：`compactWake` 签名加 `compaction` + `reason`；调用点 `if (analysis.decision === "no_reply" || analysis.decision === "failed") { if (alarm.compaction !== "off") this.compactWake(agent, startIndex, alarm, firedAt, alarm.compaction, analysis.noReplyReason); }`

## 测试计划

- **observer.test.ts**：加 reason 提取测试（tool/call arguments JSON 含 reason → noReplyReason；缺 reason → undefined；malformed JSON → undefined）
- **compact.test.ts**：加三态 tombstone 测试
  - `off`：applyWakeCompaction 不 append（返回 false）
  - `minimal`：tombstone 文本含 `no_reply: <reason>`；assistant/tool 仍 eraser
  - `aggressive`：tombstone 文本只有 id+time（当前行为，回归）
  - `minimal` reason 缺：退化成 aggressive 文本
- **domain.test.ts**：buildAlarm 默认 compaction=minimal；显式 off/aggressive
- **store.test.ts**：老记录（缺 compaction）load 后补默认 minimal；非法 compaction 值 → corrupt
- **alarm-factory / tools / panel.test.ts**：validateCreateArgs 接受 compaction；非法值拒绝；createArgsFromForm 映射

## 迁移与兼容

- STORE_VERSION 保持 2（compaction 是 v2 增量字段，缺=默认，不破坏结构）
- 老 alarms.json 缺 compaction → load 补默认 minimal，下次 persist 写回完整字段
- 老会话用 proactive_set 不传 compaction → 默认 minimal
- 面板表单缺 compaction → createArgsFromForm 不传 → validateCreateArgs 补默认

## 风险

- tombstone 带 reason 会增加 ~reason 长度（≤200B）。minimal tombstone ~70+reason 字节，可接受。
- `off` 模式回弹污染：用户显式选择，非默认，可接受。
- compaction 字段必填但磁盘老记录缺——alarmIsValid 宽容 + load 补默认，类型安全。
- 工具参数新增 enum：模型/面板/文档三处同步（alarm-factory allowed set、tools parameters、panel form）。

## 验证

单测覆盖：reason 提取（observer）、三态 tombstone（compact）、默认值与迁移（store/domain）、参数校验（alarm-factory/tools/panel）。

实机验证（待重启 dsh，单测无法覆盖真实 agent-loop）：
1. 设 compaction=minimal 闹钟 + prompt"没事就 no_reply，reason 写明原因"，触发 → 后续回合让模型复述 tombstone，应能看到 reason
2. 设 compaction=off 闹钟，静默触发 → 唤醒交换完整保留在上下文
3. 设 compaction=aggressive 闹钟 → tombstone 只有 id+time（回归当前行为）
4. 面板 run history 显示 noReplyReason
