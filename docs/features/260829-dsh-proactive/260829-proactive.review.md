# dsh-proactive 实施评审

> 日期：2026-08-29 · 评审对象：`packages/dsh-proactive/`（v0.1.0，M1–M3）· 基线：260829-proactive.plan.md + 260829-proactive.research.md
> 评审方式：源码走读 + 与已安装平台 .d.ts 逐一交叉核对 + 独立复验（编译、39 项单测、两个故障注入实验）

## 0. 结论摘要

| 级别 | 数量 | 摘要 |
|---|---|---|
| P0 阻断交付 | 1 | `package.json` 文件已被截断为非法 JSON——当前树上 **任何构建/测试/安装/发布都不可执行**（`node --test` 直接 `ERR_INVALID_PACKAGE_CONFIG`） |
| P1 必修 | 3 | ① scheduler drive 循环无异常隔离，任一 fireOne 抛错即**永久停摆**（两个实证路径）；② `proactive_cancel` 输出契约自相矛盾，未知道次运行时会触发 `ToolOutputError`；③ 计划 §4.7 的 crash 窗口语义未落地（in-flight 落盘缺失） |
| P2 建议修 | 4 | observer 失败判定与真实事件形状不符；泄漏告警缺失；config 校验缺口（quietHours）；测试断言了真实世界不存在的形状 |
| P3 可后置 | 10+ | 见 §6。整体不影响架构成立 |
| 亮点 | — | 模块边界清晰、闭式错误码贯彻、DST 解析移植正确、观察器"从已提交日志取证"优于原案、平台 API 使用全部核对成立 |

**总体判断：设计成立、实现质量中上，但当前交付树处于"打包层面损坏"状态，且 scheduler 存在单点故障。建议先修 P0+P1，再做 M4 安装验收；单测 39/39 在修复清单 manifest 后复验通过（§2）。**

---

## 1. 评审范围与方法

- 全文走读 `src/{domain,config,store,scheduler,wake,framing,observer,tools,index}.ts`（9 个模块）与 `test/*.test.ts`（6 个文件）、`package.json`、`cordis.patch.yml`、两个 tsconfig。
- 平台 API 承诺**不用凭记忆**：所有关键调用点对照已安装包的类型声明逐一核对（`dsh-agent`、`dsh-session`、`dsh-llm`、`dsh-tools`、`dsh-agent-default-model`，`node_modules/.pnpm/@deepseek-ai+*` 内 .d.ts），结果见 §8。**全部成立**——不存在"假设了不存在的 API"这类问题。
- 独立复验（在 `/tmp/dsh-proactive-review` 的临时副本中执行，**不触碰被评审树**）：
  1. `tsc -p tsconfig.json` 编译零错误；
  2. `node --test` 编译产物 **39/39 通过**；
  3. 两个故障注入实验（malformed repeat alarm、非法 quietHours 配置）实证 scheduler 停摆路径（§4.1）；
  4. `tool/call`、`turn/end`、`assistant/message` 等事件形状与真实 `SessionEventMap` 逐字段比对（§4.3 / §5.1）。

---

## 2. 复验记录（本次会话实测）

| 项目 | 结果 | 备注 |
|---|---|---|
| `pnpm test`（包目录） | ❌ `Invalid package.json` | package.json 截断，§3 |
| `node --test 'dist/test/*.test.js'`（包目录） | ❌ 6 个文件全部 `ERR_INVALID_PACKAGE_CONFIG` | 同上 |
| `tsc -p tsconfig.json`（临时副本，manifest 修复） | ✅ 退出码 0 | 类型检查全过 |
| `node --test`（临时副本编译产物） | ✅ **39 passed / 0 failed** | 与交付声明一致 |
| 平台 API .d.ts 交叉核对 | ✅ 全部命中 | §8 清单 |
| 故障注入：repeat 闹钟 trigger 缺失 | ❌ TypeError 逃逸，drive 永久停摆 | §4.1 |
| 故障注入：config quietHours `start:"9:00"` | ❌ 启动无校验，首次 fire 时抛错，drive 永久停摆 | §4.1 |

