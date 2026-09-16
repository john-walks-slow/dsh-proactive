# 检视报告：proactive 创建会话捕获缺陷修复

## 概要

本次修复 dsh-proactive 的目标选择缺陷：workspace/preset 目标的闹钟会"捕获" proactive 自己创建的会话（new 产物 / fork 子会话），导致下一个动态目标闹钟唤醒到插件自己的产物里而非用户会话。方案为"记账法 + 剔除 + skip"：state.json 新增 createdSessions 台账、两条 fire-time resolver 据此剔除、无合格候选则返回 skipped。整体实现质量高、测试覆盖充分、平台契约理解准确；但存在一个 driver→scheduler 接缝的字段名错配（`reason` vs `skipReason`），导致线上实际的 skip 原因被兜底文案覆盖、未进入 run record，且该缺陷对当前全绿的单测不可见。

## 需求对齐

记账（HostState + createdSessions + cap 1024 + 原子 persistHost + 构造器 initialHost）、剔除（两条 resolver 对候选先查 createdSessionKind、命中且不 eligible 则剔除；豁免规则 `createdSessionEligible(kind, lastPromptAt)` = kind==="new" && lastPromptAt != null；fork 永不豁免；cold 缺缓存行 = unknown = 不豁免）、无候选→skip（resolver 返回 `{kind:"none"}`；wake.ts resume+workspace/preset 两条 create arm 改为 skipped+reason；scheduler 记 skipped run、advancePast、不重试、不占 hourly cap、不计预算）、blank 槽保留、收敛悖论闭合（动态 resolver 不再 create）——均按用户拍板方案落地。

唯一偏离：方案第 3 点明确要求「scheduler 记 run record（decision="skipped"、note=reason）」，即 run record 的 note 必须是 driver 给出的具体 reason（含 workspace/preset id、指向 target_mode new）。线上接线（index.ts 直接 `runWake: (alarm) => driver.fire(alarm)`）因字段名错配把这个 reason 丢成了兜底串——见阻塞问题 B1。

## 阻塞问题

| ID  | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| B1 | `src/wake.ts:90`（`WakeFireResult` 的 skipped 臂字段 `reason`）、`src/scheduler.ts:46`+`:249`（`SchedulerDeps.runWake` 返回类型字段 `skipReason`、`result.skipReason ?? "no eligible target session"`）、`src/index.ts:166`（`runWake: (alarm) => driver.fire(alarm)`，无适配层） | 字段名错配，skip 原因在线上被丢弃。driver 返回 `{ outcome: "skipped"; reason: "workspace ws-x has no eligible … use target_mode new" }`，scheduler 读 `result.skipReason`（声明字段名是 skipReason）→ 运行期为 `undefined` → `recordSkip` 落 `note = "no eligible target session"`（兜底串），workspace/preset id 与 target_mode new 指引全部丢失。TS 不报错：结构兼容（skipped 臂多出的 `reason` 在非字面量赋值里被允许，缺失的可选 `skipReason` 也允许），所以 `npm run check` 绿。单测也绿是因为 scheduler 测试用 `h.outcomes.push({outcome:"skipped", skipReason:"…"})` 直接喂 `skipReason`（`test/scheduler.test.ts:161-162,179,194`），wake 测试只断言 `fire.reason`（`test/wake.test.ts:946-947`、`test/target-v3.test.ts:442-443`）——没有任何用例接线 driver.fire→scheduler 这个真实接缝，缺陷对 CI 不可见。 | 二选一（推荐前者）：(a) 把 `WakeFireResult` 的 skipped 臂字段从 `reason` 改名为 `skipReason`（`src/wake.ts:90,564,607`），并同步 `test/wake.test.ts:946-947`、`test/target-v3.test.ts:442-443` 的 `fire.reason`→`fire.skipReason`；(b) 或在 `index.ts:166` 加一行适配：`runWake: async (alarm) => { const r = await driver.fire(alarm); return r.outcome === "skipped" ? { outcome: "skipped", skipReason: r.reason } : r; }`。推荐 (a)：单一导出类型、从源头消除错配，避免「SchedulerDeps 用 skipReason、WakeFireResult 用 reason」的双名长期埋雷。 |

