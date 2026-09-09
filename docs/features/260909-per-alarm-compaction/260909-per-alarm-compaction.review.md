# 260909-per-alarm-compaction 评审

> 日期：2026-09-09 · 评审对象：no_reply reason 保留 + per-alarm compaction 三态化（相对计划文档，src 10 文件 + test 3 文件）· 评审方式：源码走读 + 计划逐项核对 + 独立复验（tsc / 182 单测）

## 0. 结论摘要

| 级别 | 数量 | 摘要 |
|---|---|---|
| P0 阻断交付 | 0 | — |
| P1 必修 | 0 | — |
| P2 建议修 | 1 | **面板编辑路径丢失 compaction**：`client/sections.tsx` 的 `AlarmRow` 接口和 `formFromAlarm` 函数未携带 `compaction` 字段。经 `proactive_set` 设了 `off`/`aggressive` 的闹钟，一旦用户在面板里编辑（改 prompt、改时间等任意字段并保存），`formFromAlarm` 不带 compaction → `createArgsFromForm` 不传 → `validateCreateArgs` 补默认 `minimal` → compaction 被静默重置为 `minimal`。wire DTO（`AlarmRowDto`）已带 compaction，运行时对象上字段存在，但客户端类型和表单映射层丢了它 |
| P3 可后置 | 7 | ① `Alarm.compaction` 声明为可选（`?`）而非计划所述"必填"，依赖每处读取点 `?? DEFAULT_COMPACTION`——设计选择偏离计划但自洽；② `normalizeV1` 未补 `compaction: DEFAULT_COMPACTION`（计划要求），靠可选字段 + 读时默认替代；③ `WakeAnalysisResult` 缺 `reasoningSummary?`/`replySummary?`（既存，本 diff 加了 `noReplyReason` 但未补另两个）；④ 计划测试项 `off` 模式（"applyWakeCompaction 不 append"）被静默跳过——实现在 `wake.ts` 调用点拦截、不进 `applyWakeCompaction`，方向更优但与计划不符且无说明；⑤ `ALARM_VIEW_SCHEMA` compaction `required:true` 无反向测试（缺字段被拒）；⑥ 面板 UI 不展示 compaction/noReplyReason（与计划"可选增强"一致）；⑦ `MAX_NO_REPLY_REASON_LENGTH`(200) 与 `RUN_SUMMARY_MAX_LENGTH`(200) 同值异名——计划称"一致"属实但无引用链 |
| 亮点 | — | reason 提取防御充分（malformed JSON / 非 string / 空白全返 undefined + truncateSummary 截断）；tombstoneText 三态分支干净（minimal+reason 含 `no_reply:`，minimal 无 reason 退化 = aggressive，aggressive 无视 reason）；数据通路端到端打通（observer → wake → compact tombstone + scheduler recordRun → runs.jsonl → panel RunView → wire DTO）；三处同步（alarm-factory allowed set / tools enum / panel form）一致；老记录兼容（alarmIsValid 宽容缺 compaction + 读时默认）；182/182 绿、tsc 0 错 |

**总体判断：两项需求的核心逻辑全部正确、测试覆盖充分、数据通路完整。唯一的 P2 是面板编辑路径的数据丢失（`formFromAlarm` 不带 compaction），修复面极小（`AlarmRow` 加字段 + `formFromAlarm` 透传一行）。可合入。**

---

## 1. 复验记录