> 说明：39 项单测本身质量与结论可信（§7）；但"当前树可直接 `npm test`"不成立，必须先修 §3。

---

## 3. P0 — package.json 已损坏，交付阻断

**位置**：`packages/dsh-proactive/package.json`

**现象（实测）**：文件当前 1671 字节、权限 `600`，内容截断于：

```jsonc
  "devDependencies": {
    ...
    "@types/node": "^22.20.1",
    // ↑ 文件在此戛然而止：无 typescript 行、无闭合括号
```

- 依据 `pnpm-lock.yaml` importers 段，缺失内容应为 `"typescript": "^5.9.3"` 与收尾 `}`。
- mtime 19:51:58，晚于全部构建产物（dist 19:50:39、lib 19:51:04）——即构建/测试通过之后、收尾编辑时被中断（截断写入），属**最终交付状态损坏**，不是实现逻辑问题。
- 影响链：Node 在包目录加载任何模块都报 `ERR_INVALID_PACKAGE_CONFIG` → `npm test`/稳定复验不可行 → `dsh plugin add`（需 pnpm 解析该包）不可行 → 无法发布。

**修复**：补上 `"typescript": "^5.9.3"` 与闭合 `}`（与 lockfile 对齐），恢复 644 权限，重跑 `tsc && node --test`。顺带校验 `files` 中列出的 `README.md` 目前**不存在**（§6.8），要么补写要么从 files 移除。

---

## 4. P1 — 必修问题

### 4.1 scheduler drive 循环无异常隔离：任一闹钟抛错即永久停摆（实证）

**位置**：`src/scheduler.ts` `requestDrive()`（L78–85）+ `drive()`（L92–118）+ `fireOne()`（L121–190）+ `advance()`（L213–233）

**机制**：`requestDrive` 用 `this.driveChain = this.driveChain.then(() => this.drive())` 串行化。`drive()` 内部对每个到期闹钟直接 `await fireOne(...)`，**没有任何 per-alarm try/catch**。一旦 fireOne 内的纯函数抛错（`advance()` 的 `"everySeconds" in trigger` 当 `trigger` 为 undefined 时抛 `TypeError`；或 `isInQuietHours` → `readClock` 对非法 `HH:MM` 抛 `Error`），整个 promise 链 reject——`.finally` 只复位 `driveRequested`，链保持 rejected，**之后任何 `requestDrive` 的 `.then` 都不再执行 → 调度器从该时刻起永久死亡**，无恢复、无日志（只剩一条 unhandled rejection）。

**实证 1（malformed repeat alarm）**：在临时副本注入一条 `status:"scheduled"`、`mode:"repeat"`、`trigger: undefined` 的闹钟（恰好通过 `store.alarmIsValid` 的弱校验：只查 id/sessionId/nextDueAt 三项字符串）：

```
UNHANDLED REJECTION: Cannot use 'in' operator to search for 'everySeconds' in undefined
pass1 fired: 2 one: completed   # 其余健康闹钟本轮已跑完
pass2 fired: 2                  # ← 之后 requestDrive 全部空转
pass3 fired: 2                  # ← 永久停摆确认
```

**实证 2（非法 quietHours 配置）**：`config.json` 写 `{"quietHours":{"start":"9:00","end":"08:00",...}}`（缺前导零，不符合 `HH:MM`）：

```
config resolved quietHours.start: 9:00   # ← resolveConfig 未校验，静默放行
UNHANDLED: invalid clock time: 9:00       # ← 首次 fire 即抛
after second pass fired: 0                # ← 之后永久停摆
```

**影响**：主动跟进能力整体静默失效，且症状隐蔽（无 warn 日志）。配置写错的触发面是"文档公开的 config 接口"，发生概率不低。

