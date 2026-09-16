# 260916 循环模式基于上次唤醒时间漂移调度 — 总结

## 背景与需求

用户设置循环模式（如 1 小时间隔 + 30 分钟随机抖动）时，原有逻辑基于创建时的固定绝对时间网格（No-Drift Grid，如 12:00, 13:00, 14:00...）推进。在该逻辑下：
- 若 12:00 的触发因抖动在 12:25 真实唤醒；
- 下一期仍锚定在 13:00 网格，若下期抖动抽中 0 分钟，则 13:00 就会唤醒；
- 导致两次唤醒之间仅相隔 35 分钟，破坏了用户设定的最小循环周期。

用户明确要求：**循环模式希望改成基于上次唤醒时间，允许漂移。**

## 变更内容

1. **漂移计算（`nextDriftingOccurrence`）**：
   - 调度推进时，以本次真实唤醒时刻（`wakeEpoch`，记录于 `alarm.lastRunAt`）为基准起点：
     `nextDueAt = wakeEpoch + everySeconds * 1000 + random(0, jitterSeconds)`。
   - 保障每次唤醒后均保持至少 `everySeconds` 的间隔，抖动向后叠加。
   - 极端超时自愈保护：若因任务执行时间超长或系统休眠导致计算值落入过去（`<= now`），安全重锚至当前时刻向后顺延，杜绝惊群连击。

2. **调度推进与面板联动**：
   - `scheduler.ts`：`advance` 方法在 `alarm.type === "every"` 时切换至 `nextDriftingOccurrence`，并将更新后的 `anchor` 记录为本次唤醒时间戳，保证与旧存储结构兼容。
   - `panel/service.ts`：对已暂停（paused）的 `every` 闹钟执行 resume 时，从恢复时刻重新起算一个周期间隔加抖动。
   - `store.ts`：`isTriggerForType` 对 `EveryTrigger` 的 `anchor` 字段做可选容错支持。

3. **测试验证**：
   - `domain.test.ts`：新增 `nextDriftingOccurrence` 纯函数单测（漂移计算、随机抖动叠加、子阈值拦截、超时重锚）。
   - `scheduler.test.ts`：更新失败重试后的到期时间断言；新增真实唤醒时刻偏离（漂移）场景测试用例。
   - 全部 278 项自动化测试（100% pass）。
