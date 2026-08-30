# dsh-proactive 第四轮复检评审（update_settings 工具 + heartbeat prompt 可选化）

> 日期：2026-08-29 · 评审对象：本轮 diff（两处用户新需求）· 基线：此前两轮准入结论（主特性 + P3 修复复检）+ 本文件旧评审已被覆盖（旧结论见 git 历史）
> 评审方式：源码走读 + 平台 .d.ts 交叉核对 + 独立复验（tsc / 96 单测 / build / 端到端实证脚本）

## 0. 结论摘要

| 级别 | 数量 | 摘要 |
|---|---|---|
| P0 阻断交付 | 0 | — |
| P1 必修 | 0 | — |
| P2 建议修 | 1 | **配置双入口（官方设置面板 ↔ update_settings 工具）分层张力**：模型工具改动经 config.json 持久层 + 内存热应用；官方设置面板走 settings 服务层（`base`=启动快照，独立持久层）。工具改动后官方面板显示旧值、且面板**任一**字段保存会把整表合并值（旧 base+面板覆盖）回写 config 内存，覆盖工具改动（config.json 仍新，重启后官方层值最终胜出）。模型自主使用路径完全正常（热应用+持久+重启保留），仅面板与工具**交替**编辑同字段时出现不一致。建议：README 明示双层语义，可选后续（update_settings 时若 settings 服务可用则同步刷新 base） |
| P3 可后置 | 2 | ① `validateSettingsPatch` 上限（0..50 / 1..4 / 0..10 / 100..20000）宽于…窄于官方 settings schema（0..1000 / 1..16 / 0..16 / 100..100000）——方向安全（工具值 ⊆ 面板接受域，面板不 reject 工具值），但 settings.ts 注释"same shape the settings schema accepts"字面不成立，建议改为"与 resolveConfig 钳制一致"；② tools.test.ts 两处"其他字段不变"断言是国内自比恒真（`h.config` 与 `h.services.config` 同一引用），未真正锁定 partial 语义（功能正确性由 merge 走读 + 实证确认），建议快照 deepEqual |
| 亮点 | — | 工具接受值 ⇔ resolveConfig 钳制**逐字段完全一致**（"热应用 8、重启变 4"彻底消除，实证三处一致）；writeConfigFile 原子写 + merge 保留他键；prompt 可选化的闭式分支正确；effectiveWakePrompt 三态+去重；输出 schema 经 dsh-tools 校验通过；双层校验门（dispatch enum + 闭式） |

**总体判断：两处用户需求实现正确、契约贯通、测试到位，未发现 P0/P1。一处 P2 为双入口架构张力（建议合入前在 README 记录，不阻塞工具自身闭环），两处 P3 为测试/注释级。结论：准入。**

---

## 1. 需求与基线

- 需求①（用户原话："添加更新设置的工具，比如可以只是改interval不改别的"）→ `proactive_update_settings`：partial update、持久化 config.json（原子写）+ 热应用、返回更新后配置视图。
- 需求②（用户原话："heartbeat的prompt可以optional，无论如何前面都应该接那个默认值…prompt只有有额外方向要求的时候才补充在后面"）→ proactive_set 的 prompt 对 heartbeat 可选；framing 层 heartbeat 永远以默认 heartbeatPrompt 开头，用户 prompt（非空且不同于默认）作附加方向拼接；alarm 保持必填。
- 维护基线决策：wake_reason 仅 heartbeat|alarm；legacy 值兼容；harness 以 `resolveConfig(mkdtemp)` 提供完整 config + dataDir。

## 2. 复验记录（本次会话实测）

| 项目 | 结果 |
|---|---|
| `npm run check`（tsc --noEmit src+test） | ✅ 退出码 0 |
| `npm test` | ✅ **96 passed / 0 failed**（82 + 14 新增：tools 3 / framing 3 / settings 4 / config 与既有微调） |
| `npm run build` | ✅ 退出码 0（client bundle 正常） |
| 实证：update_settings 全流程 | ✅ 视图/内存/config.json 三处 heartbeatEverySeconds 一致（4200）；手写 config.json 的 maxWakeupsPerHour=9 **未覆盖**（merge 保留） |
| 实证：SETTINGS_VIEW_SCHEMA 输出校验 | ✅ dsh-tools `validateJsonSchemaValue` 通过（无错误分支命中） |

## 3. 需求① — proactive_update_settings 工具

### 3.1 契约与实现（tools.ts / settings.ts / config.ts）

- 10 个参数全 snake_case、全可选；至少一个字段（空对象 → `invalid_trigger`）；未知键拒绝。输出 `oneOf: [SETTINGS_VIEW_SCHEMA, ERROR_SCHEMA]`，视图字段与 HotConfig 一一映射（snake_case）。
- execute 顺序：`validateSettingsPatch`（闭式）→ `writeConfigFile`（**先持久化**，失败返回 `persistence_uncertain` 且**不热应用**）→ `applyHotConfig(config, {...hotSubset(config), ...patch})` → `settingsView(config)`。写失败不应用、应用不抛错，顺序正确。
- `writeConfigFile`：`{...loadConfigFile(dataDir), ...patch}` merge + `tmp+rename` 原子写，patch 只含传入键 → "只改传入字段"在文件层成立（实证：maxWakeupsPerHour=9 保留）。
- **上限一致性**（本轮亮点）：validateSettingsPatch 常量 0..50 / 1..60 / 1..4 / 0..10 / 100..20000 / 300..86400（heartbeat_prompt ≤4000 非空、quiet_hours 整组 HH:MM + IANA canonicalize）与 resolveConfig 各字段钳制**逐一相等** → 工具接受的值重启读 config.json 时不会被钳制，"热应用 8、重启变 4"的分裂不复存在（实证三处一致）。
- `SETTINGS_VIEW_SCHEMA.boot_overdue_policy` 输出为无 enum string（延续 ALARM_VIEW 的宽松输出策略，避免运行时输出校验炸）；参数侧有 enum → dispatch 层与闭式双层校验一致。

