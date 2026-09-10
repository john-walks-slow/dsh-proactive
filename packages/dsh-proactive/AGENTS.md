# dsh-proactive 模块 AGENTS.md

## 职责

注册到每个 root agent 的 `proactive_*` 工具 + host 级闹钟调度：到点 resume 冷会话（或复用 live agent）投递 framing 唤醒报文，回合结束后由 observer 依据会话日志判定决策与预算增量。

## 地图

- `src/domain.ts` — 领域模型、校验、DST 正确的时区/本地时间解析（移植 dsh-schedule）、闭式错误码
- `src/config.ts` — 默认配置 + config.json/环境变量覆盖 + 安静时段判定
- `src/store.ts` — alarms.json（原子写）/runs.jsonl/state.json 持久化；corrupt 降级
- `src/scheduler.ts` — 串行 drive 循环：门控（安静/budget/hourly/boot 策略）、重试、单定时器重臂
- `src/wake.ts` — WakeDriver：live/cold 双路径、冷 resume 装 `installModelSelection`（`createWakeSelectionRef`：会话 request header → agentDefaultModel → warn）、runMaintenance+followup、whenIdle、dispose、inflight 守卫；静默/无输出回合结束后触发 compactWake
- `src/framing.ts` — 唤醒报文 v3（极简：身份头/now/非用户标记/alarm prompt 原文/一条 no_reply 规则，~0.4KB 开销）；notice-form 用户消息；导出 FRAMING_MARKER
- `src/compact.ts` — 静默唤醒的 surface 压缩：planWakeCompaction（owned run 划分，region=framing 至其后第一个 turn/end）+ applyWakeCompaction（按 alarm.compaction 三态渲染 tombstone：minimal 含 `no_reply: <reason>`，aggressive 只 id+time；+ 空 content assistant/message 擦除器）；off 在 wake.ts 驱动层短路不进入；非本插件注入的 surface 节点（snapshot/mnemon/用户消息）打断 run 并保留
- `src/observer.ts` — 从会话日志切片判定 no_reply/reply/failed 与预算增量；leaked 标记；extractNoReplyReason 从 tool/call arguments(JSON) 提取 reason → WakeAnalysis.noReplyReason（无条件进 run history）；isFramingNotice 按 plugin source + FRAMING_MARKER 双重锚定（防 tombstone 误锚）
- `src/tools.ts` — proactive_set/list/cancel/no_reply（no_reply 需 inflight 且【只调它不写文本】）
- `src/workspace.ts` — 工作区目标类型：resolveWorkspaceArg（id/path/会话 cwd 三臂归一为 id）、listMetadataOf/updatedAtOf（侧边栏折叠/排序键）、pickWorkspaceTarget（可见会话 → 空白 New Session 槽 → create）、resolveWorkspaceWakeTarget（live 折叠 + cold 投影缓存行，archived/subagent 剔除，missing-dir 闭式 failed）、WorkspaceWakePort（attach 先于投递）、liveEventsOf/live 折叠的跨版本日志读
- `src/index.ts` — 装配；agent/created 时对 roots 注册工具（resume 出的会话同样覆盖）
- `src/panel/` — 面板 host 半边：contract（面板↔client 线协议，与工具同一 create 方言）、service（快照/闭动作）、routes（/api/dsh-proactive/* + SSE）
- `src/client/` — 面板浏览器半边：sections（两面板共用组件与统一 create 表单）、panel（设置页）/session-panel（会话 tab）、locales（全部文案 zh/en，client/index.ts 的 LocaleNamespaceMap union 必须同步）、host-api（fetch+SSE）、workspaces-source（`ctx.get("workspaces").list` 的 subscribe/getSnapshot store + bindSource this 安全包装 + EMPTY_SOURCE 降级）

## 核心设计

- 状态在 host 侧（store 单例），工具通过闭包访问；与 dsh-schedule 的会话内提醒互补
- 静默 = framing 规则引导 + `exec.concludeTurn()` 机械结束（agent-loop 不再请求下一次补全）+ 不产出文本；GUI 对无文本 assistant 消息不渲染。文本先行的泄漏由 observer 标记并按可见文本计费，不阻断
- 预算：唤醒回合写了可见聊天文本 1 单位/UTC 日，上限 `maxDeliveriesPerDay`；no_reply 免费；预算耗尽跳过主动唤醒、用户委托 alarm 仍触发
- 安静时段（IANA 时区、跨午夜）：非 alarm 唤醒每 5 分钟延迟重评估；重复闹钟错过不补跑，推进到下一个锚点
- 唤醒回合判定依据**已提交的会话日志**（startIndex 之后的事件切片），不信任运行期假设
- 静默唤醒压缩（per-alarm `compaction` 三态，默认 `minimal`）：observer 判 no_reply/failed 后，`off` 在驱动层短路不压缩；`minimal`/`aggressive` 用平台 surfaceOp replace 把唤醒交换折叠——minimal tombstone 含 `no_reply: <reason>`（~200-400B），aggressive 只 id+time（~70B），两者都用空 content assistant/message 擦除器（deriveEventMessage→null）；reply 回合绝不压缩；非本插件注入的 surface 节点（runtime-context snapshot 等）打断 run 并保留——shadow snapshot 会使 RuntimeContextProjection.retained 置空、下回合强制重发全量快照；GUI 人类 transcript 用 append-origin 事件，不受替换影响。no_reply reason 无条件提取进 run history（runs.jsonl/面板 RunView），与上下文压缩正交
- 面板表单（两面板同一方言）：目标会话=会话 ID 文本输入（默认当前会话，设置页经 GlobalStandardProps `useSessions` 读 GUI 选中会话）；输入框下方实时显示该 ID 的会话标题（`knownSessions: ReadonlyMap<id,title>` 来自 state 快照的 session.list，精确命中即显示）；不在列表的 ID 为**软提示且 500ms settle 去抖**（负面反馈不能逐键闪现，正面标题即时）；owner 非表单字段——会话页钉死本会话（host scope 规则），设置页按目标派生（resume/fork=目标会话，new=当前会话→host-panel 伪会话）；prompt 预填 `config.defaultPrompt`（常量在 domain.ts，快照缺该字段的旧 host 由 client 回退同值，配置编辑项也仅在字段存在时渲染/提交）
- `use-locale.ts`：面板文案 hook 的 active locale **每次 snapshot 读取时从 live 服务解析**，不在 bind 时缓存——页面可在持久化偏好（zh）到达前先以回退（en）启动，bind 时缓存会把这个窗口内挂载的面板困在错误语言直到下次切换（曾导致刷新后面板 en、tab 标签 zh 的分裂）
- workspace 目标（260910）：目的地排序键=侧边栏 updatedAt（max(createdAt, lastPromptAt)），数据源=live 折叠（listMetadataOf）+ cold 投影缓存行（`cachedSnapshot(header, 0)`；seeded/fork 头无缓存行——host projectionsFor 语义）；可见会话 → 空白 New Session 槽 → create（cwd=工作区路径，**attach 先于投递**）。archived/subagent 永不入选；缺目录闭式 failed；cold 列表失败且无 live 候选 → 闭式 failed（防重复建会话）；面板工作区下拉只来自 client `workspaces` service（dsh **没有** workspace/list RPC）。已知镜像差异：host summarizeCold 对"缓存行说 blank=true"的小冷日志会 probeSmallCold 纠正，插件直接信缓存行（罕见、后果仅目的地次优）。SessionEvent 的 `time` 在**事件顶层**（`{type, seq, time, data}`），data 只有 `{content, id, role, source}`——读 `data.time` 恒 undefined（260910 review B1）；user/message 的 source 也在 `data.source`（zone.ts 曾读顶层 `event.source` 从未命中——review N4，同日修复）
- dsh Session API 双版本兼容（0.1.1-rc.2 ↔ 0.1.2-rc.1）：读会话日志一律走 `sessionLogOf`（wake.ts）/`liveEventsOf`（workspace.ts，live store）——`.events` 数组（≤0.1.1）/`snapshotEvents()`（≥0.1.2）/[] 兜底；startIndex 用 `session.seq`；agents.create 的 setup 内**不能**读 agent.session 日志（未发布会话无日志，resolveSessionPreset 需 `{header, events}` 适配器）。devDeps 无法升级 0.1.2-rc.1（dsh-invariants prerelease 不满足自身 range、dsh-client-runtime 无 0.1.2），兼容层须保留到 0.1.2 正式版。`resolveSessionPreset` 在 0.1.2-rc.1 已被**移除**（具名 import 会在 ESM link 期炸掉整棵 plugin tree）——wake.ts 用 namespace import + `resolveSessionPresetOf` 运行期守卫 + 本地等价折叠兜底；升级 devDeps 时须保持该守卫

## Pitfalls

- 字符串构造 RegExp 时 `\d` 会在一层转义后被吞掉（"d" === "d"）——一律用正则字面量
- 写 TS 源码/文档时，模板字面量内的反引号与 `$` 必须先占位后替换，否则程序级语法错误
- 用 read 工具回写文件时注意 totalLines：read(limit) 只返回前 N 行，直接按返回内容 write 会截断文件（曾把 package.json 截成非法 JSON 导致 tsc 按 CJS 报 TS1295）。改 JSON/长文件要么读全，要么用 edit 做定点替换
- 本地改完要跑 `tsc -p tsconfig.json`（src+test 一起查）再 `node --test 'dist/test/*.test.js'`；node --test dist/test/ 目录形式在 Node 22 会 MODULE_NOT_FOUND
- tools 的 output.schema 每个属性都要带 `required: true`（dsh-tools 的 per-property 约定，不是 JSON Schema 顶层 required 数组）
- notice 来源必须带 `summary`（≤120 字符），否则 MessageSource 类型不满足
- 冷 resume 的 provider/model 不能只靠 AgentOptions：新 loop 实例首次 buildRequest 只读 AgentOptions（不看持久化 request header），agentDefaultModel 取空时必抛 `has no provider/model`。必须像 web 主机（dsh-host-apiproxy selectionFor）一样经 resume `setup` 装 `installModelSelection`，水位：会话 request header → agentDefaultModel → warn（2026-09-06 根因，见 docs/issues/260906-cold-wake-provider-model/）
- agent-loop 事件顺序：turn/start 先于 framing user/message（turn 开始后才 drain inbox），runtime-context snapshot 紧跟 framing 之后。任何按事件切片判定"唤醒回合"的逻辑必须以 framing 为锚、取其后第一个 turn/end 为界——在 framing 后找 turn/start 会选中竞态用户回合（曾致误扣预算 + 误压缩可见回复，见 docs/features/260908-wake-context-minimization/ P1）
- client 注册槽位（dsh 0.1.2-rc.1 起）：`ctx.slots.register` 前槽位必须已被父条目 children 表**声明**，设置页面板曾因直接 register 竞态整体消失——一律走 `ctx.slots.inject(<slot>, () => register(...))` 等声明
- client 调 host RPC：typert 网关端点为两段式 `POST /api/<ns>/<method>`（dotted `session.list` 404）；body `{type:"client-request", rpcId, method, payload:{args}}`，args 的 key 取自方法描述符的 `wire` 字段（session/list 是 `_request`）；响应须检查 `result.ok === true` 再取 `result.value`
- `useSyncExternalStore` 不能直接传 `store.subscribe`/`store.getSnapshot` 方法引用——dsh workspaces 模型内部用 `this`，裸引用丢 this 即崩；用 `bindSource`（workspaces-source.ts）包装