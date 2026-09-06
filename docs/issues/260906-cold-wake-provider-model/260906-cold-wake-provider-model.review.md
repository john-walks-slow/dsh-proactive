# 冷会话唤醒 provider/model 修复评审（commit 4ce04e0）

> 日期：2026-09-06 · 评审对象：commit `4ce04e0`（`src/wake.ts` +97/-11、`src/index.ts` +26、`test/wake.test.ts` +89）· 基线：`4ce04e0`（其后 a2350a1 仅为配套总结/验收文档）
> 评审方式：源码走读 + 平台 .d.ts 与运行时实现逐字交叉核对（安装版 `@deepseek-ai/dsh-agent` 0.1.1-rc.2、`dsh-agent-loop`、`dsh-host-apiproxy` 的 `selectionFor`、`dsh-session` 的 `EpochHeader`）+ 干净 worktree 独立复验（tsc + 110/110 单测，取真实退出码）+ E2E 证据复核（`/tmp/wake-repro/run-fixed.mjs`）

## 0. 结论摘要

| 级别 | 数量 | 摘要 |
|---|---|---|
| P0 阻断交付 | 0 | — |
| P1 必修 | 0 | — |
| P2 建议修 | 2 | ① 冷 resume 单测**不执行 setup 回调**：假 resume 只存 `options` 从不调用，断言仅 `typeof lastOptions.setup === "function"`——本修复核心接线（`agentCtx.agent` 提取、`installModelSelection` 调用、瀑布事件名漂移）回归时测试仍全绿，测试名「installs a model-selection setup」超出实际断言范围；建议捕获 setup 后用真实 cordis `Context` + 假 agent 执行它，并对 `agent/request` 瀑布派发断言 override 生效（cordis 已在 devDependencies）。② setup 内 `agentCtx.agent === undefined` 时**静默 return**：web 主机 `installSelection` 同情形是 **throw**。若未来 dsh 把 agent 关联推迟安装，本修复会静默失效、原始生产错误复现且无任何诊断；建议该分支至少打 warn，或镜像 web 主机 throw。 |
| P3 可后置 | 4 | 兜底 warn 文案精度（「header 存在但不完整」误报「no committed request header」）；`currentModelSelection` apply 时诊断 warn 在 headless 等无 agentDefaultModel profile 每次启动一条（一次性，可接受）；`WakeResumeSetup` 自声明未复用 `AgentSetup`（结构已核对等价，但上游漂移 tsc 不报警）；reasoningEffort 透传与 `adapterDefaults.reasoningEffort=true` 的交互未注释（与 web 主机同款行为，非缺陷） |
| 亮点 | — | 修复机制与 dsh-host-apiproxy `selectionFor` **完全同构**（picked → 会话 header → 默认，`assembled: undefined` 初值一致）；契约逐字核对一致；**真实 E2E 在 production 条件（`modelSelection → undefined`）下闭环**：冷唤醒完成、捕获 `request/header reason=resume`、`config={provider:"cpa",model:"gemini-3-flash"}`（会话自身模型）、`turn/end kind=completed`、无 warn |

**总体判断：根因定位正确、修复机制与 web 主机同源、运行时契约逐字验证、真实代理路径 E2E 闭环，未发现 P0/P1。P2 两条为测试加固与防御性诊断，均不影响功能正确性。结论：准入。**

## 1. 需求与基线

- 问题：jk 会话（`session-a3b2cd17-...`）每个冷唤醒回合以 `agent "..." has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall` 失败。
- 根因链（troubleshoot.md 已坐实）：① 冷 resume 的新 loop 实例首次 `buildRequest` 只从 AgentOptions 取 provider/model（`requestHeaderLogged=false`，不读持久化 `request/header`）；② 插件 resume 既不给 provider/model（`agentDefaultModel.currentSelection()` 生产取空）、也不传 `setup` 安装 model-selection → `agent/request` 瀑布无 handler 可补；③ 必抛。
- 修复：resume 传 `setup` 安装 `installModelSelection`（镜像 web 主机 `selectionFor`），解析水位 = 会话 request header → `agentDefaultModel` 兜底 → 都取不到 warn。

## 2. 复验记录（本次会话实测）

| 项目 | 结果 |
|---|---|
| 干净 worktree @`4ce04e0` `npm run check`（tsc --noEmit） | ✅ 退出码 0 |
| 干净 worktree @`4ce04e0` `npm test`（tsc + node --test） | ✅ **110 passed / 0 failed**（真实退出码 0，`| tail` 掩码已用 `PIPESTATUS` 复核） |
| 主工作树旁注 | ⚠️ 当前 checkout 因**未提交**的 session-tab WIP（`src/client/panel.tsx` 已修改、`sections.tsx`/`use-locale.ts` 未跟踪等）`tsc` 报 TS2307/TS2345/TS2686 三错——与 `4ce04e0` 无关（commit 未触碰这些文件），已用 worktree 隔离复验证明提交本身全绿 |
| 契约核对 | `AgentSetup` / `ResumeAgentOptions.setup` / `ModelSelection` / `ModelSelectionRef` / `installModelSelection` / `EpochHeader.config`（`LlmCallConfig`）与安装版 0.1.1-rc.2 `.d.ts` **逐字一致** |
| 时序核对 | `ReactLoopAgent` 构造即 `this.ctx = this.scope.ctx.extend({ agent: this })`（dsh-agent-loop lib/index.js:377），`setupAndPublish` 随后 `setup?.(prepared.agent.ctx)`（:1260）→ **setup 执行时 `agentCtx.agent` 必可用** |
| E2E 复核 | `/tmp/wake-repro/run-fixed.mjs`：真实 DSH 安装包 + 真实 jk 会话副本 + 构建产物 `lib/wake.js` + `modelSelection → undefined`（生产条件）→ `outcome ok`、`request/header reason=resume`、`config={cpa, gemini-3-flash}`、`turn/end kind=completed`、无 warn |

