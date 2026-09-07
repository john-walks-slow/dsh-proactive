# remove-push-coupling 用户验证

## 验证说明

- 验证对象：删除 dsh-proactive 与 push 通道（push_notify/send_wechat 推送工具）的全部耦合——`proactive_set` 的 `delivery` 参数、observer 的 push 判定、framing 的 push 回复规则；预算系统保留但语义简化为"可见聊天文本"。这是部署到 web profile 后才可观察的改动（需重启 dsh 服务，会中断当前会话）。
- 环境/前置条件：web profile 已安装更新后的 dsh-proactive 并重启；`$DSH_HOME/proactive/` 下已有历史 alarms.json（含带 `deliveryHint` 字段的旧闹钟为佳）。

## 验证项

| 验证步骤 | 预期结果 | 实际结果 | 状态 | 备注/证据 |
| --- | --- | --- | --- | --- |
| 让模型调用 `proactive_set` 并传入 `delivery` 参数 | 返回 `invalid_trigger`/`invalid_prompt` 类闭式错误（`delivery` 不再是合法参数），不再被接受 | | 待验证 | 工具 schema 已删除该参数 |
| 新建一个正常闹钟（不带 delivery），等一次唤醒 | framing 报文只有 2 条回复规则（no_reply / 简短回复），无 push_notify 建议；`runs.jsonl` 该次 decision 仍为 `reply`/`no_reply`/`failed` 之一，无 `push` 值 | | 待验证 | |
| 触发一次 no_reply 唤醒 | 依然深度静默：`runs.jsonl` decision=no_reply、budgetDelta=0 | | 待验证 | 核心静默路径不受影响 |
| 触发一次正常回复唤醒 | `runs.jsonl` decision=reply、budgetDelta=1，当日预算正常累计 | | 待验证 | 预算机制保留 |
| 面板打开 Proactive 页签，编辑/新建闹钟表单 | 表单无 delivery 通道选项（chat/push/wechat 勾选）；旧闹钟（含 deliveryHint 数据）正常显示不报错 | | 待验证 | client 表单已同步去除 |
| 观察菜单里 proactive_update_settings 的 max_deliveries_per_day 描述 | 描述不再出现 push_notify/send_wechat 字样 | | 待验证 | 措辞已简化 |

## 验证结论

待验证。

## 待跟进

无。