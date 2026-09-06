# 冷会话唤醒 provider/model 修复 — 用户验证

## 验证说明

- 验证对象：dsh-proactive 冷会话唤醒在 `agentDefaultModel` 读空（生产条件）下不再报 `has no provider/model`，并能用会话自身模型完成唤醒回合。
- 环境/前置条件：
  - 修复已部署：web profile `node_modules/dsh-proactive/lib/` 已同步新构建、dsh 已重启（重启会中断会话，安排时机注意）
  - 结衣 JK 会话（或任一有历史 request header 的冷会话）有闹钟在跑（JK heartbeat 每 30 分钟一个，`$DSH_HOME/proactive/alarms.json` `alarm_mtfkvz2j3nqik0`）
  - 观察入口：`/var/log/dsh.log`（`dsh-proactive: …` 行）、`$DSH_HOME/proactive/runs.jsonl`（decision）、会话日志（`request/header` reason=resume）
- 单测已覆盖 `selectionFromHeader` / `createWakeSelectionRef` 回退链 / resume setup 契约（110/110 绿），无需人工复验。

## 验证项

| 验证步骤 | 预期结果 | 实际结果 | 状态 | 备注/证据 |
| --- | --- | --- | --- | --- |
| 1. 冷唤醒成功：JK 会话保持 cold（不与它聊天），等下一个 heartbeat 到点（约 30 分钟内） | `runs.jsonl` 该次 `decision` 为 `reply`/`no_reply`/`push` 之一（不再 `failed`），note 无 `wake turn ended abnormally`；会话日志出现唤醒回合的 `request/header`，`reason: "resume"`，`config.model` 为**会话自身模型**（JK 应为 `gemini-3-flash`）；`/var/log/dsh.log` 无 `has no provider/model` | | 待验证 | 核心验收：与 09-06 13:09 那次的 `failed` 记录形成对照，失败的 seq 是 8683–8689 |
| 2. 诊断可见性：观察重启后的首次冷唤醒时 dsh.log | 若 `ctx.agentDefaultModel` 在生产仍取空，日志出现 `dsh-proactive: ctx.agentDefaultModel is not resolvable from this scope …` 或 `currentSelection() failed …` warn（这是顺带获得的根因信息，不阻塞唤醒）；若取得到则无此 warn | | 待验证 | 可选；回答"生产为何取空"的最后一环 |
| 3. 无模型兜底的空白会话（可选）：新建空会话订一个 alarm，冷态触发 | 若该会话无任何 request header 且 agentDefaultModel 又取空，唤醒失败但**日志有明确 warn**（不再无迹可寻）；正常情况（默认模型可取）应成功 | | 待验证 | 边界场景，非必验 |

## 验证结论

{用户验证后填写总体结论；未完成时写"待验证"。}

## 待跟进

{记录不通过、受阻场景及补充信息；无则写"无"。}