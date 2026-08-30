# dsh-proactive 唤醒摘要 + P3 修复复检评审

> 日期：2026-08-29 · 评审对象：复检轮全部工作区改动（上轮「准入」后的新一轮：用户新需求「最近唤醒显示推理+回复摘要」+ 四项上轮 P3 遗留修复）· 基线：上轮评审结论 + 用户新需求（面板 runs 区块展示模型唤醒回合的 reasoning 与回复摘要，帮助理解模型决策过程）

## 0. 结论摘要

| 级别 | 数量 | 摘要 |
|---|---|---|
| P0 阻断交付 | 0 | — |
| P1 必修 | 0 | — |
| P2 建议修 | 0 | — |
| P3 可后置 | 5 | ① 摘要落盘端到端链路（recordRun→runs.jsonl→listRecentRuns→RunView）无直接测试（observer 5 项只测到 analyzeWakeTurn 输出，链路仅经代码走读+实证确认）；② config.test.ts 未覆盖 heartbeatPrompt 超长 slice；③ change list 说「trim + slice」，实现只 slice（trim 仅做非空判断，值与 settings schema 一致不 trim——行为自洽，属描述微差）；④ truncateSummary 按 UTF-16 截断可能切半 surrogate pair（emoji 尾部显示 ，200 字符展示边界可接受）；⑤ `AlarmView.wakeReason` 类型诚实性注释维持 TODO（上轮即定为可选，面板/输出 schema 均容忍 legacy） |
| 亮点 | — | 平台块类型核对成立（ReasoningBlock{type:'reasoning';text}）、事件形状核对成立、摘要链路全贯通（观察→透传→落盘→面板）、旧记录零迁移兼容、四项 P3 修复到位、验证声明全部实测通过 |

**总体判断：用户新需求「唤醒摘要」实现正确——从真实会话事件形状（`assistant/message` 的 `message.content` 内 reasoning/text 块）提取、截断、透传、落盘、面板展示全链路核对成立，兼容旧 runs 记录（"—"）且 skipped/failed 路径不产生摘要字段。四项上轮 P3 修复均落实。未发现 P0–P2 问题，剩余 5 项 P3 均为文档/测试补强级——结论：准入。**

---

## 1. 复检范围与方法

- **本轮文件**：`src/{observer,domain,wake,scheduler,framing,config}.ts`、`src/panel/{contract,service}.ts`、`src/client/{host-api,panel.tsx}.tsx`、`test/observer.test.ts`、`README.md`、`docs/features/260829-dsh-proactive/260829-proactive.validation.md`、`docs/features/260829-proactive-gui-panel/260829-proactive-gui-panel.summary.md`。
- **平台类型核对**（以 .d.ts 为准）：dsh-llm `ReasoningBlock { type:'reasoning'; text:string }`、dsh-session `'assistant/message': { turn, step, message: AssistantMessage, usage?, interrupted? }`（`AssistantMessage.content` 为 `ContentBlock[]`）。
- **独立复验**（包目录实测）：`npm run check` ✅；`npm test` ✅ **82/82**；`npm run build` ✅（client bundle 16.3kb）；两个端到端实证脚本（真实形状事件 → analyzeWakeTurn；recordRun 装配 → appendRun → listRecentRuns round-trip）见 §3。

---

## 2. 复验记录（本次会话实测）

| 项目 | 结果 | 备注 |
|---|---|---|
| `npm run check` | ✅ 退出码 0 | tsc --noEmit（src+test） |
| `npm test` | ✅ **82 passed / 0 failed** | 77（上轮）+ 5 新增（observer）= 82，README/validation.md/summary.md 数字一致 |
| `npm run build` | ✅ 退出码 0 | lib/ 完整，client bundle 16.3kb |
| 实证：真实事件形状 → analyzeWakeTurn | ✅ | decision=reply、leaked=true、replySummary 原样、reasoningSummary 201 字符带「…」、truncate 短文本 trim |
| 实证：recordRun 装配 → 落盘 → 读回 | ✅ | 新记录两字段 round-trip 成立；旧记录（无字段）两字段为空→面板「—」；落盘无 undefined 键 |
| 平台 .d.ts 核对 | ✅ | reasoning 块形态、assistant/message 事件形状均与 observer 提取逻辑一致 |

---

## 3. 新功能① — 唤醒摘要（reasoning + reply）

### 3.1 提取层（observer.ts）

- `extractReasoningBlocks`：与 `extractTextBlocks` 同构，识别 `type==="reasoning"` 块并取其 `text`，支持顶层 `blocks` 与嵌套 `message.content` 两种形态（无 reasoning 顶层字符串形态，合理）。**平台核对**：dsh-llm `ReasoningBlock{type:'reasoning';text:string}` 与 dsh-session `assistant/message.message.content` 形状完全对齐（§1），提取逻辑不依赖猜测。
- `RUN_SUMMARY_MAX_LENGTH=200` + `truncateSummary`：trim、≤200 原样、>200 `slice(0,200)+"…"`。语义清晰；UTF-16 截断可能切半 surrogate pair（P3-④，非本轮阻塞）。
- `analyzeWakeTurn`：从 turn 分段收集全部 assistant/message 的 textParts/reasoningParts（多步 turn 累加），`join("\n")` 后截断；**conditional spread**——无该类型块则不输出字段（保持无噪声）。no_reply 回合（无文本只有思考）仍暴露 reasoningSummary（测试覆盖）✓。

### 3.2 传输与落盘（wake.ts / scheduler.ts / domain.ts）

