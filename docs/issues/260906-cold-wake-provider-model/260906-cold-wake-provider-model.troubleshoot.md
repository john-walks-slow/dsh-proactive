# 冷会话唤醒「has no provider/model」— 根因排查记录

日期：2026-09-06
结论：**确诊 + 已修复（含端到端复现）**

## 现象

用户在 2026-09-06 21:xx 贴出本会话（结衣 JK）的唤醒失败：

```
本轮运行失败 agent "session-a3b2cd17-6798-4edc-b212-6c167edb0dcc" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall
```

并问"为啥（jk 的会话）一直这样"。

## 排查过程

### 1. 时间线（runs.jsonl，`$DSH_HOME/proactive/`）

- 09-05 14:04 起：JK 闹钟 + iterator 会话闹钟的**冷唤醒全部失败**（`decision=failed`、note `wake turn ended abnormally`）。
- 09-06 08:22:14（iterator，live 会话）与 08:29:56（JK）两次成功——都发生在用户与 agent 交互（live）期间。
- 结论：**冷会话唤醒从有记录以来从未成功过**；jk 的 heartbeat 每 30 分钟一次且几乎总是冷会话，所以显得"一直这样"。

### 2. 会话日志（`~/.dsh/sessions/--root-agents-jk--/session-a3b2cd17-…/session.jsonl.zstd`，解压 2172 行）

- turn 39–45（09-06 08:22–08:46 UTC）全部成功：用户在微信上聊天，agent **live**，唤醒复用 live agent → 正常（甚至真发了 `send_wechat`）。
- `session/end-seed`（seq 8616）→ agent 被 dispose。
- turn 46、47（首个冷唤醒）：报 `prompt variable "{{model}}" has no value for this assembly (section deployment:persona)` ——**旧人设 bug**。
- 重启（persona patch 生效）后 turn 48–54（09-06 05:50–13:09 UTC）：报 **`has no provider/model`**，报警回合 seq 8683–8689：`turn/start → step/start → user/message(PROACTIVE WAKE check_in) → step/end → turn/end {kind:"error", code:"UNKNOWN"}`，**没有 request/header 事件**（buildRequest 在 append header 之前抛错，line 732 前）。
- `cordis.patch.yml` 人设 patch 的注释明证：原行含 `{{model}}`，"在自动轮（inbox 注入/唤醒轮）agent.options.model 未定义时会抛 …"——patch 前就已知唤醒轮 `options.model` 是 undefined。

### 3. 代码定位

- `dsh-agent-loop/lib/index.js`（装于 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`，repo 与线上一致）：
  - line 693–714 `buildRequest`：`route = { provider: this.options.provider ?? "", model: this.options.model ?? "" }`；seed 用 `this.requestHeaderLogged ? persistedHeader : route`——**新 resume 实例 `requestHeaderLogged=false`，seed 只来自 AgentOptions**；line 714 抛 `agent "…" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`。
  - line 1279–1315 `resume`/`setupAndPublish`：唯一能从外面补 provider/model 的口子是 `options.agentOptions` 与 `options.setup`（安装 `agent/request` waterfall handler）。
- `dsh-agent/lib/types/model-selection.js` `installModelSelection`：既是 `system-prompt/assemble` 也是 `agent/request` handler；**这是唯一会给 waterfall 填 provider/model 的 handler**。
- web 正常路径（`dsh-host-apiproxy` `ensureSession`/`selectionFor`，line ~1692–1759、2098–2102）：resume 传 `agentOptions()` **并且** `setup: composeAgent(preset).setup`（安装 `installModelSelection(agent, {current:…})`，`current` 解析水位：内存 picked → 会话 `requestHeader()?.config` → `defaults.defaultModelSelection()`）。→ 所以 web 唤醒从不出这错。
- 我们的插件（`wake.ts` fire 冷路径，旧版 line 80–88）：`agentOptions` **只**来自 `currentModelSelection(ctx)`（读 `ctx.agentDefaultModel.currentSelection()`，try/catch 全吞），**不传 setup** → resume `{}` → waterfall 无源 → line 714 必抛。
- `currentModelSelection` 在生产拿空的原因未在进程内坐实（settings RPC 显示 `agent-default-model` 健康 cpa/medium；独立 cordis 复现也解析成功）；本轮把静默 catch 改成 warn，下次冷唤醒会在 `/var/log/dsh.log` 输出原因。**注意：修复后唤醒不依赖它**（会话 header 优先），仅影响无 header 的空白会话。

### 4. 端到端复现（`/tmp/wake-repro/`，真实 cordis/dsh-agent/dsh-agent-loop/dsh-session… + 真实 jk 会话副本 + 构建产物）

| 场景 | 结果 |
| --- | --- |
| Test A：resume 带 `{cpa, medium}` options | 回合完成（decision=reply） |
| Test B/B2：空 options（复现生产；B2 手动裸 resume） | **逐字复现**线上错误消息 |
| Test C：空 options + setup 装 `installModelSelection`（读会话 header） | 回合完成 |
| Test D：**修复后的真实插件** `modelSelection→undefined` 冷唤醒 | 回合完成；`request/header` `reason=resume` `config={provider:"cpa", model:"gemini-3-flash"}`；`turn/end` completed；无 warn |

### 因果链（一句话）

冷 resume → 新 loop 实例 seed 只读 AgentOptions → 插件 agentOptions 依赖的 agentDefaultModel 读空 + 没装模型选择 waterfall → buildRequest 抛错 → observer 判 failed。

## 修复

见同目录 `260906-cold-wake-provider-model.summary.md`（commit 4ce04e0：setup 钩子 + `createWakeSelectionRef` 会话 header 优先回退 + currentModelSelection 诊断化 + 测试）。

## 遗留

- 生产进程 agentDefaultModel 取空原因：待下次冷唤醒的 warn 日志揭晓（非阻塞，已不依赖）。
- 部署生效：需同步 web profile 的 `node_modules/dsh-proactive/lib/` 并重启 dsh。