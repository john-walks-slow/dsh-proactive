# workspace/preset 闹钟捕获 proactive 自建会话 — 实施摘要

## 问题

`target_mode: new` / `fork` 的 proactive 闹钟触发后新建会话；紧接的 `target_mode: workspace` / `target_source: workspace|preset`（resume）闹钟会**唤醒到这个产物会话**里，而非用户的会话。根因：resolver 目的地排序键是侧边栏 `updatedAt = max(createdAt, lastPromptAt)`，自建会话 `createdAt` = 唤醒时刻天然登顶，下一个 workspace/preset 闹钟选中它——插件捕获了自己的回声。

## 方案（记账法，用户拍板）

1. **记账**：`state.json` 由 BudgetState 扩为 HostState，新增 `createdSessions`（`{sessionId, kind:"new"|"fork", createdAt}`，cap 1024，原子写，容错读）。`recordCreatedSession(id, kind)` 幂等、超限挤出最老。
2. **剔除**：workspace/preset 两条 fire-time resolver 对候选查 `createdSessionKind`，命中且不 eligible 则剔除。真人豁免 `createdSessionEligible(kind, lastPromptAt) = kind==="new" && lastPromptAt != null`（用户在 new 产物里输入过 → 跟着用户走）；fork 永不豁免（继承历史不可判别）。cold 路径 lastPromptAt 取投影缓存行（缺行=unknown=保守剔除）。
3. **无候选 → skip**：resolver 返回 `{kind:"none"}`；wake.ts 的 resume+workspace / resume+preset 分支从"create arm / fallback create"改为返回 `{outcome:"skipped", skipReason}`（指引用 target_mode new）。skip 是新 `WakeOutcome`：scheduler 记 run（`decision:"skipped"`、`note=skipReason`、`budgetDelta:0`）、advancePast（once→completed、every/cron→下一锚点），**不重试、不烧 hourly cap、不计预算**。旧 create arm 与 missing-dir 检查删除（missing-dir 守卫保留在 `cwdOf`，服务 new+workspace 路径）。
4. **blank 槽保留**：GUI New Session 槽仍是合法目的地（`pickWorkspaceTarget` 逻辑不变，仅 create 兜底改 none）。
5. **收敛悖论**：若"剔除产物 + 保留 create arm"，每次 fire 新建→新会话又登顶→下一个 wake 又进产物（自我捕获循环）；"无候选就 skip"闭合该环。

语义法为何不够：fork child 的 live 折叠继承父会话真人消息（lastPromptAt 非 null 但非本人活动）、cold 投影 seeded header 无缓存行（lastPromptAt unknown）——两条路径都无法用"有没有真人 prompt"判别，只有记账法有效。

## 改动文件

源码（9）：
- `src/domain.ts` — `CreatedSessionKind`（"new"|"fork"）、`CreatedSessionRecord`
- `src/store.ts` — `HostState.createdSessions`、`MAX_CREATED_SESSIONS=1024`、`parseCreatedSessions` 容错读、`createdSessionKind`/`recordCreatedSession`（幂等、slice(-cap)、原子写共用 `persistHost`）、构造器第三参 `initialHost`
- `src/workspace.ts` — `WorkspacePick`/`WorkspaceWakeDestination` 的 create→none；`pickWorkspaceTarget` 空集返回 none；`createdSessionEligible`；两条 resolver 剔除 plugin-created 候选；删 create arm（cwdOf 保留 missing-dir）；`coldListFailed` 文案
- `src/wake.ts` — `WakeFireResult` +`{outcome:"skipped"; skipReason}`；`bookkeepCreatedSession`（new/fork create 后记账，attach 之前）；resume+workspace/preset 分支改 skip
- `src/scheduler.ts` — `WakeOutcome` +skipped；`SchedulerDeps.runWake` +`skipReason?`；skipped 分支（recordSkip+advancePast，不 push recentFires）
- `src/index.ts` — port deps 注入 `createdSessionKind`
- `src/tools.ts` / `src/panel/contract.ts` / `src/client/locales.ts` — 文案（target_source description、presetSourceHint/workspaceHint zh/en 改 skip 语义，保留 fork 失败说明）

测试（5）+ 1 新接线测试：workspace/store/target-v3/wake/scheduler，276/276 绿。

## Review（260916 reviewer）

报告：`docs/issues/260916-proactive-created-session-capture/260916-proactive-created-session-capture.review.md`。初始结论**不准入**（1 阻塞）。

**阻塞 B1（已修复）**：driver 的 skipped 臂字段名 `reason` 与 scheduler 读的 `skipReason` 不一致；`index.ts` `runWake: (alarm) => driver.fire(alarm)` 直接透传无适配——TS 结构兼容不报错、单测也绿（scheduler 测试直接喂 skipReason 绕过 driver，wake 测试只在 driver 层断言 reason），但线上 run record 的 note 会静默落兜底串「no eligible target session」，丢失 workspace/preset id 与「use target_mode new」指引，违反方案第 3 点。
- **修复**（方案 a）：统一字段名 `reason`→`skipReason`（wake.ts 3 处）+ 同步 test 断言（wake.test.ts、target-v3.test.ts）。
- **防回归**：新增 `scheduler.test.ts` 接线测试——`runWake: (alarm) => driver.fire(alarm)` 真实接线，断言 runs.jsonl 的 `note` 含真实 skipReason、不含兜底串（字段名漂移即失败）。

**建议（已处理）**：
- S1 AGENTS.md 过期 → 已更新 workspace 目标 bullet（create→none/记账/skip）+ 新增 skip outcome bullet。
- S2 缺 validation.md → 已写（含重启 cold、面板 skipped、fork 永不豁免、once-skip→completed 等 E2E-only 验收项）。

**非阻塞（6，不改/记录）**：
- N1 skip 文案对空工作区（"only archived/subagent/plugin-created"对空不准）——文案通用化收益低，记 troubleshoot；N2 persistHost 并发写竞争（既有模式）；N3 1024 挤出边缘（设计如此）；N4 cold 缓存行未刷新的保守 skip 窗口（保守方向正确）；N5 fork 永不豁免即便被采纳（设计决策，AGENTS.md 已记）；N6 无存量迁移（load 容错读已处理）。

## 单测结果

`npm run check`（tsc src+test）+ `npm test`：**276/276 绿**（原 259 + 本次 16 + B1 修复接线 1）。

## 部署

web profile `node_modules/dsh-proactive`（symlink 直连工作区 `lib/`）已 build（`npm run build`）。生效需用户书面同意重启生产 dsh。E2E 隔离实例（4599）装配问题见 troubleshoot.md，非本改动引入。
