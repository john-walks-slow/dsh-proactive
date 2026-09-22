# 验证要求：new 模式唤醒不再因无 cwd 失败

环境：线上 dsh（web profile），dsh-mnemon `storageScope: workspace` 保持不变。

## V1 — 两个闹钟的下一次触发（止血路径：显式 workspace）

- Luna（`alarm_mu1fwnou4g3okk`）：**2026-09-23 02:00 +08**（`2026-09-22T18:00Z`）
- World Master（`alarm_mu3hilkv3kcnud`）：**2026-09-23 05:00 +08**（`2026-09-22T21:00Z`）

通过标准：
1. `runs.jsonl` 对应 run 的 `decision` 不再是 `failed`（预期 `no_reply` 或 `reply`）。
2. 新会话日志含正常模型请求/回合事件，`turn/end` 无 error；会话目录不再是 `_no-cwd`（应为 luna / yu 工作区 cwd 派生目录）。
3. Luna 的回合应能读到 `/root/agents/luna/memory/` 下内容；WM 应产出 `/root/agents/yu/.life/2026-09-23/events.json`。

## V2 — 根治路径（继承 owner cwd，需 dsh 重启后生效）

任选一个无 workspace 的 new 模式闹钟（可临时 `proactive_set` 一个 `after_seconds` 短闹钟），触发后确认：
1. run 不为 `failed`；
2. 新会话 meta 带 owner 会话的 cwd（会话日志 session 目录 = owner cwd 派生）。

## 回归确认

- resume/fork/every 模式闹钟行为不变（既有 310 项单测全绿 + 线上 JK/rev 心跳闹钟正常）。