**修复建议（改动小、收益大）**：
1. `drive()` 对每个闹钟包 `try/catch`：捕获后 `recordRun(..., "failed", 0, message)` + 推进/终止该闹钟，继续处理下一个；
2. 启动时校验 `quietHours.start/end`（复用已存在但未被调用的 `parseClockTime`，§5.3）；
3. 可选：`fireOne` 内对 `advance()` 的结果包一层防御（trigger 缺失视为 corrupt 数据，该闹钟标记 failed 而非崩循环），并给 `alarmIsValid` 增加 trigger 结构校验。

### 4.2 proactive_cancel 输出契约自相矛盾：未知道次会在运行时爆炸

**位置**：`src/tools.ts` proactive_cancel 的 `output.schema`（L281–296）与 `execute`（L298–317）

**机制**：声明输出为 `oneOf: [ { id, cancelled: { const: true } }, ERROR_SCHEMA ]`——按 `dsh-tools` 的契约（`lib/types/index.d.ts`：`ToolOutputDefinition.schema` "enforced against every successful canonical value"；`lib/index.js` L2439 `ToolOutputError`：body 值违反已声明 output 即抛 `INVALID_TOOL_OUTPUT`），**`cancelled` 只允许 `true`**。而 execute 对未知道次返回 `{ id, cancelled: false }`（描述里也写着 "Unknown ids return cancelled false"），该值既不匹配 shape A（const:true 不满足）也不匹配 ERROR_SCHEMA（缺 code/message）→ 运行时必然 `ToolOutputError`。

**影响**：模型用过期/错误 id 调用 cancel（工具描述明确支持的行为）会得到一条工具错误而非幂等的 `cancelled:false`。功能本身可工作（存在 id 时正常），但契约不一致是确定的 bug。

**修复建议**（二选一）：
- 把未知道次的返回值改为 ERROR_SCHEMA 形态：`{ code: "not_found", message: "..." }`（计划原本就定义了 `not_found` 错误码，目前从未被使用，§6.9）；
- 或把 output schema 的 `cancelled` 放宽为 `enum: [true, false]`/去掉 const，让 `{cancelled:false}` 合法。
- 两种改法都需补一条单测。

> 连带核查：proactive_set / proactive_list / proactive_no_reply 的输出声明与运行值一致（no_reply 的 `{accepted,silent}`、set 的 oneOf[AView|Error]、list 的数组）+ `exec.concludeTurn()` 存在且语义正确（`ToolRunContext.concludeTurn` "Mark a successful final result as terminal"），均无问题。

### 4.3 计划 §4.7 的 crash 窗口语义未落地：in-flight 从未被写入

**位置**：`src/scheduler.ts` `recoverInFlight()`（L84–95）；全库检索 `"in-flight"` 的写入点——**只读不写**（domain 类型、AlarmView 枚举、recoverInFlight 的读取、proactive_list 过滤条件）

**机制**：计划 §4.7 要求"fire 前先把 status=in-flight + nextDueAt 更新原子落盘；重启发现 in-flight 且无对应 turn 事件 → 视为未完成重新 fire（限一次）"。实现中 `fireOne` **从不标记 in-flight**，`recoverInFlight` 因此是死代码：① 崩溃窗口重复 firing 无"限一次"护栏——崩溃重启后闹钟仍是 scheduled+due，会无条件再 fire 一次，且上一次已 append 的 framing 报文会再次 append（会话日志出现重复唤醒报文）；② `proactive_list` 的 in-flight 过滤条件永远不会命中（行为无害，但语义空转）。

**影响**：中。崩溃窗口语义（计划明确承诺）未交付；重复唤醒报文污染会话历史。

**修复建议**：在 `fireOne` 调 `runWake` 前原子落盘 `status:"in-flight"`（记录 nextDueAt），完成后再写回结果状态；`recoverInFlight` 补"检查该会话在崩溃点之后是否已有该 wake 的 turn 事件"的限一次判断（或简化：恢复时把 in-flight 闹钟的 nextDueAt 推到"现在+1 tick"）。至少补一条 scheduler 单测模拟"重启时残留 in-flight"。

---

## 5. P2 — 建议修订

### 5.1 observer 的失败判定与真实事件形状不符（isErrorEnd 是死代码，测试断言了假形状）