| 项目 | 结果 |
|---|---|
| `npx tsc -p tsconfig.json`（src+test） | ✅ 退出码 0 |
| `node --test 'dist/test/*.test.js'` | ✅ **182 passed / 0 failed** |
| 走读：reason 提取（observer.ts `extractNoReplyReason`） | ✅ 缺 arguments / 非 string / 空 string / malformed JSON / 非 object / 非 string reason / 空白 reason → 全返 undefined；正常 reason → `truncateSummary` 截断 ≤200+1 |
| 走读：tombstoneText 三态（compact.ts L80-86） | ✅ minimal+reason → `[... no_reply: <reason>]`；minimal 无 reason → `[...]`（退化 = aggressive）；aggressive → `[...]`（无视 reason）；off → 不被调用（wake.ts L255 拦截） |
| 走读：compaction off 拦截（wake.ts L253-257） | ✅ `if (compaction !== "off")` 包裹 `compactWake` 调用；off 模式唤醒交换完整保留在 surface |
| 走读：reason → tombstone 通路（wake.ts L256） | ✅ `analysis.noReplyReason` 透传至 `compactWake` → `applyWakeCompaction` → `createTombstoneMessage` → `tombstoneText` |
| 走读：reason → run history 通路（scheduler.ts L250/259/272） | ✅ `analysis.noReplyReason` → `recordRun(...)` → `RunRecord.noReplyReason` → `appendRun` → `runs.jsonl` |
| 走读：reason → panel 通路（panel/contract.ts L29 + service.ts + host-api.ts L49） | ✅ `RunView.noReplyReason?` → `listRecentRuns` 透传 parsed → wire `PanelSnapshotDto.runs[].noReplyReason?` |
| 走读：compaction → wire 通路（domain.ts L473 + tools.ts L78 + host-api.ts L33） | ✅ `toAlarmView` → `alarm.compaction ?? DEFAULT_COMPACTION`（required on AlarmView/AlarmRowDto）；`ALARM_VIEW_SCHEMA` compaction `required:true, enum` |
| 走读：compaction 校验（alarm-factory.ts L97-103 + store.ts L63-66） | ✅ `validateCreateArgs`：缺=默认 minimal，非法值=`invalid_trigger`；`alarmIsValid`：缺=合法，非法值=不合法 |
| 走读：compaction 三处同步 | ✅ alarm-factory `allowed` set 加 `compaction`；tools.ts `proactive_set` parameters 加 enum；panel/contract.ts `PanelCreateForm.compaction?` + `createArgsFromForm` 映射 |
| 走读：面板编辑路径（sections.tsx `formFromAlarm` + `AlarmRow`） | ✗ **P2**：`AlarmRow` 无 `compaction` 字段；`formFromAlarm` 不透传 compaction → 编辑时静默重置为 minimal |

---

## 2. 计划逐项核对

### 需求 1：no_reply reason 保留

| 计划项 | 实现 | 状态 |
|---|---|---|
| observer.ts：`analyzeWakeTurn` 扫 tool/call，`name==="no_reply"` 从 `data.arguments`(JSON) parse reason | `extractNoReplyReason` helper + 循环内 `if (name === NO_REPLY_TOOL)` 提取，`if (noReplyReason === undefined)` 只取首个 | ✅ |
| WakeAnalysis 加 `noReplyReason?: string` | observer.ts L36 | ✅ |
| domain.ts：RunRecord 加 `noReplyReason?: string` | domain.ts L132 | ✅ |
| scheduler.ts：`recordRun` 签名加 `noReplyReason`，`runWake` 类型加，调用点透传 | scheduler.ts L259（签名）、L43（类型）、L250（调用） | ✅ |
| wake.ts：`WakeAnalysisResult` 加 `noReplyReason?`；`fire` 返回带上；`compactWake` 接收 reason | wake.ts L47、L269、L152/256 | ✅ |
| panel/contract.ts：RunView 加 `noReplyReason?` | contract.ts L29 | ✅ |
| client/host-api.ts：runs 加 `noReplyReason?` | host-api.ts L49 | ✅ |
| 面板展示 reason 文案（可选增强） | 数据通路打通，UI 未展示（与计划"可选增强，本次至少数据通路打通"一致） | ✅（符合） |

### 需求 2：per-alarm compaction

