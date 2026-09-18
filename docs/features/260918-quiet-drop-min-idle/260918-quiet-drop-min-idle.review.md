# 260918 安静时段直跳 + min_idle_seconds — 检视报告

## 概要

检视范围：dsh-proactive 插件两项行为改进（安静时段直跳快进 + min_idle_seconds 静默门），覆盖领域模型 / 工厂 / 调度 / wake driver / 工具 / 持久化 / 声明式同步 / 面板表单 + 文案 + 测试 + 文档。整体评价：**改造与 plan 高度一致，与 260918-declared-schedules 的联动假设（declared.ts:448 hash 未变 → 完全 no-op）由 declared.test.ts 新增回归锁住；测试 308/308 绿；tsc 干净。存在 1 处轻微一致性瑕疵（fast-forward 路径 runCount/lastRunAt 未递增，与 once 分支语义不一致），1 处可优化项，2 处非阻塞观察**。

## 需求对齐

- **改动一 安静时段直跳**：与 plan §"改动一"完全一致
  - once → 跳过 + completed + 一条 skipped run（`skipPastQuiet` once 分支走 `advancePast`，因此 `runCount + 1` ✓）
  - every/cron → 一次性快进到窗外首个锚点 + 一条 skipped run（`nextAwakeOccurrence` 有界迭代，`QUIET_SKIP_MAX_ITERATIONS = 4096` 防自旋）
  - hourly cap 仍 deflect 5 分钟（scheduler.ts:196 不变）
  - 安静窗判定沿用 `config.quietHours.timeZone`
- **改动二 min_idle_seconds**：与 plan §"改动二"完全一致
  - 校验：0..86400（`MAX_MIN_IDLE_SECONDS` 与 alarm-factory 校验 + store.alarmIsValid 三处一致）
  - 仅作用于 resume 目的地（wake.ts 三个 idleGate 插入点全在 resume 分支）
  - cold session 天然通过（`agents.get === undefined` → return null）
  - fork/new 忽略（无插入点）
  - defer outcome 不记 run、不烧重试/预算/hourly cap、不设放弃上限（scheduler.ts:229-232 `deferWakeTo` 只改 `nextDueAt`，`recentsFires`/`retries`/`budgetFor` 都不动）
  - 重臂到绝对时刻 = `max(lastEvent+N, now+60s)`（`MIN_IDLE_RECHECK_MS` 地板）
- **与 declared 联动**：min_idle_seconds 进 FILE_DEFAULT_KEYS / ENTRY_KEYS / 同工厂；hash 未变闹钟 no-op 回归测试已就位

## 阻塞问题

无。

## 建议修改

| ID  | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| S1  | `packages/dsh-proactive/src/scheduler.ts:392-396` `skipPastQuiet` 的 every/cron 分支 | `replaceAlarm({ ...alarm, trigger, status: "scheduled", nextDueAt: stamp, ... })` 没有 `runCount + 1` 与 `lastRunAt = stamp`，与 once 分支（走 `advancePast` → `advance` 已加）行为不一致。原始 `advance()` 语义是"任何 occurrence 处理（无论 skip/fail/success）都计数"——目前 once-skip 计数 1，every/cron-skip 计数 0。测试 `assert.equal(ff1.nextDueAt, "2026-09-01T17:00:00.000Z")` 通过是因为 `flush` 500ms 后超时；测试中没有真正校验 `runCount === 1`（断言在 wait 条件里，无独立 expect），所以 bug 被掩盖。 | 在 `replaceAlarm` 前一行补 `runCount: alarm.runCount + 1, lastRunAt: new Date(this.now()).toISOString()`，或在 fast-forward 路径调一次 `advance(alarm, now)` 然后把 nextDueAt 覆盖为 `next.due`——后者能复用 anchor 字段更新逻辑，更干净。同时把 scheduler.test.ts 的 wait 条件 `runCount === 1` 改成明确的 `assert.equal` 才不会再被静默掩盖。 |

## 非阻塞问题