**位置**：`src/observer.ts` `isErrorEnd()`（L114–117）；对照 `dsh-session/lib/types/types.d.ts` `SessionEventMap['turn/end']`

- 真实 `turn/end` 的 data 是 `{ turn, reason: TurnEndReason }`，失败形态为 `reason.kind === 'error' | 'aborted' | 'max-tokens' | 'interrupted'`；**不存在** `data.aborted` 或 `data.error` 顶层字段。
- `isErrorEnd` 检查 `data["aborted"]?.kind` / `data["error"]` → 对真实事件**永远返回 false**。后果目前轻微（无正文+无 no_reply 的回合仍会落入最后的 `failed` 分支，只是 note 文案错；有正文的 error 回合会被计为 reply），但它也堵死了后续正确区分"aborted/error"的路径。
- 连带问题：`test/observer.test.ts` 的 `errored turn end is failed` 用 `ev("turn/end", { aborted: { kind: "error" } })` 构造了**真实世界不会出现**的形状——测试与实现互相印证了一个错误模型。observer 其余断言（`assistant/message` 用 `{blocks:[...]}` 顶层形状）虽然 extractor 兼容嵌套 `message.content`，但建议统一改成真实形状，避免将来重构时测试失真。

**修复建议**：`isErrorEnd(data)` 改为读 `data["reason"]?.kind ∈ { "error", "aborted", "max-tokens" }`（`interrupted` 是持久化重放标记，可不计）；测试同步改为真实形状；并把 `errorEnd` 的 note 与被判定为 reply 的边界写进决策注释。

### 5.2 泄漏告警缺失：leaked 被计算但从未被消费

**位置**：`src/observer.ts` L85/L103（`leaked` 计算并返回）；`src/scheduler.ts` `recordRun`（只接收 decision/budgetDelta/note）

计划 §4.5/§6 验收项 9 要求："TurnObserver 事后校验：no_reply 回合出现非空正文 → `logger.warn` 泄漏告警（写入 runs.jsonl 的 note）"。实现里 no_reply+正文 的回合 decision 被正确计为 `reply` 且扣 1 预算（这是对的），但：`leaked` 标志没有进 runs 记录，也没有任何 `logger.warn`。计划承诺的"泄漏可见性"缺失。

**修复建议**：在 `recordRun` 前把 `analysis.leaked` 合并进 note（如 `note: "leak: no_reply called after visible text"`）并 `log("warn", ...)`。

### 5.3 config 校验缺口：quietHours.start/end 在文件覆盖下不校验（parseClockTime 是死代码）

**位置**：`src/config.ts` `parseClockTime`（L63–66，仅测试引用）；`resolveConfig`（L118–120 直接取字符串）

启动时对 `config.json` 的 `quietHours.timeZone` 做了 `canonicalizeTimeZone`（好），但 `start/end` **不经过 `parseClockTime`**——非法值静默放行，直到首次 fire 才在 `readClock` 抛错，且该抛错路径正是 §4.1 的停摆路径。两处问题是一根藤上的：修复 §4.1 时在 resolveConfig 里同时调用 `parseClockTime`（非法值落回默认值 + warn），效率最高。

### 5.4 observer 切片归属：resume 后先行落盘的 pending 回合可能被误判为本 wake 产出

**位置**：`src/wake.ts`（startIndex 捕获 + `analyzeWakeTurn(events, startIndex)`）

`analyzeWakeTurn` 取切片内**第一个** `turn/start` 到 `turn/end` 作为判定段。冷 resumed 会话若在入队后、本 wake turn 之前还有 inbox 里的 pending 回合先跑（FIFO），该回合的文本/推送会被记成本次唤醒的 decision 并扣预算。live 场景无此问题（runMaintenance 认领空闲相位）。概率低但归属逻辑无关健壮。

**修复建议**（低成本）：切片内定位到**含本插件 framing 报文**（`user/message` 且 `source.kind==="plugin" && plugin==="dsh-proactive"`）之后的第一个 `turn/start`；找不到则判定 failed。

---