### 3.2 测试（tools.test.ts ×3 + settings.test.ts ×4）

- partial 只改 interval：输出视图 + 内存热应用 + config.json 落盘三断言；拒绝矩阵：空对象/未知键/越界 60s/空白 heartbeat_prompt/坏 HH:MM，且拒绝后 config.json 不产生（`exists === false`）。
- settings.test.ts（新建）：partial 键集合精确（`Object.keys(patch) === ["heartbeatEverySeconds"]`）、quiet_hours normalization、heartbeat_prompt trim、闭式错误码矩阵（含 `invalid_time_zone`）。

## 4. 需求② — heartbeat prompt 可选 + effectiveWakePrompt

### 4.1 创建侧（alarm-factory.ts）

- `validateCreateArgs` 先解析 wakeReason，再分支 prompt：heartbeat → `typeof string ? trim : ""`（缺失/空/纯空白 → 空串存储；>4000 仍 `invalid_prompt`）；alarm（及一切非 heartbeat，legacy 已被 WAKE_REASONS 枚举在更早一步拦截）→ `validatePrompt` 必填非空。
- 工具参数 schema 去掉 prompt 的 required；description 明确 "Optional for wake_reason=heartbeat … Required for wake_reason=alarm"。模型省略 prompt → 闭式分支接手，不依赖 schema 层。

### 4.2 唤醒侧（framing.ts effectiveWakePrompt）

- heartbeat：`base = config.heartbeatPrompt.trim()`（永远在前）；`extra = alarm.prompt.trim()`；extra 空或 === base → 只给 base（去重，覆盖面板预设 prefill 场景）；否则 `base + "\n\n" + extra`。
- alarm/legacy：原样返回（legacy 存储时 prompt 必填，非空成立）。
- renderFraming 的 `alarm_prompt_json.prompt` 与 createFramingMessage 的 notice `summary` 均改用 effectiveWakePrompt（summary 经 boundContextSummary 限长 ≤120，既有机制）。

### 4.3 测试（framing.test.ts ×3 + tools.test.ts ×1）

- effectiveWakePrompt 三态 + alarm/legacy 原样 + renderFraming 嵌入默认文案 + "default must come first"；tools：heartbeat 省略 prompt/显式空白 prompt 创建成功（prompt 存 ""）+ alarm 省略 prompt 仍 `invalid_prompt`、store 数量不变。

## 5. P2 — 配置双入口分层张力（建议修，不阻塞）

详细分析见 §0。要点：

- 持久层：工具 → config.json（resolveConfig base）；面板 → 官方 settings 服务层（`base: hotSubset(config)` 启动快照 + 用户覆盖持久化）。
- update_settings 见效链路完整：内存热应用即时生效（scheduler/wake/面板 snapshot 均已读同一 config 对象）、config.json 持久、重启后入 base。
- 分歧触发条件：**面板在工具改动之后保存任一字段** —— `scope.watch(next)` 的 next 由 settings 服务基于旧 base 合成，`applyHotConfig` 整表回写 → 工具改动在内存层被覆盖；重启后 settings 服务层用户覆盖（若面板曾写过该字段）优先于 config.json。行为可预测但两入口互相不感知。
- 修复方向（任选其一，均为后续项）：① README「配置入口」段落明示双层语义与覆盖关系；② update_settings 应用后若官方 settings 服务可用，同步其 base/注册值；③ 面板 watch 回调同时写回 config.json 使单层化（与 settings 服务持久层语义需权衡）。
- 不在本轮需求闭环内（模型自主改配置路径无此干扰），故定 P2 而非 P1。

## 6. P3 — 小项（不阻塞）

1. settings.ts 注释「values are normalized to the same shape the settings schema accepts」与事实不符：validateSettingsPatch 上限（50/4/10/20000）窄于 proactiveSettingsSchema（1000/16/16/100000）。方向安全（工具值 ⊆ 面板接受域，面板不 reject 工具产生的值；partial 语义下模型不传未改字段即不触碰面板值）。建议注释改为「与 resolveConfig 钳制一致」或统一常量。
2. tools.test.ts L212/L226：「其他字段不变」断言为同一引用自比（`h.config` === `h.services.config`），恒真不锁定行为。建议对 config 快照做 deepEqual 断言（功能本身经走读 + 实证确认正确）。

## 7. 亮点与结论

- **逐字段上限对齐**：validateSettingsPatch ⇔ resolveConfig 钳制完全一致，且官方 schema 覆盖域更宽不 reject 工具值 —— 双门校验（dispatch enum + 闭式）与重启钳制三方自洽（实证）。
- **原子持久化**：tmp+rename + merge 保他键；写失败不热应用（失败原子性正确）。
- **prompt 语义收敛**：默认值永远前置 + 附加方向去重 + 空 prompt 合法化 + alarm 必填不变，测试五路覆盖。
- **输出 schema 实测**：SETTINGS_VIEW_SCHEMA 经 dsh-tools 校验通过（延续输出宽松枚举策略）。

**结论：准入。** 建议合入时在 README 补「配置双入口」说明（P2），P3 两项顺手处理；如需要可安排第五轮复检。