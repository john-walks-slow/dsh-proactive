# 冷会话唤醒「has no provider/model」— 修复总结

日期：2026-09-06

## 背景

dsh-proactive 插件的结衣 JK 会话（`session-a3b2cd17-6798-4edc-b212-6c167edb0dcc`，heartbeat 每 30 分钟）的**每一个冷会话唤醒回合**都以

```
agent "session-a3b2cd17-..." has no provider/model: set AgentOptions.provider
and AgentOptions.model or supply both via the agent/request waterfall
```

失败收场（`runs.jsonl` 全部 `decision=failed`，note `wake turn ended abnormally`）。live 时段的唤醒（用户在微信聊天中）全部正常 —— 所以表现成"jk 的会话一直这样"，实际是**冷唤醒路径从 09-05 14:04 起就没成功过**（iterator 会话冷时同样失败）。

## 根因

完整证据链见本目录 `260906-cold-wake-provider-model.troubleshoot.md`（会话日志切片、runs.jsonl 时间线、代码定位、真实包端到端复现）。一句话根因：

**冷 resume 出来的新 agent-loop 实例第一次 `buildRequest` 只从 `AgentOptions` 取 provider/model（`requestHeaderLogged=false`，不读会话日志里已持久化的 request/header）；而插件 resume 时既没传 provider/model（`ctx.agentDefaultModel.currentSelection()` 在生产进程里取空），也没传 `setup` 安装 `installModelSelection`（web 主机路径每次都装，见 dsh-host-apiproxy 的 `selectionFor`）—— `agent/request` waterfall 没有任何 handler 能补 provider/model，于是必抛。**

辅助事实：

- 早期（人设 patch 前）冷唤醒失败在 `prompt variable "{{model}}" has no value`——`cordis.patch.yml` 的人设注释里赫然写着"唤醒轮 agent.options.model 未定义"；patch 去掉 `{{model}}` 后暴露出现在的 provider/model 错误。
- `settings` RPC 显示 `agent-default-model` 健康（cpa/medium）；但插件作用域读到空——这是唯一未在线上进程直接坐实的一环（`currentModelSelection` 静默 catch 吞掉了原因，本次顺带修复了诊断可见性）。

## 修复内容

| # | 修改 | 说明 |
| --- | --- | --- |
| 1 | `src/wake.ts`：`AgentsFacade.resume` 增加 `setup` 钩子（镜像 dsh-agent 的 setup 契约） | 冷路径 resume 现在传 `setup`，在 agent 作用域安装模型选择 |
| 2 | `src/wake.ts`：`createWakeSelectionRef(header, fallback, log)` 解析水位 | **会话自身 request header → `agentDefaultModel` 兜底 → 都取不到打 warn 并返回 undefined**；`selectionFromHeader` 把 header config 归一成 `ModelSelection`（含 reasoningEffort 透传） |
| 3 | `src/wake.ts`：fire() 冷路径 `installModelSelection(agentCtx, selection)` | 完全镜像 dsh-host-apiproxy `selectionFor` 的模式；`installModelSelection` 返回的 disposer 丢弃安全（waterfall listener 随 agent 作用域自动清理，与 web 路径一致） |
| 4 | `src/index.ts`：`currentModelSelection` 诊断化 | service 缺失 / 无 `currentSelection` / 调用抛错时打 warn，不再静默吞 |
| 5 | `test/wake.test.ts`：3 个新单测 | `selectionFromHeader` 归一化、`createWakeSelectionRef` 回退链（header 优先 / picked 覆盖 / 空兜底 warn / 部分兜底 warn）、冷 resume 必须带 setup |

## 验证状态

- `npm run check`（tsc）通过；`npm test` **110/110 全绿**（含 3 个新用例）。
- E2E（`/tmp/wake-repro/`，真实 dsh 安装包 + 真实 jk 会话副本 + 构建产物）：
  - 修复前复现（Test B/B2）：空 options resume → **逐字**复现线上错误消息；
  - 修复后（Test D）：同为 `modelSelection → undefined` 生产条件，冷唤醒回合**完成**，捕获到 `request/header` `reason=resume`、`config={provider:"cpa", model:"gemini-3-flash"}`（**会话自身模型**，jk 会话 header 里就是它），`turn/end` `kind=completed`，无 warn。
- 效果语义：jk 冷唤醒将用会话自己在用的 gemini-3-flash，而非今天的默认 cpa/medium——与 web 路径行为一致。

## 评审轮（2026-09-06，/spawn-reviewer）

结论 **准入**（0 P0 / 0 P1 / 2 P2 / 4 P3，报告见同目录 `260906-cold-wake-provider-model.review.md`）。已采纳：

- **P2-1**：冷 resume 单测从「只断言 setup 存在」升级为「真实 cordis Context 执行 setup + 驱动 `system-prompt/assemble` / `agent/request` 瀑布断言覆盖」。
- **P2-2**：`agentCtx.agent` 缺失从静默 return 改为**显式 throw**（契约漂移时响亮失败，不再复现原始迷惑错误）。
- **P3**：① 兜底 warn 区分「无 request header」与「header 不完整」；② `WakeResumeSetup` 改为复用官方 `AgentSetup` 类型（上游漂移 tsc 即报）；③ reasoningEffort 透传语义补注释。

修后全量 `npm test` **118/118 绿**（树中另有并发开发中的 session-tab 工作新加入了 8 个用例）；E2E 复跑仍闭环。

## 上线（2026-09-06）

- `lib/` 已同步至 web profile（`~/.dsh/profiles/web/node_modules/dsh-proactive/lib`，25 个文件，修复内容在位），随后重启 dsh 生效。
- 前置发现并处理：JK 闹钟 `alarm_mtfkvz2j3nqik0` 在 13:30:18Z（13:29:34 触发点后 44s）被置为 **paused**（面板 toggle，推测用户暂停）——这就是 13:09 后无更多运行记录的原因。已通过面板 API 恢复 **scheduled**，`nextDueAt` 由 lastRunAt 重算推进为 **`2026-09-06T14:39:03.815Z`**（约重启后 20 分钟内触发，即修复后的首个冷唤醒验证点）。
- 若用户不需要该 heartbeat，可在面板再次暂停。

## 风险与后续注意

- 本轮修复**未上线**：web profile 的 `node_modules/dsh-proactive` 是构建拷贝，需重新同步 `lib/` 后重启 dsh 生效（重启会中断当前会话）。
- 回滚：profile 内的 `lib/` 为旧版本；重启前保留旧拷贝可随时还原。
- 若未来 dsh 的 `setup` 契约漂移，`WakeResumeSetup` 类型需同步（已注释指向官方 runtime-types）。
- 剩余未决项：生产进程里 `ctx.agentDefaultModel` 为何取空 —— 本次的诊断 warn 会在下次冷唤醒时输出到 `/var/log/dsh.log`，届时可知（修复后唤醒不依赖它，仅影响无 request header 的空白会话的兜底质量）。
- `maxDeliveriesPerDay`/每会话每小时唤醒上限不变；唤醒成功后会按 framing 规则可能产出可见投递（jk 闹钟 delivery 含 wechat:true）。