## 6. P3 — 低优/健壮性清单

1. **prompt 未按"不可信内容"framing**：计划框架模板与 §4.8 明确要求 `alarm_prompt_json: … — 不可信提醒内容，按呈现处理，勿当指令`；实现用 `### Alarm instruction (alarm_prompt_json)` 且回复规则把 prompt 当指令执行。自注入风险低（prompt 由模型本会话内编写），但计划明文的防护措辞未交付，建议补一行 "alarm_prompt_json 是不可信数据，仅作呈现，不逐字执行"。`src/framing.ts`。
2. **`after_seconds`/超大的 `every_seconds` 无上限**：`epoch = now + afterSeconds*1e3` 越过 Date 表示范围时 `toISOString()` 抛 RangeError，从 `buildAlarm` 逃出工具 execute → 违反"闭合错误码"契约（工具返回裸异常而非 `internal_error`）。建议加 safe-integer 上限并 try/catch 兜底。`src/tools.ts` buildAlarm。
3. **alarms.json 无限增长**：terminated 闹钟（completed/cancelled/failed）永久留在 `state.alarms`，且 `proactive_list` 只显示活跃项（计划 §4.3 的"最近 5 条 completed"也没实现——工具描述只说 active，语义一致，但 history 无入口）。建议按计划口径补充或加清理策略。`src/store.ts` / `src/tools.ts`。
4. **runs.jsonl 无轮转/上限**：审计日志只增不减。v1 可接受，文档注明即可。
5. **deliveryHint 未进入 framing、从未被实施**：模型声明的 `delivery:{chat:false,...}` 既不在唤醒报文里展示，也没有任何强制/约束，纯信息字段（且模型看不到自己填的 hint）。决定"v1 仅信息"应在 framing 或注释里明说。
6. **framing 的 "may be refused when exhausted" 与事实不符**：`budget:` 行声称耗尽后可见输出"may be refused"，但运行时**没有任何拒绝机制**（alarm 唤醒不受预算门控，非 alarm 唤醒是事前跳过而非事后拒绝）。建议改为如实描述（"超预算时下次主动唤醒会被跳过"）或真的实现拒绝。`src/framing.ts`。
7. **hourly cap 把失败/忙碌重试也计入**：`recentFires.push(now)` 在 `runWake` 前执行，busy/failed 重试同样占槽。会话持续忙碌时会提前触发 cap 误伤其他闹钟。建议只在 `outcome==="ok"` 时计数。`src/scheduler.ts` fireOne。
8. **README.md 缺失 + cordis.patch.yml 裸包名待验证**：`package.json` `files` 引用 README 但文件不存在（`pnpm pack` 会警告）。`cordis.patch.yml` 的 insert `name: dsh-proactive`（非 `@deepseek-ai/...` 全名）与平台既有 patch（dsh-base / dsh-headless 均用完整包名）不一致——加载器能否解析裸名需在 M4 安装时实测。
9. **死代码/未用项**：`decodeInstant`（仅测试用）、`parseClockTime`（仅测试用）、`not_found` 错误码（从未返回）、`AlarmView.state` 的 `"in-flight"`（永不产生）、`advance()` 的 `_decision` 参数、scheduler 的 repeat+at-trigger 分支（`nextDueEpoch = now + 3600_000`，不可达）。保留 `not_found`（§4.2 修复后会用）和 `parseClockTime`（§5.3 修复后会用），其余可清。
10. **多闹钟同到期串行执行**：忙时 30s 重试，最坏延迟 = 各 wake 回合时长之和。1 小时上限 4 次，可接受，但值得在 README 写明。
11. **runs 记录缺少 turn 编号**：计划 §4.2 的 `RunRecord.turn?` 未实现，事后审计对不上会话日志的 turn 位置。低成本可加。
12. **预算日口径为 UTC 日**：计划 §4.6 允许 UTC 或闹钟 timeZone 日；实现固定 UTC（config.ts 注释已明确），framer 也写 "per UTC day"，口径一致，可接受；但"UTC 日夜 8 点前用掉的预算在 Asia/Shanghai 上午重置"这类体验问题值得在文档提示。