- `RunRecord` 新增两个可选字段（domain.ts L90/L92）。
- wake.ts `fire()` analysis 透传两个字段（conditional spread，undefined 不出现）✓；scheduler `SchedulerDeps.runWake` analysis 类型同步补齐 ✓。
- scheduler `recordRun`（L247）：positional 扩展 `(alarm, decision, budgetDelta, note?, reasoningSummary?, replySummary?)`，对象装配用 conditional spread——**JSON.stringify 落盘时不会出现 undefined 键**（实证确认）；skipped/failed 路径经 `recordSkip`/异常路径调用时不传摘要 ✓。

### 3.3 面板链路（contract / service / host-api / panel.tsx）

- `RunView` 与 `PanelSnapshotDto.runs` 各 + 两字段；service `snapshot().runs` 直接透传 `listRecentRuns`（RunRecord 结构与 RunView 契约对齐）✓。
- panel.tsx runs 表新增「摘要（思考 / 回复）」列：`思考：… ｜ 回复：…` 拼接、`maxWidth 360 + ellipsis`、`title` 悬浮全文、空摘要显示「—」——**旧 runs 记录（无字段）显示「—」不报错**（已知边界成立，实证确认）✓。

### 3.4 测试与文档

- observer.test.ts 新增 5 项：extractReasoningBlocks 形态、truncateSummary 截断、reply+reasoning 携带、reasoning 截断 + reply 保留、no_reply 回合暴露思考摘要——均通过，设计到位（no_reply 静默理由可见正是需求核心）。
- README L56「最近唤醒」、validation.md v2 项 12、summary.md L21/L32 同步 ✓。

**结论：功能正确、契约贯通、兼容性成立。**

## 4. 上轮 P3 修复核验

| 上轮 P3 | 本轮处理 | 核验 |
|---|---|---|
| ① 测试数 73/77 过期 | README L91、validation.md L5、summary.md L32 全部更新为 **82** | ✅ 与实际 82/82 一致 |
| ② `WAKE_REASON_LABELS` 死导出 | framing.ts 已删除（仅保留 WAKE_REASON_EN，面板用自家 WAKE_LABELS） | ✅ grep 确认无残留引用 |
| ③ config.json heartbeatPrompt 无长度钳制 | resolveConfig 增加 `slice(0, MAX_PROMPT_LENGTH)`，与 settings schema `max` 一致 | ✅ 超长预填不再 invalid_prompt（P3-③ 见 §6：trim 描述微差） |
| ④ AlarmView.wakeReason 类型诚实性 | 维持 TODO，未做 | ⏸️ 上轮即定「可选」；面板/工具输出 schema 均已容忍 legacy，不阻塞（沿用 P3-⑤） |

## 5. 已知边界确认（与交付声明一致）

- 摘要仅对**新产生的 runs** 生效：旧 runs.jsonl 记录无字段、面板「—」、不回溯补写（实证确认 listRecentRuns 读旧行两字段为空）。
- 截断 200 字符/字段（reasoning 与 reply 各自独立）。
- reasoning 仅为唤醒回合的 thinking 文本，不含工具内部细节（只遍历 assistant/message 顶层块，tool-result 内容不收集）✓。

## 6. P3 — 剩余小项（不阻塞）

1. **摘要链路端到端测试缺口**：observer 5 项止于 `analyzeWakeTurn` 输出；`recordRun` 装配（positional 参数 + conditional spread）→ runs.jsonl → `listRecentRuns` → RunView 全程无断言。功能经代码走读 + 实证脚本确认正确，但建议在 scheduler.test.ts（ok 路径断言 runs.jsonl 行含两字段、skipped 路径不含）或 store.test.ts 补一条回归保险。
2. **config.test.ts 未覆盖 heartbeatPrompt 超长 slice**：P3 修复本身无测试；建议在既有 heartbeat 测试中补 `"x".repeat(5000)` → 长度 4000 的断言。
3. **描述微差**：change list 称「trim + slice」，实现仅 slice（`trim()` 只用于非空判断，返回值保留首尾空白）——与 settings schema `z.string()`（不 trim）行为一致、`validatePrompt` 提交时 trim，不构成缺陷，仅在描述层面对齐即可。
4. **UTF-16 截断边角**：`truncateSummary` 按 UTF-16 code unit 截断，emoji/生僻字（surrogate pair）可能被切半显示为 。200 字符展示边界可接受；若要更稳可改 `Array.from` 按码点统计（非必须）。
5. **AlarmView.wakeReason 类型诚实性**：TODO 维持——legacy 字符串经 `toAlarmView` 原样透传，类型声明 `WakeReason` 与实际可能不符，面板与工具输出 schema 均已容忍；加注释或放宽类型可消除偏移（沿用，可选）。另建议 README/文档补一句「最近唤醒含模型思考摘要」的数据说明（panel/隐私知情），非必须。

---

## 7. 亮点与结论

- **平台对齐**：reasoning 块与事件形状均以 .d.ts 为准核对，`extractReasoningBlocks` 无臆测字段。
- **兼容性设计成熟**：旧记录零迁移（「—」）、skipped/failed 无摘要字段、no_reply 静默理由可见（需求核心场景）三者同时成立且被测试/实证锁定。
- **P3 全部落实**：三处文档测试数、死导出删除、config 长度钳制均到位。
- **验证声明全部实测成立**：tsc 全绿、82/82、build 含 client bundle、两个端到端实证脚本。

**结论：准入。** §6 五项 P3 建议按优先级顺手处理（① 最有价值），不处理也不阻塞合并；如需对齐后再次复检可再提交。