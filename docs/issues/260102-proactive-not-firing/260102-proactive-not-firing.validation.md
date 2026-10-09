# 260102-proactive-not-firing 用户验证

## 验证说明

- 验证对象：dsh-proactive 总闸重新打开后，模型自主唤醒（主动消息）是否恢复；面板与 `proactive_*` 工具是否回到可用状态。
- 环境/前置条件：线上 dsh 已重启（加载新构建产物 + `config.json` 的 `enabled:true`）。重启前 `alarms.json` 里 5 个声明式闹钟全部逾期（`nextDueAt` 停在 2026-10-02）。
- 逾期处置：开闸时 `bootOverduePolicy: "drop"`，逾期 occurrence 直接快进到下一个自然锚点，不补发。稳定后再用 `proactive_update_settings` 改回 `fire`。

## 验证项

| 验证步骤 | 预期结果 | 实际结果 | 状态 | 备注/证据 |
| --- | --- | --- | --- | --- |
| 刷新 dsh GUI，打开 proactive 设置面板 | 面板正常出现（不再是 404 / 空白），能看到闹钟列表与最近 runs | | 待验证 | 关闸期间 `/api/dsh-proactive/state` 返回 404 |
| 看面板里 5 个闹钟的状态与 `nextDueAt` | 5 个闹钟都在 `scheduled`，`nextDueAt` 是**未来**时刻（不是 2026-10-02）；有若干条 `boot overdue: drop policy` 的 skipped run | | 待验证 | 逾期快进是预期行为，不是故障 |
| 等一个自然周期（rev / yu 心跳每 2h，luna 心跳约 3.9h，yu 日记 22:00，luna 深夜 02:00） | 到点出现新的 run；若模型判断无需说话则是 `no_reply`（你不会收到消息），若说话则是 `reply`（你会收到） | | 待验证 | 静默唤醒本来就**不会**打扰你，所以「面板里有 run」比「收到消息」更能证明恢复 |
| 任意会话里让模型 `proactive_list` 一次 | 工具存在并返回闹钟列表（关闸期间该工具不存在） | | 待验证 | |

## 验证结论

待验证。

## 待跟进

- 逾期闹钟快进后，需把 `bootOverduePolicy` 从 `drop` 改回 `fire`（否则以后短时中断期间的 overdue occurrence 会被静默丢弃）。
- `world-master` 的 `world-evolution-5am` 仍**不会**注册：`/root/agents/world-master` 未在 DSH 工作区注册表里，declared 同步解析 `workspace_path` 失败（现在至少会打 warn，见 713d2b7）。要让它生效，需先把该目录注册为工作区。
- `scheduler.test.ts` 的安静时段边界用例在并发全量跑时偶发失败（单跑稳定），属测试脆弱性，未处理。