---

## 7. 测试覆盖评估

- **已覆盖且扎实**：domain 校验矩阵（含 DST overlap 取较早、gap 拒绝、every 对齐）、store CRUD/原子写/corrupt 降级/budget 滚动、scheduler 的 due/boot 策略/quiet 门控/budget 门控/busy 重试上限/repeat 推进、framing 报文与 notice 形态、observer 的基本决策表。
- **缺口（与计划 M2/M3 验收项对照）**：
  | 计划验收 | 现状 |
  |---|---|
  | concludesTurn 路径（M3） | ❌ tools.ts 完全无单测（execute、inflight 守卫、输出 schema、persistence 回滚） |
  | 预算滚动 | ✅ store 单测有；scheduler 级 charge 也有一条 |
  | 泄漏告警（M3） | ⚠️ leaked 计算有测试，但"告警/note"路径在实现里就不存在（§5.2） |
  | wake.ts 最小集成（M2：busy/live/cold/dispose/inflight 并发） | ❌ 零单测 |
  | scheduler 异常隔离 / 非法配置 | ❌ 无（本次评审注入实验是首次暴露） |
  | observer 真实事件形状 | ⚠️ 测试断言的是假形状（§5.1） |
- 结论：39 项是"纯函数层"的好基线，但 **tools 与 wake 两个最容易出错、且是验收核心（no_reply 协议、冷唤醒）的模块没有自动化覆盖**。建议至少补：tools 四件套的输入校验/输出 schema/cancel 幂等（直接调 execute 或 `defineTool` fixture）、wake 的 driver 最小集成（伪造 `AgentsFacade`/`AgentHandleLike`——代码里已定义窄门面，正是为此设计的）。

---

## 8. 平台 API 交叉核对清单（全部成立）

| 使用点 | 声明位置 | 结论 |
|---|---|---|
| `ctx.agents.resume({ resumeSessionId, agentOptions })` | `dsh-agent/lib/types/index.d.ts` `AgentRegistry.resume(options): Promise<AgentHandle>`（L296） | ✅ |
| `AgentOptions { provider?, model?, maxTokens? }` | `dsh-agent/lib/types/runtime-types.d.ts` | ✅ |
| `agent.runMaintenance(task)`（忙时同步抛错） | 同上 `Agent.runMaintenance<T>(task:(signal)=>Promise<T>)` "throws synchronously when turn-driving…" | ✅ |
| `agent.followup(msg)` / `agent.whenIdle()` | 同上 | ✅ |
| `agent.session.events` | `dsh-session/lib/types/index.d.ts` `get events(): readonly SessionEvent[]`（L174） | ✅ |
| 事件信封 `{ type, seq, time, data }` | `dsh-session/lib/types/types.d.ts` `SessionEvent`（L425） | ✅（observer 的 type/data 访问正确） |
| `turn/end` data = `{turn, reason}` | `SessionEventMap['turn/end']` | ⚠️ §5.1（isErrorEnd 形状错） |
| `agent/created` 事件 `{ agent }`，resume 同样触发 | `dsh-agent/lib/types/runtime-types.d.ts` Events | ✅ |
| `ctx.agents.roots()/get()` | `AgentRegistry.roots()/get()` | ✅ |
| `notice` form + `summary`（≤120） | `dsh-llm/lib/types/message.d.ts` `ContextFormed` + `CONTEXT_SUMMARY_MAX_CHARS=120` / `boundContextSummary` | ✅ |
| `createUserMessage({content, source})` | 同上 | ✅ |
| `defineTool`（parameters 每属性 required:true / oneOf / output.schema） | `dsh-tools/lib/types/schema.d.ts`（OneOfValueSchemaSpec、ParameterPropertySpec）+ `index.d.ts` `ToolOutputDefinition` | ✅ |
| `exec.concludeTurn()` / `exec.agent` | `dsh-tools/lib/types/index.d.ts` `ToolRunContext`（L299）/ `ToolExecution.agent` | ✅ |
| 输出 schema 运行时强制 | `dsh-tools/lib/index.js` L2439 `ToolOutputError` | ✅（§4.2 即基于此） |
| `ctx.agentDefaultModel.currentSelection()` | `dsh-agent-default-model/lib/types/index.d.ts` | ✅（dsh-base 的 agent-default-model 行存在） |