## 3. 检视点① — setup 钩子类型与 dsh-agent 真实契约

- `AgentSetup = (agentCtx: Context) => AgentSetupCommit | Promise<AgentSetupCommit \| void> \| void`、`AgentSetupCommit = { commit(): void }`（dsh-agent lib/types/index.d.ts:45-57）；`ResumeAgentOptions.setup?: AgentSetup`（:139）。插件 `WakeResumeSetup` 与之**结构逐字段相同**，`ResumeFacadeOptions` 也是 `ResumeAgentOptions` 的子集（少了可选的 `signal`）——`ctx.agents` 直接赋值给 `AgentsFacade`（index.ts:75）类型成立（tsc 实证）。
- 调用时序：`resumeWith` → `setupAndPublish` → `prepare()`（构造 `ReactLoopAgent`，构造器内 `ctx.extend({agent: this})`）→ `setup?.(prepared.agent.ctx)`。即 setup 收到的是**该 agent 自己的作用域 ctx**，`agentCtx.agent` 关联已就位；`(agentCtx as unknown as { agent: Agent })` 的 cast 只是绕开模块增强在 `import type` 下的不可见性，运行期已验证。✓
- commit 语义：插件 setup 返回 void（不返回 commit）——契约允许（`| void`），不需要发布校验。✓
- 结论：类型与时序**一致**。

## 4. 检视点② — installModelSelection disposer 丢弃是否安全

- 实现（lib/types/model-selection.js）：两个 `agentCtx.on(...)` **scoped** 监听——`system-prompt/assemble` 在 `await next()` 前后快照 `selection.current` 入 `selection.assembled` 并把 provider/model 注入 prompt 变量；`agent/request` 在 `await next()` 之后用 `assembled` **强制覆盖** provider/model/effort。
- 机制闭环：dsh-agent-loop `buildRequest`（lib/index.js:695-714）首次请求 seed 只取 `{...route, reasoningEffort?, maxTokens?}`（`requestHeaderLogged=false` 时），瀑布后 `!proposedConfig.provider \|\| !proposedConfig.model` 才 **throw** → 本 ref 正是补上 provider/model 的那个瀑布 handler；E2E 已证明该路径真实生效（header `reason=resume`）。
- disposer 丢弃安全性：`ctx.on` 监听随 agent 作用域 dispose 自动清理；fire() 的 `finally` **必** `ownedHandle.dispose()`（含 busy/异常早退路径）；resume 内 setup 之后失败则由 `setupAndPublish` 的 catch → `prepared.dispose()` 回滚清理。三条路径都无泄漏。web 主机同样丢弃 disposer（selectionFor 只把 ref 存 Map），行为一致。✓
- 结论：**安全**，无泄漏、无双装风险（每 resume 一个新 ref，agent 生命期与 ref 对齐）。

## 5. 检视点③ — createWakeSelectionRef 回退链边界

- **picked 覆盖**：`set current` 持久化进闭包、`get` 先查 picked——与 web 主机 `selectionFor` 逐字同构；设回 `undefined` 会清除并回落链（web 同语义）。测试覆盖 ✓。
- **header 只有 provider 缺 model**：`selectionFromHeader` 任缺即返回 undefined → 整链落 `agentDefaultModel`。类型层此分支理论上不可达——`LlmCallConfig.provider/model` 必填，且 buildRequest 在 append `request/header` **之前**必先通过 provider/model 检查，故已提交 header 必然完整；该防御只对损坏/陈旧日志生效，方向安全。唯一瑕疵是**兜底 warn 文案**（见 P3.1）：header 存在但不完整时仍打「no committed request header」，与事实不符。
- **reasoningEffort 透传**：与 web 主机逐字一致（含 `EpochHeader.config` 可空 effort 的展开逻辑）；`adapterDefaults.reasoningEffort=true`（effort 为 adapter 派生）时透传会冻结派生值——web 同款，非分歧，仅建议注释（P3.4）。
- **双空终点**：warn + `undefined` → 瀑布 seed 仍空 → buildRequest throw → fire 返回 failed → scheduler 有界重试（`maxRetriesPerFire`）后 terminate。**修复前后失败路径完全相同，区别是修复前无任何 warn、现在有明确 warn**——诊断提升达成。warn 每次组装触发一次（单步唤醒至多一次），无刷屏。
- **eager vs lazy**：本修复在 setup 时一次性捕获 header（`createWakeSelection`），web 主机在每次 `current` 读取时惰性读。对一次性唤醒回合等价且更稳定（冻结于 resume 时刻，免疫回合内并发 header 突变）；若未来唤醒回合支持回合中换模型需改惰性——记录即可，不修。
- 结论：边界正确，行为与 web 主机对齐。