| ID  | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| N1  | `packages/dsh-proactive/src/wake.ts:69` `MIN_IDLE_RECHECK_MS = 60_000` 与 `minIdleSeconds` 的下限关系 | 实际 defer 时间为 `max(lastEvent+N, now+60s)`，因此 `minIdleSeconds` 1..59 全部被地板为 60s 效果，用户无法做"5 秒等待"这种细粒度。当前面板 hint 仅说"re-checked at most once a minute"，没有显式说明"effective spacing floor = 60s"，用户可能以为 1s 也行。 | 在 locales zh/en 的 `minIdleHint` 加一句"effective floor 60 秒（每分钟最多复查一次），故 < 60 效果同 60"。或者把 MIN_IDLE_RECHECK_MS 改为 max(MIN_IDLE_RECHECK_MS, minIdleSeconds * 1000)，但那样会失去"防止逐事件风暴"的安全网；保留地板更好，把地板规则讲清即可。 |
| N2  | `packages/dsh-proactive/src/scheduler.ts:408-438` `nextAwakeOccurrence` 的 cron 分支 | `cursor = base + jitter`，下一轮 `nextCronOccurrence(expr, zone, cursor)` 会取整到下一个分钟边界并丢一格——但 jitter 与"cron 对齐分钟边界"两套语义叠加，若 jitterSeconds 较大（如 60s）会出现"下一个 cron 候选不是 `*/15` 的整 15 分而是 15:30 → 30 → 45 → 60" 的串行偏移。这与原 `advance()` 的 cron 分支同款行为，属于既有的设计选择，不算新 bug；但 plan 没明确说 fast-forward 路径要不要"重对齐到 cron 边界"。 | 可在 fast-forward 注释里加一句"jitter keeps the same drift semantics as advance()"——文档对齐即可，不改代码。 |
| N3  | `packages/dsh-proactive/src/scheduler.ts:425-427` cron 表达式的 trigger["expr"] 未做"整数表/字符表"防御 | `nextCronOccurrence` 内部 try/catch 已经覆盖错误输入；但 `typeof expr !== "string"` 这道防线只看类型不看是否合法 cron 串。corrupt trigger 处理依赖 `parseCron` → `WINDOW_MS` 兜底。 | 在 N2 旁顺手加一行 `if (!isCronExpressionShape(expr)) return undefined;` 提前拦截非 cron 形态，避免每 5 分钟把整个 8 年窗口遍历一次。 |
| N4  | `packages/dsh-proactive/src/wake.ts:415` `sessionLogOf(live.session)` 对超长会话是 O(n) | 长生命周期会话可达上万 events，每次到点都全量扫描。idleGate 仅在到点时触发（频率低），目前不是热路径，但若 min_idle_seconds 设很小且 every 频率高，会有少量额外成本。 | 后续可考虑让 host API 暴露 `lastEventAt(sessionId)`（O(1) tail read），但当前为可接受。 |
| N5  | README/zh 文档中"一个静默门"描述与"冷会话视为已静默"在 fork/new 行为说明上略含糊 | README 说"resume 目标可要求…冷会话视为已静默，fork/new 忽略"，但没说"target_mode=workspace 也是 resume 的一种 source，会受 idle gate 约束"。wake.ts 实现里 workspace/preset source 的 resume 路径**会**走 idleGate，但文档只提"resume"这个词。 | 在 README/zh 的 min_idle 段加一句"workspace/preset source 的 wake 等价于 resume，会受 idle gate 约束；仅 target_mode=fork/new 不受"。 |
| N6  | `packages/dsh-proactive/src/declared.ts` | `parseScheduleFile` 把 `min_idle_seconds` 加进了 entry 的 args 列表，与 `validateCreateArgs` 的 allowed 集保持同步；但未在 plan 示例中演示 file-level `min_idle_seconds` 作为 default 的写法——README 已经补了这一句。 | 已在 README 中体现，无需改。 |

## 准入结论

**结论**：`条件准入`

**说明**：需求覆盖完整、tsc 与 308/308 测试均绿、与 declared sync 的联动前提（hash no-op）由新回归测试守住。唯一需要处理的是 S1——`skipPastQuiet` 的 every/cron 分支与 once 分支在 runCount/lastRunAt 上不一致（once 跳会计数、every/cron 跳过去不计数），现有测试靠 `flush` 超时掩盖了它，建议在合并前补一行 `runCount + 1` 并补一个明确的 assert；其它均为文档/可读性层面的非阻塞观察，可在后续迭代顺带打磨。

- **准入**：无阻塞问题，可进入下一阶段（合并/交付）。
- **条件准入**：无阻塞问题，但存在建议修改项，建议在合并前或后续迭代处理。
- **不准入**：存在阻塞问题，须修复后重新检视。

## 处置记录（实施方）

- **S1 已修**：`skipPastQuiet` every/cron 分支补 `runCount: alarm.runCount + 1` 与 `lastRunAt = 被丢弃的 occurrence 时刻`（与 advancePast 语义对齐）；scheduler.test.ts 的 ff1/ff2 用例补独立 `assert.equal(row.runCount, 1)`（不再依赖 flush 条件），ff1 另断言 lastRunAt。重跑 308/308 绿。
- **N1 已修**：locales zh/en `minIdleHint` 补"有效下限 60 秒（<60 效果同 60）"。
- **N2 已修**：`nextAwakeOccurrence` docstring 补 jitter 漂移语义与 advance() 同款说明。
- **N5 已修**：包 README zh/en min_idle 段明示"session/workspace/preset 来源都算 resume，fork/new 忽略"。
- **N3/N4/N6**：按报告意见不改——N3 的 corrupt expr 已由 `nextCronOccurrence` 内部抛错 → undefined → fail-closed 覆盖；N4 为低频路径可接受；N6 无需改。