| 计划项 | 实现 | 状态 |
|---|---|---|
| domain.ts：`AlarmCompaction` type + `DEFAULT_COMPACTION` + `COMPACTION_MODES` | domain.ts L62/L23/L25 | ✅ |
| Alarm 接口加 `compaction`（**计划：必填**） | domain.ts L115：`compaction?: AlarmCompaction`（**可选**） | ⚠️ P3-① |
| AlarmView 加 `compaction`（必填） | domain.ts L153 | ✅ |
| toAlarmView 映射 compaction | domain.ts L473：`alarm.compaction ?? DEFAULT_COMPACTION` | ✅ |
| store.ts：alarmIsValid compaction 校验 | store.ts L63-66：缺=合法，非法值=不合法 | ✅ |
| store.ts：load v2 分支缺 compaction 补默认 | **未补**：v2 record 缺 compaction 时 `alarmIsValid` 通过，直接 push（字段缺省） | ⚠️ P3-②（靠读时默认替代） |
| store.ts：normalizeV1 补 `compaction: DEFAULT_COMPACTION` | **未补**：normalizeV1 返回的 Alarm 无 compaction 字段 | ⚠️ P3-② |
| alarm-factory.ts：CreateSpec 加 compaction | alarm-factory.ts L52 | ✅ |
| alarm-factory.ts：validateCreateArgs allowed set + 校验 | alarm-factory.ts L70/L97-103 | ✅ |
| alarm-factory.ts：buildAlarm 设 compaction | alarm-factory.ts L244 | ✅ |
| tools.ts：proactive_set parameters 加 compaction enum | tools.ts L160 | ✅ |
| tools.ts：ALARM_VIEW_SCHEMA 加 compaction required+enum | tools.ts L78 | ✅ |
| panel/contract.ts：PanelCreateForm 加 compaction | contract.ts L121 | ✅ |
| panel/contract.ts：createArgsFromForm 映射 | contract.ts L150 | ✅ |
| compact.ts：tombstoneText 三态 + reason | compact.ts L80-86 | ✅ |
| compact.ts：applyWakeCompaction 签名加 compaction + reason | compact.ts L142-175 | ✅ |
| compact.ts：createTombstoneMessage 同步 | compact.ts L178-188 | ✅ |
| wake.ts：compactWake 签名加 compaction + reason | wake.ts L152 | ✅ |
| wake.ts：`if (alarm.compaction !== "off")` 拦截 | wake.ts L253-257 | ✅ |

---

## 3. 问题清单

### P2-① 面板编辑路径丢失 compaction（建议修）

- 位置：`src/client/sections.tsx` L21-39（`AlarmRow` 接口）、L521-545（`formFromAlarm`）
- 复现路径：
  1. 模型经 `proactive_set` 创建闹钟，设 `compaction: "off"`（或 `"aggressive"`）
  2. 用户在面板点编辑，改任意字段（如 prompt），保存
  3. `formFromAlarm(alarm)` 返回 `PanelCreateForm` 不含 `compaction`（`AlarmRow` 类型无此字段，TS 也不允许访问）
  4. `createArgsFromForm(form)` → `form.compaction === undefined` → 不传
  5. `validateCreateArgs` → `compaction = DEFAULT_COMPACTION`（`"minimal"`）
  6. `buildAlarm` → `compaction: "minimal"` → **静默重置**
- 影响：用户设定的 compaction 策略在面板编辑后丢失。由于面板目前无 compaction 选择器（计划标注"可选增强"），用户无法察觉也 无法在面板恢复原值——只能重新用 `proactive_set` 重建。
- 根因：`AlarmRow`（客户端展示子集）和 `AlarmRowDto`（wire DTO）不同步——DTO 有 `compaction`（L33），`AlarmRow` 没有。`formFromAlarm` 以 `AlarmRow` 为参数类型，即使运行时对象上有 compaction 也无法访问。
- 修复（两行）：
  - `AlarmRow` 接口加 `compaction: "off" | "minimal" | "aggressive"`
  - `formFromAlarm` 返回对象加 `compaction: alarm.compaction`
- 备注：`newAlarmForm` 不需要加 compaction——新建走默认 minimal 即正确。此修复只保证编辑时不丢值，不新增 UI 选择器（与计划"可选增强"一致）。

### P3-① Alarm.compaction 可选而非必填

- 位置：`src/domain.ts` L115：`compaction?: AlarmCompaction`
- 计划原文：「`Alarm` 接口加 `compaction: AlarmCompaction`（必填）」
- 实现选择可选 + doc comment「absent = DEFAULT_COMPACTION (legacy records)」。
- 后果：每处读取 `alarm.compaction` 必须加 `?? DEFAULT_COMPACTION`。当前两处消费点（`toAlarmView` L473、`wake.ts` L254）均正确，但未来新增的读取点若忘记 fallback 会得到 `undefined` 而非 `"minimal"`。
- 评估：设计自洽（可选字段 + 读时默认 vs 必填字段 + 迁移填值），兼容性等价。偏离计划但非缺陷。