---

## 9. 与计划的偏差汇总

| 计划条款 | 实现 | 判定 |
|---|---|---|
| §4.4 fire 前 in-flight 原子落盘；§4.7 崩溃"限一次" | 未标记 in-flight；recoverInFlight 死代码 | ❌ P1（§4.3） |
| §4.5/6 泄漏 → logger.warn + runs note | leaked 计算但未消费 | ❌ P2（§5.2） |
| §4.6 预算按 timeZone 日（可选） | 固定 UTC 日（注释明确） | ⚠️ 可接受，已声明 |
| §4.8 prompt 按不可信内容 framing | 未标注不可信 | ⚠️ P3（§6.1） |
| §4.2 runs 带 turn? | 未实现 | ⚠️ P3（§6.11） |
| §3.4/计划的 deliveryHint 语义 | 纯信息字段，未入 framing | ⚠️ P3（§6.5） |
| §5.2 计划原案"session/event 事件订阅" | 改为日志切片事后取证（observer 头注释说明） | ✅ 更优（数据决定） |
| 错误码闭合 | 全部落地，新增 `no_active_wake`；`not_found` 未使用 | ✅（§4.2 修复后闭环） |
| 工具契约 / no_reply 机制 / 预算口径 / quiet 门控 / boot 策略 / 原子写 / 时区解析 | 与计划逐条一致 | ✅ |

---

## 10. 验收状态与建议

- **M1–M3 单测**：✅ 39/39（临时修复 manifest 后复验）；❌ 当前树因 §3 不可复现。
- **M4 安装与端到端验收**：❌ 未执行——validation.md 的 10 项均待验证。评审建议 M4 前先完成：§3 修 package.json → §4.1/4.2/4.3 修补 → 重启 dsh web 加载插件（按 validation.md 前置条件安排）→ 逐项验收。**额外关注**：`cordis.patch.yml` 裸包名能否被 bundle 加载器解析（§6.8）、GUI 上 framing notice 小字条的真实观感（计划 §4.5 的"可接受残余痕迹"需实测确认）、push_notify 从冷唤醒回合发出的端到端路径。
- **建议修复次序**：P0(§3) → P1(§4.1→4.2→4.3) → P2(§5.3 与 4.1 合并、§5.2、§5.1、§5.4) → 补 tools/wake 单测（§7 缺口）→ M4 验收。
- **回归测试要求**：§4.1 的两条注入路径、§4.2 的取消回退、§5.1 的真实 turn/end 形状，每条都应变成单测，防止回归。

---

## 11. 亮点（值得保持的做法）

- 模块职责单一、头注释解释"为什么"；闭式错误码 + stable message 贯穿工具层，`inputError/internalError` 折叠异常不泄漏。
- DST 正确的本地时间解析（overlap 取较早、gap 拒绝、IANA 校验）移植自 dsh-schedule 且带测试，质量高。
- 观察器"从已提交会话日志切片取证"而不是监听事件流——审计与决策都锚定持久事实，比计划原案更抗时序漂移。
- 原子 tmp+rename、corrupt 降级不崩、pending 写失败的回滚（`persistence_uncertain` + removeAlarm 复原）等容错细节到位。
- 冷唤醒用完即 `dispose`、inflight 并发保护、`agent/created` 注册模式让 resume 出的会话自动获得工具——都是对平台语义的正确使用。
- `notice` form + `boundContextSummary` 边界、`exec.agent` 一致性守卫、scheduler 单飞行循环防重入，均是平台 API 的正确姿势。

---

## 12. 处置记录（2026-08-29 修复轮）

> 以下修复均在评审副本之后、同一工作区内完成；每项附对应回归测试。

