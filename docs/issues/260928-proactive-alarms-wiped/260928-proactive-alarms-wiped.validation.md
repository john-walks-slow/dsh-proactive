# 260928-proactive-alarms-wiped 用户验证

## 验证说明

- 验证对象：proactive 闹钟恢复（corrupt 清除 + 6 个 declared 闹钟 + declared sync 修复生效）
- 环境/前置条件：线上 dsh（127.0.0.1:4180）已用修复后 lib 重启；rev workspace 需有活跃会话（用户在 GUI 打开 rev 会话说一句话即可恢复 eligible）

## 验证项

| 验证步骤 | 预期结果 | 实际结果 | 状态 | 备注/证据 |
|---|---|---|---|---|
| 重启完成后打开 proactive 面板（GUI） | 6 个闹钟（decl_* 前缀）全部 scheduled，无 corrupt 报错 | | 待验证 | |
| 重启后 2~3 小时内观察 IM/GUI | rev、yu 心跳闹钟到点主动说话（心跳间隔 2h + 抖动） | | 待验证 | rev 需先在 GUI 说一句话恢复 eligible，否则会 "no eligible session" skip |
| 次日早晨检查（首夜观察） | 凌晨 cron 各自产生成功 run：luna-midnight（02:00）、world-evolution（05:00）、yu-diary（22:00） | | 待验证 | 三者建立以来从未成功过，首夜是关键观察点；若 failed 由 agent 用 dsh 日志抓现场 |

## 验证结论

待验证。

## 待跟进

无。