### P3-② normalizeV1 / load 未补 compaction 默认值

- 位置：`src/store.ts` L93-108（normalizeV1）、L146-150（v2 load）
- 计划原文：「load v2 分支：缺 compaction 则补 `DEFAULT_COMPACTION`」「`normalizeV1`：补 `compaction: DEFAULT_COMPACTION`」
- 实现：两者都不补——normalizeV1 返回的 Alarm 无 compaction；v2 load 对缺 compaction 的 record 直接 push（`alarmIsValid` 接受缺省）。
- 后果：v1 迁移 / v2 缺字段的老记录在 persist 后仍不写回 compaction（计划称"下次 persist 写回完整字段"）。不影响正确性——所有读路径有 `?? DEFAULT_COMPACTION`。
- 评估：与 P3-① 一脉相承（可选字段的自然推论）。如果 P3-① 改为必填，此处需同步补值。

### P3-③ WakeAnalysisResult 缺 reasoningSummary/replySummary

- 位置：`src/wake.ts` L40-48
- `WakeAnalysisResult` 声明了 `decision`/`budgetDelta`/`leaked?`/`note?`/`noReplyReason?`，但 `fire()` 的返回值经 spread 还带 `reasoningSummary`/`replySummary`（L267-268）。scheduler.ts 的 `runWake` 类型（L43）自己声明了这两个字段，所以运行时不缺。
- 既存偏差（260908 引入 summary 字段时未同步接口），本 diff 加 `noReplyReason` 时也未补。
- 后果：通过 `WakeFireResult` 类型访问 `analysis.reasoningSummary` 会被 TS 拒绝（字段不存在），只能经 scheduler 的宽类型绕过。非运行时缺陷，但接口有误导性。

### P3-④ 计划测试项 off 模式被静默跳过

- 计划测试计划：「`off`：applyWakeCompaction 不 append（返回 false）」
- 实现：`off` 在 `wake.ts` L255 调用点拦截（`if (compaction !== "off")`），不进 `compactWake`/`applyWakeCompaction`。方向比计划更优（在驱动层短路而非在 compaction 层空操作），但与计划测试项不匹配且无说明。
- 缺失：无任何测试验证 `off` 模式不压缩。`wake.ts` 的 `fire()` 需要真实 agent（AGENTS.md 规范：单测只测纯函数），只能 E2E 验收。compact.test.ts 也未加 `tombstoneText(alarm, date, "off", reason)` 的行为锁定（当前行为：返回 `base + "]"`，即 aggressive 文本——但 `off` 不应被调用，此返回值不会被使用）。

### P3-⑤ ALARM_VIEW_SCHEMA compaction required 无反向测试

- `ALARM_VIEW_SCHEMA` 的 `compaction` 是 `required: true`（tools.ts L78），但无测试验证"缺 compaction 被拒"。实践中 `toAlarmView` 总是设值，所以不会缺——但 schema gate 的双向覆盖（接受合法值 + 拒绝缺字段）是既有测试惯例（如 P1/P0 回归测试），此处少了一半。

### P3-⑥ 面板 UI 不展示 compaction / noReplyReason

- 与计划一致（「面板展示 reason 文案：可选增强，本次至少数据通路打通」）。
- `AlarmRow`（sections.tsx）无 compaction → 闹钟表无 compaction 标签；`RunRow` 无 noReplyReason → 运行历史无 reason 展示。
- 数据已到 wire（DTO 有字段），后续加 UI 选择器/标签时只需改 sections.tsx + locales。

### P3-⑦ 两个 200 常量同值异名

- `MAX_NO_REPLY_REASON_LENGTH`（domain.ts L21，工具输入校验上限）= 200
- `RUN_SUMMARY_MAX_LENGTH`（observer.ts L42，run history 截断上限）= 200
- 计划称「上限 200，与 `MAX_NO_REPLY_REASON_LENGTH` 一致」——属实。但二者无引用关系：改一个不会自动改另一个。observer 的 `extractNoReplyReason` 用 `truncateSummary`（后者用 `RUN_SUMMARY_MAX_LENGTH`）截断 reason。如果未来调 `MAX_NO_REPLY_REASON_LENGTH` 而忘调 `RUN_SUMMARY_MAX_LENGTH`（或反之），截断与校验会错位。当前不构成缺陷。