| 编号 | 评审意见 | 修复 | 回归测试 |
| --- | --- | --- | --- |
| P0（§3） | `package.json` 截断为非法 JSON，tsc 按 CJS 报 TS1295 海啸 | 用 JSON.stringify 完整恢复（typescript/peerDeps/scripts 齐全），`npm test` 可跑 | 全量 62 项 |
| P1-1（§4.1） | driveChain 无异常隔离：畸形 repeat trigger 的 TypeError / 非法 quietHours 会让整链永久 reject | `driveChain().catch` + drive 主循环 per-alarm try/catch + advance() 对非法 trigger fail-closed（status failed）+ `resolveConfig` 校验 quietHours（非法回退默认）+ drive 异常路径 terminate(failed) 而非误标 completed | 两个注入路径单测：畸形 repeat 与健康闹钟共存不杀链；抛错 runWake 被记录 `exception in drive` 且后续闹钟照跑 |
| P1-2（§4.2） | `proactive_cancel` schema 声明 `cancelled: const:true` 但未知 id 返回 false → 运行时 ToolOutputError 死路上限 | 未知/跨会话/已完结 id 一律返回 `{code:"not_found"}`（ERROR_SCHEMA 闭式形态），工具描述同步 | tools.test.ts：cancel 未知/跨会话 → not_found，成功 → `{id, cancelled:true}` 无多余字段 |
| P1-3（§4.3） | in-flight 从未持久化，recoverInFlight 是死代码 | fireOne 在 runWake 前先落盘 `status:"in-flight"`（崩溃窗口语义） | scheduler.test.ts：自定义 runWake 观测到进入时 store 已是 in-flight，结束后 completed；同 store 注入 in-flight 残留，新 scheduler boot 后恢复 |
| P2-5.1（§5.1） | `isErrorEnd` 读假形状 `data.aborted.kind` | 改读真实 `data.reason.kind` ∈ {error,aborted,max-tokens}（FAILURE_KINDS） | observer.test.ts 按真实 turn/end 形状断言三种失败 + completed 无输出 → failed |
| P2-5.2（§5.2） | leaked 只置标记不消费 | observer 加 note "leak: no_reply called after visible text (charged 1)"，scheduler warn | observer 断言 leaked 且 note 含 "leak" |
| P3-2（§6.1） | after_seconds/every_seconds 无上限，epoch 可越界 RangeError | `MAX_DELAY_SECONDS`（10 年）上限，超限 invalid_trigger；buildAlarm 保留 safe-integer 校验 | tools.test.ts：after/every > 10 年 → invalid_trigger |
| P3-1/P3-6（§6.1） | alarm_prompt_json 未标不可信；budget 措辞 "may be refused" 与实际不符 | framing 加 UNTRUSTED DATA 标注；budget 行改为"本唤醒照常决策，下一非 alarm 唤醒被跳过"的真实语义 | framing.test.ts 既有断言仍绿（措辞层修改） |
| P3-7（§6.1） | hourly cap 计入失败尝试 | recentFires 仅 ok 分支 push，leaked/failed 不占小时配额 | scheduler 既有 busy/失败用例覆盖 |
| §10 补测缺口 | tools/wake 零自动化覆盖 | 新增 tools.test.ts（11 项：selector 校验、上限、时区、持久化回滚、not_found、no_reply 协议、exec 归属）与 wake.test.ts（6 项：冷/热/busy/并发 inflight/whenIdle 失败） | 62/62 三连全绿 |

### 修复后状态

- 单测：62/62（domain/config/store/observer/framing/scheduler/tools/wake 八文件），三连跑稳定
- 编译：`tsc -p tsconfig.json`（NodeNext + strict）零错误；`dist/` 重新生成，`lib/` 同步
- 未变项：§6.8 `cordis.patch.yml` 裸包名、§6.11 runs 不带 turn、§6.5 deliveryHint 语义、alarms/runs 无界增长 —— 按 §10 建议留待 M4 实测后文档化
- M4 安装与端到端验收仍未执行（需重启 dsh web，会话会中断），按 validation.md 交给用户