## 6. 检视点④ — 对 dsh 未来版本 setup 契约漂移的兼容

- 类型层：`WakeResumeSetup` 自声明而非 `import type { AgentSetup }`——结构等价已核对，但上游改名/改签时 tsc **不报警**（P3.3，注释已指向官方 runtime-types，可接受）。
- 运行层（P2.2 的实质）：`agentCtx.agent === undefined` 时静默 return。当前契约下不可达（§3 时序证明），漂移时则本修复整体静默失效、原始错误复现。这是全 diff 唯一「失败无痕」的分支，建议与 web 主机对齐（throw）或至少 warn。
- 版本韧性：`installModelSelection` 由类型导入升级为**值导入**（peerDep `^0.1.1-rc.2`，安装版已含该导出 ✓）；setup 契约若未来要求必返 commit，本闭包返回 void 也只会损失校验不抛错，最坏退化为「无 setup」行为，可回滚恢复。✓

## 7. 检视点⑤ — 测试覆盖质量

- `selectionFromHeader`：undefined / 全量 / reasoningEffort 透传 3 场景 ✓；缺 partial-header 用例（类型层不可达，价值低）。
- `createWakeSelectionRef`：header 优先 / picked 覆盖 / 无 header 走默认 / 空兜底 warn / 部分兜底 warn 5 场景 ✓；缺「header 存在但不完整→落默认」用例（同上，低价值）与重复读取的 warn 幂等断言。
- **冷 resume setup 用例（P2.1）**：`assert.equal(typeof lastOptions.setup, "function")`——假 resume 从不调用 setup，断言不了提取逻辑、安装调用、事件名；测试名「installs a model-selection setup and lets the turn proceed」名不副实。这是本修复核心路径唯一缺失的单测层（真实代理路径由 E2E 承重，符合模块「真实 agent 路径只能 E2E」的测试哲学，故非 P1；但 setup 闭包本身是纯插件逻辑，完全可以单测）。
- 建议：捕获 setup 后构造 `new Context()`（`@deepseek-ai/cordis` 已是 devDependency）+ `ctx.extend({ agent: fakeAgent })`，执行 setup，然后 `await ctx.parallel("agent/request", payload, () => seed)` 断言返回被覆盖为 header 模型；顺带覆盖 `agentCtx.agent` 缺失分支（断言 warn/throw）。
- E2E 质量：真实安装包 + 真实持久化会话 + 生产条件 + 落盘 header 断言——承重验证充分。

## 8. P3 细节（不阻塞）

1. **warn 文案**（wake.ts:218）：header 存在但不完整时同走「no committed request header and agentDefaultModel selection unavailable」，消息误导；建议区分「header incomplete」。
2. **apply 时诊断 warn**（index.ts:40）：无 agentDefaultModel 的 profile（如 headless）每次启动一条；一次性、方向准确，可接受。
3. **类型自声明**（wake.ts:54）：可 `import type { AgentSetup }` 后 `type WakeResumeSetup = AgentSetup` 让 tsc 捕获上游漂移（与反耦合取舍，二选一即可）。
4. **effort 透传注释**（wake.ts:194）：`adapterDefaults.reasoningEffort=true` 场景与 web 行为一致，建议一行注释说明。

## 9. 语义观察（已核实为设计意图，不修改）

- 冷唤醒现在**所有环境**（含 agentDefaultModel 可用的 dev/web）都优先用会话自身最后模型（header），不再用 agent 默认模型——与 web 主机 resume 语义一致（`selectionFor` logged 优先），连续性正确；jk 会话 gemini-3-flash 而非默认 cpa/medium 即此语义。commit message 已声明 header 优先，确认是意图。
- 首个 resume 请求不会恢复持久化 header 的 temperature/stop/maxTokens（loop 既有行为：seed 只取 AgentOptions；本 ref 只覆盖 provider/model/effort）——非本 commit 引入，与 web 路径相同，此处仅记录。
- 修复为**冷路径专用**，live 唤醒不受影响（复用 live agent 及其既有的 web 侧 selection）。

## 10. 结论

**准入。** 根因修复与 dsh-host-apiproxy `selectionFor` 机制同构、契约与时序逐字验证、干净 worktree 独立复验 110/110 全绿、真实 E2E 在生产条件下闭环并捕获会话自身模型。上线前注意：主工作树存在未提交的 session-tab WIP（`npm test` 当前因此报 tsc 错），建议 WIP 落地或隔离后再执行 profile 同步与重启验收；`/tmp/wake-repro/` 保留为回归脚本。后续项（不阻塞）：P2 ① 补 setup 执行级单测、P2 ② setup 缺 agent 分支加诊断；P3 四项按需处理。