## 建议修改

| ID  | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| S1 | `packages/dsh-proactive/AGENTS.md:18,34` | 模块指令过期，与实现脱节。仍写「可见会话 → 空白 New Session 槽 → create（cwd=工作区路径，**attach 先于投递**）」「缺目录闭式 failed」「cold 列表失败且无 live 候选 → 闭式 failed（防重复建会话）」，未提 none/skip、createdSessions 台账、createdSessionEligible 豁免、skip 这个 WakeFireResult outcome。后续开发者会被「resolver 会 create」的旧描述误导，也看不到捕获修复的存在。 | 按 `update-module-instruction` 技能更新 workspace 目标段（260910→260916）：pickWorkspaceTarget 终止于 "none"（skip，永不 create）；resolver 经 createdSessionKind + createdSessionEligible 剔除插件自建 new/fork（new + lastPromptAt!=null 可豁免即「被用户采纳」；fork 永不豁免）；missing-dir 守卫仅留在 cwdOf（target_mode new + workspace 路径）；cold 列表失败且无 live 候选→闭式 retry，否则 none；state.json 增 createdSessions 台账（cap 1024、与预算共用 persistHost 原子写）；skip 为 WakeFireResult 新 outcome（scheduler 记 skipped run、advancePast once→completed/every→next、不重试/不占 hourly cap/不计预算）。 |
| S2 | `docs/issues/260916-proactive-created-session-capture/`（空目录） | 缺验收文档。按仓内约定（`260906`、`260907` 各有 validation.md）与 AGENTS.md「涉及真实 agent 的路径只能靠 E2E 验收」，本修复的核心行为只能 E2E 验证：跨 host 重启的台账存活、面板 RunView 对 skipped run 的渲染、fork 永不豁免的 UX、live「无合格→skip→completed once-alarm」全链路。单测不覆盖真实 agent 路径。 | 新增 `…validation.md`，列出 E2E 场景：(1) 同工作区内一条 repeating new+workspace 闹钟 + 一条 resume+workspace 闹钟→resume 闹钟持续命中用户会话、永不命中插件产物；(2) host 重启后 state.json createdSessions 仍生效；(3) 面板显示 decision "skipped" + 具体 note（依赖 B1 修复后 reason 正确落地）；(4) once 闹钟 skip→completed、every 闹钟 skip→下一网格点；(5) 被用户采纳的 new 产物（用户在产物里输入过）重新合格。 |

## 非阻塞问题

