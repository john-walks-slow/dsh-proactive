# 缺陷 2 + 缺陷 3 根因报告 — dsh-proactive 唤醒全失效

> 排障子任务交付。写于 2026-10-02 01:45 (Asia/Shanghai)。
> 背景与已核实事实见同目录 `00-context.md`。
> 缺陷 1（resume/workspace 心跳 100% skipped）由另一条线负责，本报告只在交叉点提及。

## TL;DR

| 缺陷 | 根因 | 置信度 | 状态 |
|---|---|---|---|
| 2（new/fork 100% failed） | **双层叠加**：① dsh-agent 0.1.7 把 `AgentSetup` 签名改为 `(agentCtx, agent)`，插件读 `agentCtx.agent` 抛 `cannot get property "agent" without inject`，`agents.create/resume` 整体失败；② 修好①后暴露：session format v4 废弃 `{kind:"plugin", plugin}` 消息 source，framing 落盘被 `format v4 message requires a producer-owned source kind` 拒绝 | 99%（真实错误已抓取 + 隔离实例修复后三模式全通） | 已修复，e2e 已验证 |
| 2b（顺带，可观测性） | `scheduler.ts` failed 分支把 `result.sessionId` 误传进 `recordRun` 第 5 个位置参数（`reasoningSummary` 字段），真实的 `result.error` 被完全丢弃 | 100%（源码直读） | 已修复，单测锁定 |
| 3（world-master 静默丢弃） | `resolveWorkspaceArg` 对未注册路径返回完整 ToolError，但 `declared.ts` 只塞进 `summary.errors` 数组，**从不逐条输出**（info 行只打 `errors=N` 计数） | 98% | 已修复（逐条 warn），e2e 已验证 |

---

## 缺陷 2：new / fork 唤醒 100% failed

### 2.1 症状与误导性证据