---

## 4. 测试评估

### compact.test.ts

- 现有 `applyWakeCompaction`/`tombstoneText` 调用已补 `"aggressive"` + `undefined` 参数。 ✅
- 新增三态 tombstone 测试：
  - minimal + reason → 含 `no_reply: <reason>` ✅
  - minimal 无 reason → 退化 = aggressive ✅（`assert.equal(text, tombstoneText(..., "aggressive", "ignored"))`）
  - aggressive + reason → 无 `no_reply:` ✅
- 新增端到端 minimal 测试（真实 Session + surface 断言）→ tombstone 含 reason，assistant/tool 被 eraser 抹除 ✅
- 缺失：off 模式的 tombstoneText 行为锁定（P3-④）；applyWakeCompaction 在 minimal 模式下 eraser fallback 路径的 reason 传递（当前 eraserless runs fallback 到 tombstone，reason 正确传入但无专测）。

### observer.test.ts

- 新增 `toolCallWithArgs` helper（JSON.stringify args） ✅
- 四个新测试：
  - 正常 reason 提取 ✅
  - 截断（超 200 + 1 省略号） ✅
  - 缺 reason → undefined ✅
  - malformed JSON → undefined ✅
- 覆盖充分。`extractNoReplyReason` 的边界（非 string arguments、非 object parsed、非 string reason、空白 reason）由实现代码防御，无测试但逻辑自洽。

### tools.test.ts

- `asView` 类型加 `compaction?` ✅
- 两个 schema gate 测试 base 夹具补 `compaction: "minimal"` ✅
- 新增 compaction 默认/显式 + 非法值测试 ✅
- 缺失：schema gate 反向（缺 compaction 被拒）（P3-⑤）

---

## 5. 亮点

- **reason 提取防御到位**：`extractNoReplyReason` 对 arguments 的每层 unwrap 都有类型守卫 + try/catch，malformed JSON 不抛穿、空白 reason 不残留。`truncateSummary` 用 code-point 切割（已有测试锁定不拆 surrogate pair）。
- **tombstoneText 三态分支极简且正确**：一个 `if` + 两个 return，minimal+reason 有 reason，其余退化。off 不在此函数处理（驱动层短路），职责清晰。
- **数据通路端到端打通**：reason 从 tool/call arguments → observer → wake analysis → compact tombstone（模型 surface）+ scheduler recordRun → runs.jsonl → panel RunView → wire DTO，每跳都有条件 spread（`?? undefined` 不写空字段），可选字段全链路兼容。
- **compaction 三处同步零漂移**：`COMPACTION_MODES` 单一来源 → alarm-factory allowed set + tools enum + panel form，三处共享同一常量数组，新增模式只需改一处。
- **off 模式拦截在驱动层**：`wake.ts` L255 `if (compaction !== "off")` 在进 `compactWake` 前短路——比在 `applyWakeCompaction` 内部判更优（不规划、不 append、不 log），且 `compactWake` 内部无需关心 off 语义。
- **老记录兼容**：`alarmIsValid` 宽容缺 compaction + 每处读取 `?? DEFAULT_COMPACTION` → v1/v2 老记录无感升级，STORE_VERSION 不 bump。
- **测试质量**：compact 三态 tombstone 纯函数测试 + 端到端 Session surface 断言；observer reason 提取四路径覆盖；tools 默认值/非法值/schema gate 覆盖。182/182 全绿。

---

## 6. 结论

**可合入。** 两项需求的核心逻辑——reason 提取、三态 tombstone 渲染、compaction 驱动层拦截、数据通路端到端——全部正确，182/182 测试 + tsc 0 错复验属实。

唯一建议在合入前或紧跟一轮处理 P2（`formFromAlarm` 不带 compaction → 面板编辑静默重置），修复面两行（`AlarmRow` 加字段 + `formFromAlarm` 透传），不影响核心逻辑。P3 七项均为设计选择偏差或测试覆盖增量，可后置。