| ID  | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| N1 | `src/wake.ts:565,608` | skip reason 文案「only archived, subagent-owned, or this plugin's own created sessions」对「工作区本就零会话」的情形不准确（并非"只有 archived/…"，而是根本无会话）。诊断文案轻微误导。 | 改为「has no eligible session to wake (no user sessions, or only archived/subagent/this plugin's own created ones)」之类，覆盖空工作区情形。 |
| N2 | `src/store.ts:307-321`（`recordCreatedSession` + `persistHost`）、`src/store.ts:289-295`（`spendBudget`） | 并发写竞争：`recordCreatedSession` 与 `spendBudget` 都走 tmp+rename，`this.host` 在 stringify 时才读取（非调用时快照）。极窄的崩溃窗口下，一次较旧的完整 state 可能在 rename 顺序里覆盖较新的，导致重启后丢一条台账（内存仍正确直至重启）。属既有模式（spendBudget 原本就这么写），非本次回归。 | 现状可接受；若要硬化，可给 persistHost 加串行写互斥（如 `this.writeChain` 串行化）或在 `recordCreatedSession`/`spendBudget` 入口快照 `this.host` 后再写。优先级低。 |
| N3 | `src/store.ts:39`（`MAX_CREATED_SESSIONS=1024` 挤出） | 超过 1024 条后最老的台账条目被挤出；若该被挤出的未采纳 new 产物仍是当时最 recent 的可见候选（极端：长期无用户活动），理论上会重新可被捕获。极边缘，方案已接受。 | 在 validation 文档备注该上限与边界；如真担忧可考虑把上限提到与「一次性 new 闹钟生命周期」相称的量级，或对「未采纳且 createdAt 早于 N 天」的产物不做挤出。优先级最低。 |
| N4 | `src/workspace.ts:360-363,501-505`（cold 缓存行三态） | cold 采纳型 new 产物：若 host 尚未写出投影缓存行（用户刚输入、投影未刷新），lastPromptAt 取 undefined→保守剔除→该次唤醒 skip。安全方向（skip 优于误捕获），但存在「用户已采纳却暂时没被唤醒」的短暂窗口。属设计「缺行=unknown=不豁免」的预期行为。 | 在 validation 注明该保守窗口；无需改码。 |
| N5 | `src/workspace.ts:284-286`（`createdSessionEligible`：fork 永不豁免） | 即使用户把一个 fork 子会话当主会话长期使用，workspace/preset 闹钟也永不命中它。用户预期可能落空且无 UI 提示。属用户拍板（fork 继承历史、冷热都判别不了），但需让用户知晓。 | 在面板文案/validation 注明：要把闹钟定到 fork 子会话，需用 target_mode session（精确 id）或 target_mode new；resume/fork + workspace/preset 不会选中它。 |
| N6 | 全局（无迁移） | 本次修复对修复前已存在的插件自建会话无追溯记账（无法事后区分），它们仍可被捕获直到被更近的用户活动盖过或被手动处理。方案已知（语义法不可行）。 | 在 validation/summary 注明该一次性限制与应对（如对存量可疑产物让用户手动归档/删除，或等台账随新活动自然填充）。 |

## 准入结论

**结论**：`不准入`

**说明**：捕获缺陷的核心修复（记账+剔除+skip 语义、收敛悖论闭合、平台契约理解）正确且实现质量高、单测覆盖充分。但存在一个对 CI 不可见的接缝缺陷 B1：driver 返回字段 `reason`、scheduler 读取字段 `skipReason`、index.ts 直接透传无适配——线上 skip 原因被兜底串覆盖，直接违反用户拍板方案第 3 点「note=reason」。修复极小（改名 `reason`→`skipReason` + 4 处测试断言，或 index.ts 一行适配），修复后建议补一条 driver.fire→scheduler 的接线集成测试以防再次回归，随后可准入。

## 附：实现亮点（供记录）

- 类型新增干净：`CreatedSessionKind`/`CreatedSessionRecord` 独立、`RunDecision` 复用既有 "skipped"、`WakeOutcome`/`FireResult` 仅扩一枚臂，无 enum/namespace。
- 容错读（`parseCreatedSessions`）与既有 `alarmIsValid`/`normalizeV1` 同风格；state.json 损坏不砖化、budget 不丢。
- `persistHost` 与预算共用，避免双写路径；内存更新先于写盘、写失败仅丢持久化（wake.ts 的 `bookkeepCreatedSession` 注释与 catch warn 一致）。
- bookkeeping 早于 attach：恰好覆盖 preset resolver 扫描全量会话（不限于 workspace.sessionIds）的路径——一个未 attach 的 new 产物仍可能被 preset resolver 看见，台账剔除把它挡住，顺序正确。
- cold 列表失败的保守处理保留并迁移到位（无 live 候选→闭式 retry，不误 skip 一个看不见的会话），错误文案从"cannot safely pick or create"改为"cannot safely pick a destination"，准确。
- missing-dir 守卫从 resolver 迁到 `cwdOf`（仅 target_mode new + workspace 真正需要它），resume 路径不依赖工作区目录，行为保持。
- skip 不烧 hourly cap、不计预算、不重试——scheduler `fireOne` 分支与单测（`maxWakeupsPerHour=1` 下第二闹钟真实唤醒照常）佐证。
- 面板 RunView decision pill（`sections.tsx:138`）与 locales（`decisionSkipped`）已支持 "skipped"，无需额外改码。