- `runs.jsonl` 里 `decl_830c74233f1a629b`（luna-midnight-free，new）/ `decl_526aea698ea032b7`（yu-diary-10pm，fork）从 2026-09-28 起只记 `wake failed (attempt 1/2/3)`，无错误原因。
- new 模式失败记录带 `reasoningSummary: "session-<uuid>"` 怪值 —— 这是 2b 的误传产物，**不是**分析摘要。
- 9 个失败 run 的 session id 全部不存在于 `/root/.dsh/sessions/`；`state.json.createdSessions` 最后一条记账停在 2026-09-22 —— 说明 `agents.create()` 整体抛异常（0.1.7 的 `createStoredSession` 失败回滚**不留存储残留**，见 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:1820-1833` 注释）。

### 2.2 真实错误的获取（关键步骤）

线上 cordis 的 info/warn 不落盘（`/var/log/dsh.log` 只有 error 与 banner；cordis core 在 web 模式下根本不写 console，唯一默认 exporter 是内存 buffer）。因此：

1. 在 `/tmp/proactive-d2`（主包的隔离副本 + 独立 home，避开共享主 worktree 的 e2e 实例）起最小实例；
2. 写了一个 20 行的 logger-tap cordis 插件（`ctx.logger.exporter({levels:{default:3}, export: appendFileSync})`）经 `--extra` 注入 profile，把全部日志导到文件；
3. 用 declared schedule 文件造 `target_mode: new` 闹钟触发。

抓到的真实错误（tap 日志原文）：

```
wake failed for alarm decl_735e1d9a56d9ec5a: cannot get property "agent" without inject
```

### 2.3 根因 ①：AgentSetup 签名漂移（主因）

**证据链：**

- 插件旧代码 `src/wake.ts`（改前）：`installSelection(agentCtx)` 内 `(agentCtx as {agent: Agent}).agent`，三个 setup 调用点均为 `(agentCtx) => this.composeAgent(agentCtx)`。
- dev-mirror（插件自己的 node_modules）`dsh-agent@0.1.1-rc.2` 类型：`AgentSetup = (agentCtx: Context) => ...`（单参数，agent 挂在 scoped ctx 上）。
- 运行时宿主 `dsh-agent@0.1.7-rc.2`：`AgentSetup = (agentCtx: Context, agent: Agent) => ...`（`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent/lib/types/index.d.ts:34-46`），factory 调用点 `dsh-agent-loop/lib/index.js:1874`：`setup?.(prepared.agent.ctx, prepared.agent)`。
- 0.1.7 中 `agentCtx.agent` 变为 inject 门控的服务属性：读它即抛 `cannot get property "agent" without inject`（cordis 上下文代理的标准错误，与历史上 `cannot get property "webserver" without inject` 同族）。
- 核心自己的 canonical 模式（`dsh-api-session-controller/lib/index.js:354-371` `composeAgent`）：`setup: async (agentCtx, agent) => { this.installSelection(agent); await presets.mount(agentCtx, resolvedId); }` —— **agent 永远走第二参数**。
- 时间线吻合：0.1.7 核心安装于 2026-09-28 20:25（`/usr/lib/node_modules/@deepseek-ai/dsh/package.json` mtime），首个 new 模式失败 run 为 2026-09-28T18:00:18Z = 09-29 02:00 (+08)。

**为什么单测全绿、线上全炸**：测试用 `Object.defineProperty(agentCtx, "agent", {value: wakeAgent})` 模拟旧契约（own property 绕过 inject 检查），`test/wake.test.ts:483/546/581`、`test/target-v3.test.ts:533` —— 类型层钉在 0.1.1 上，运行层是 0.1.7，双层失配不可见。

**波及面**：`agents.resume` 的 setup 走同一条 `composeAgent` 路径 —— **冷 resume 唤醒同样 100% 中招**。线上 resume 闹钟因缺陷 1（workspace resolver 无合格会话）在更早处 skip，掩盖了这一层；e2e 验证中 resume 模式修复后完整跑通（见 §2.6）。

### 2.4 根因 ②：session format v4 废弃 plugin source 包装（叠加层）

修好①后，e2e 里 new 模式 create 成功、turn 跑完，但：

- 会话日志只落了 3 个 setup 事件，framing/turn 事件全部没写盘；
- tap 抓到 `dispose failed for resumed handle: format v4 message requires a producer-owned source kind`；
- `session-projection-cache` 同源报错。

**证据链：**

- 宿主当前 `SESSION_FORMAT_VERSION = 4`（`dsh-session/lib/index.js:56`）。
- v4 编码路径 `dsh-session-format-v3-to-v4/lib/index.js` 的 `releasedV4SessionFormatCodec.encodeEvent` → `assertV4RowAdmission` → `assertV4SourceRowAdmission` → 对 `kind === "plugin"` 的消息 source 抛 `format v4 message requires a producer-owned source kind`（约 :126/:300）。
- v4 的正确拼法（同包 `producerKind`/`rewritePluginSource`）：`{kind:"plugin", plugin:"X", ...}` → **`{kind:"plugin:X", ...}`**（producer-owned，`plugin` 字段删除，form/summary 保留）。
- 插件的 framing（`src/framing.ts`）、tombstone 与 exchange notice（`src/compact.ts` ×2）三处都在构造旧拼写。
- 内存层（`assertMessageEventShape`）接受任意非空 kind，所以事件先进内存、落盘时才炸 —— 造成「turn 在内存里跑完、磁盘上什么都没有」的诡异形态。
- 线上 `/var/log/dsh.log` 里 dsh-taskboard 的 7 条同文报错旁证了 v4 admission 在运行时是活的。

### 2.5 修复内容（全部已落在主工作区并构建）

| 文件 | 改动 | 目的 |
|---|---|---|
| `src/wake.ts` | 新增本地 `WakeSetup = (agentCtx, agent) => ...` 类型（dev-mirror 0.1.1 类型已失真，不能再用 `AgentSetup` 钉）；`installSelection`/`composeAgent` 改收 `Agent` 参数；三处 setup lambda 改双参 | 根因① |
| `src/index.ts` | `agents: ctx.agents as unknown as AgentsFacade`（附注释说明 dev-mirror 与运行时契约漂移） | 根因①的类型装配 |
| `src/framing.ts` | 新增 `PROACTIVE_SOURCE_KIND = "plugin:dsh-proactive"` 与 `proactiveNoticeSource()` helper；framing source 改用 v4 拼法 | 根因② |
| `src/compact.ts` | tombstone / exchange notice 两处 source 改走 `proactiveNoticeSource()` | 根因② |
| `src/observer.ts` | `isFramingNotice` 双拼写锚定：`kind === "plugin:dsh-proactive"`（v4 主）或旧 `{kind:"plugin", plugin:"dsh-proactive"}`（预迁移日志/回放 fixture） | 根因②的锚定兼容 |
| `src/scheduler.ts` | `runWake` 返回类型补 `error?: string`；failed 分支 note 改为 `wake failed (attempt N): <真实错误>`；sessionId 传回**最后一个**位置参数（不再误入 reasoningSummary） | 缺陷 2b |
| `src/declared.ts` | `summary.errors` 每条以 `log("warn", "declared schedules: " + error)` 逐条输出 | 缺陷 3 |
| `test/wake.test.ts` ×3、`test/target-v3.test.ts` ×1 | setup 执行改双参 `(agentCtx, agent)` | 测试契约同步 |
| `test/framing.test.ts` | source 断言改 v4 拼法 | 测试契约同步 |
| `test/scheduler.test.ts` | `Outcome.error` 字段 + 新增回归测试：failed note 必须含错误原文、sessionId 必须落在 `sessionId` 字段且 `reasoningSummary` 必须为空 | 锁定 2b |

注：`src/index.ts` / `src/workspace.ts` / `test/workspace.test.ts` 里的 cold-headers 改动来自缺陷 1 排查线，不在本报告范围。

### 2.6 验证结果

**隔离实例（/tmp/proactive-d2 独立 worktree + 独立 home + logger-tap 插件 + cpa/medium 真模型）**：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| new 模式 declared 闹钟 | `wake failed (attempt 1/2/3)`，真实错误 `cannot get property "agent" without inject`（tap 可见，runs.jsonl 不可见） | `decision:"reply"`, `replySummary:"awake"`, budget+1，会话落盘（v4），framing 以 `kind=plugin:dsh-proactive` 持久化，createdSessions 记账 ✓ |
| fork 模式（workspace source，有合格父会话） | 同上 | `decision:"reply"`, `replySummary:"forked"`，fork 子会话落盘 + 记账 kind=fork ✓ |
| resume 模式（workspace source，冷唤醒用户会话） | （缺陷 1 修复后才能到达；同样会中 setup 雷） | `decision:"reply"`, `replySummary:"resumed"`，唤醒目标为用户会话本体 ✓ |
| 模型选择 waterfall | — | request/header 落 `provider:cpa, model:medium`（agentDefaultModel → installModelSelection 链路活）✓ |

**单测（主工作区，`tsc -p tsconfig.json` + `node --test`，仅受影响模块）**：wake / target-v3 / scheduler / declared / observer / compact / framing / workspace 共 185 例，180 过 5 败 —— **5 个失败全部为预存失败**（compaction 的 applyWakeCompaction ×3 与 silent-wake ×2，在未改动的主包上逐字相同地失败，与本次改动无关，建议另开 issue）。

### 2.7 已验证 vs 待验证

**已验证（隔离实例 + 单测）**：
- 根因①②的真实错误原文提取与定位；
- new/fork/resume 三模式完整唤醒链路（含真 LLM 调用、落盘、预算、run 记录）；
- 缺陷 2b 的 note 携带错误原文 + sessionId 字位（新增回归测试）；
- 缺陷 3 的逐条 warn（e2e 实测：未注册 workspace 的条目每轮询周期输出完整原因）；
- 主工作区构建产物含全部修复（lib/ grep 验证）。

**待验证（需重启线上 dsh 才能确认，本人不执行重启）**：
- 线上 `/root/.dsh/profiles/web`（link 到本包）下次重启后：
  - luna-midnight-free（new）应产出真实会话并 reply/no_reply；
  - yu-diary-10pm（fork）——**依赖缺陷 1 的修复**（workspace resolver 得先能选出父会话），resolver 通了之后 fork 链路本身已验证；
  - 心跳类 resume 闹钟在缺陷 1 修复后将首次走到 setup 路径，本修复使其不再中雷；
  - runs.jsonl 的 failed 记录从此携带错误原文。
- 注意：线上 dsh 进程（10-01 16:34 启动）已加载旧模块，本次重建 `lib/` **不会**热生效（生产 profile 无 module-root HMR）；需按 restart-dsh skill 流程（先隔离实例验证，再征得用户同意）重启。

---

## 缺陷 3：world-master 的 declared schedule 完全未注册

### 根因

`/root/agents/world-master` 未注册为 DSH workspace（`storages/workspace.json` 无此路径）。declared sync 流程：

1. `prepareEntry`（`src/declared.ts:326-337`）调 `resolveWorkspaceArg({target_workspace_path: ...})`；
2. `resolveWorkspaceArg`（`src/workspace.ts:205-211`）对未注册路径返回 ToolError：`"no workspace is registered for path /root/agents/world-master (register the directory as a workspace in the GUI sidebar first)."` —— **错误信息本身是完整且可行动的**；
3. `syncDeclaredSchedules`（`src/declared.ts:400-404`）把它 push 进 `summary.errors` + `keptIds`；
4. 但汇总日志只打 `declared schedules: +0 ~0 -0 skippedPast=0 errors=1`（`src/declared.ts:476-479`，改前），**逐条 error 从不输出**；面板也不暴露 sync 错误（panel/service 无 declared 字段）。

→ 用户侧表现：entry 静默消失，零线索。这是设计缺陷（错误被聚合吞掉），确认属实。

### 修复

`src/declared.ts`：sync 收尾处逐条 `log("warn", "declared schedules: " + error)`。e2e 实测输出：

```
declared schedules: /tmp/proactive-repro/d3-unregistered.json [d3-bogus-workspace]: path /tmp/.../NOT-A-REGISTERED-WORKSPACE does not exist or is not registered as a workspace (register the directory in the GUI sidebar first).
```

（每 schedulePollSeconds 一轮，持续可见。）

### 方案对比：为什么选「响亮报错」而不是「自动注册」

- workspace registry 有程序化 `create(path, title?)` API（`dsh-workspace/lib/types/index.d.ts:139-145`），自动注册技术上可行；
- 但 workspace 是用户可见的全局状态（侧边栏、storages）：后台插件每 15s 轮询时静默创建 workspace 记录，对用户是意外副作用，schedule 文件里的路径笔误也会铸造垃圾 workspace；
- 一次的 GUI 注册动作（world-master 目录在侧边栏 "Add workspace"）即可让 entry 生效，且有明确的所有权语义。
- 若后续产品上想让 world-master 类「无人值守 agent 目录」开箱即用，可在 GUI/安装器层做注册，而不是唤醒插件内做。

### 让 world-evolution-5am 生效的运维步骤（代码外）

在 GUI 侧边栏把 `/root/agents/world-master` 注册为 workspace（一次性）。注册后下一轮 sync（≤60s）即会创建 `decl_<sha256>` 闹钟。**建议等线上 dsh 重启（缺陷 2 修复生效）后再注册**，否则 5am 的 new 模式唤醒会以旧代码失败三连。

---

## 验收标准（建议写入 .validation.md，供用户实机确认）

1. 重启线上 dsh 后，次日凌晨 2 点 luna-midnight-free 触发：`runs.jsonl` 出现 `decision:"reply"|"no_reply"` 记录，`/root/.dsh/sessions/--root-agents-luna--/` 出现当日新 session 目录（内含 `session.v4.jsonl.zstd`）。
2. 若任一唤醒仍失败：`runs.jsonl` 的 note 形如 `wake failed (attempt N): <真实错误>`，不再是裸 attempt 串。
3. GUI 注册 world-master workspace 后 ≤60s，`alarms.json` 出现 `decl_*`（entry `world-evolution-5am`）闹钟；未注册期间 cordis warn（经 `dsh web` stderr/任何日志导出器）可见逐条原因。
4. 回归：心跳 resume 闹钟在缺陷 1 修复后能真实唤醒工作区最新用户会话。

## 置信度与残余风险

- 根因①②：99%。双层均有错误原文实证 + 修复后全链路通过；残余 1% 在于线上环境可能有 e2e 未覆盖的第三层（如 agentDefaultModel 当前值 `cpa/low` 的 effort 解析——已核查 cpa/low 为合法模型 id，且 e2e 用 cpa/medium 无 effort 完整跑通，风险低）。
- 缺陷 3：98%（机制直读源码 + e2e 复现修复前后对比）。
- 已知未修（超出本任务范围，建议另开 issue）：compact.test.ts 3 例 + wake.test.ts 2 例预存失败（applyWakeCompaction / silent-wake collapse 断言，与 isSurfaceEvent 或平台 surface 契约相关）。
