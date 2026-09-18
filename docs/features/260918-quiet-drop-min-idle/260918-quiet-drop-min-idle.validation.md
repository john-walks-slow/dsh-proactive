# 260918 安静时段直跳 + min_idle_seconds 用户验证

## 验证说明

- 验证对象：① `respect_quiet_hours=true` 的闹钟在安静时段内改为**直接跳过**（once 完成、循环型快进到窗外下一锚点，不再 08:00 补发）；② 新参数 `min_idle_seconds`（resume 目标：目标会话静默满 N 秒才唤醒，活跃时顺延）。
- 环境/前置条件：**新代码需 dsh 重启后生效**（lib/ 已构建并硬链接进 web profile；与 declared-schedules 功能共用同一次重启窗口，重启需你书面同意）。面板在设置页/会话 tab 可观察闹钟 nextDueAt 与 run 历史。

## 验证项

| 验证步骤 | 预期结果 | 实际结果 | 状态 | 备注/证据 |
| --- | --- | --- | --- | --- |
| 1. 重启后建一个 once 闹钟：`proactive_set { prompt:"quiet 测试", at:"今晚 23:30（本地）", respect_quiet_hours:true }`，等它到点后看面板 run 历史 | run 记录为 skipped、note 含 "quiet hours: once alarm due inside the quiet window is dropped"；闹钟状态 completed；**次日 08:00 不会补发** | | 待验证 | |
| 2. 建一个 every 循环闹钟（`every_seconds:300, respect_quiet_hours:true`）让它跨过 23:00，观察面板 nextDueAt | 跨窗后 nextDueAt 直接跳到**次日 08:00 之后的第一个锚点**；期间 runs 只新增一条 skipped（"skipped N occurrences"），无逐分钟记录 | | 待验证 | |
| 3. 对当前活跃使用的会话建 `proactive_set { prompt:"min-idle 测试", after_seconds:60, min_idle_seconds:600 }`，然后继续正常使用该会话 | 到点后面板 nextDueAt 顺延（最后活动 +10min），runs 无新记录；停止使用满 10 分钟后正常唤醒 | | 待验证 | |
| 4. 现有线上闹钟回归：4 条既有 heartbeat/叙事闹钟在非安静时段照常触发；declared 闹钟（wake_schedule.json）同步不受影响 | 触发行为与改动前一致 | | 待验证 | |

## 验证结论

待验证

## 待跟进

- 无（单测已覆盖快进数学/边界/defer 滑动/declared no-op 回归；上表为实机面验证）。
