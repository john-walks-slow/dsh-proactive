# proactive-alarm-v2 用户验证

## 验证说明

- 验证对象：闹钟模型 v2（干掉 alarm/heartbeat 分类 → 每闹钟"遵从免打扰时段"开关；类型 单次/循环/cron 三种 + 统一 jitter_seconds；目标会话 resume/fork/new 三种）。
- 环境/前置条件：dsh web GUI（http://127.0.0.1:4175）；host 侧改动需**重启 dsh 服务**后生效（重启会中断当前会话，请安排在可接受时段）；client 改动刷新页面即可；可访问真实的 DSH 冷会话（关掉对应会话页签 3 分钟以上保持 cold）。
- 说明：以下自动测试覆盖不到、必须实机交互验证的场景才列入。

## 验证项

| 验证步骤 | 预期结果 | 实际结果 | 状态 | 备注/证据 |
| --- | --- | --- | --- | --- |
| 1. 实机回归：在一个会话里用工具创建 `after_seconds=300` 的闹钟（默认目标=既有会话），关闭会话页保持 cold | 约 5 分钟后会话被唤醒；runs.jsonl 出现该闹钟的 run，decision ∈ {reply, no_reply}，不再是 failed |  | 待验证 | 冷唤醒回归（260906 修复不回归） |
| 2. cron 类型：新建 cron 闹钟（如 `0 * * * *` 每小时整点，目标=既有会话），面板/列表显示类型"Cron"与表达式 | 创建成功且不被频率护栏拒绝（相邻触发 ≥5 分钟）；整点准时触发 |  | 待验证 | `* * * * *` 应被拒绝（frequency_too_high） |
| 3. 免打扰门控：设置"安静时段"为覆盖当前时刻的窗口；创建 respect_quiet_hours=true 的闹钟（如 every 300s）+ 一个 respect_quiet_hours=false 的闹钟 | 时段内：true 的不触发（延迟，结束后再评估）；false 的照常触发 |  | 待验证 | 现 heartbeat/alarm 差异的等价验证 |
| 4. fork 目标：创建闹钟 target_mode=fork（源=一个有多轮对话的会话），到点唤醒 | 侧边栏出现**新的子会话**，其历史 = 源会话已完成回合前缀；唤醒回合落在这个子会话里；runs.jsonl 的 sessionId=子会话 id |  | 待验证 | 子会话保留为真实会话 |
| 5. new 目标：创建闹钟 target_mode=new | 到点后侧边栏出现一个**新建的空会话**并执行唤醒回合；无父历史 |  | 待验证 |  |
| 6. jitter 生效：创建 cron 或 every 闹钟，jitter_seconds=600 | 实际触发时刻 = 计划时刻 + 随机延迟（0-600s）；runs.jsonl firedAt 与计划时刻之差 ∈ (0,600] |  | 待验证 | 多次触发观察非固定值 |
| 7. 面板与旧数据升级：重启后打开"主动唤醒"设置页与会话 tab | 配置卡**无"心跳默认词"**输入框；已有旧闹钟（legacy wakeReason/deliveryHint）正常列出、可编辑/暂停/取消；表格显示 类型（单次/循环/Cron）、目标（会话/分支/新建）、免打扰徽标 |  | 待验证 | alarms.json 升级为 version 2 |
| 8. 归属历史：在 owner 会话 tab 查看 fork/new 闹钟的"历史" | fork/new 的唤醒 run 也出现在 owner 表历史中（或明确落在子会话的 tab 中），可追溯 |  | 待验证 | run 归属规则 |
| 9. 静默与预算回归：一次 no_reply 唤醒 + 检查日预算计数 | no_reply 回合不计预算、GUI 无可见文本；respect_quiet_hours=true 的闹钟在预算耗尽后跳过并记录 |  | 待验证 | 回归项 |
| 10. 重启恢复：闹钟 in-flight 时重启 dsh | 重启后按 bootOverduePolicy 恢复处理，不被卡死 |  | 待验证 | 回归项 |
| 11. 时区缺省：不传 time_zone 创建 cron 闹钟（如 `0 9 * * 1-5`，上午上班提醒），并在 web 会话里发过一条消息后创建 | 创建成功；闹钟按**本机/浏览器时区**的本地 09:00 对齐（不是 UTC）；列表/编辑不回显多余时区字段；显式传 time_zone 时仍以显式为准 |  | 待验证 | 缺省 = 会话 clientTimeZone → 宿主时区 |

## 验证结论

待验证。

## 待跟进

无（验证后填写不通过/受阻项）。