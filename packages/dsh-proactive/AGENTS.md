# dsh-proactive 模块 AGENTS.md

## 职责

注册到每个 root agent 的 `proactive_*` 工具 + host 级闹钟调度：到点 resume 冷会话（或复用 live agent）投递 framing 唤醒报文，回合结束后由 observer 依据会话日志判定决策与预算增量。

## 地图

- `src/domain.ts` — 领域模型、校验、DST 正确的时区/本地时间解析（移植 dsh-schedule）、闭式错误码
- `src/config.ts` — 默认配置 + config.json/环境变量覆盖 + 安静时段判定（`scheduleFiles`/`schedulePollSeconds` 声明式文件配置归此，parseScheduleFiles 容错钳制）
- `src/declared.ts` — 声明式闹钟文件（260918）：config.scheduleFiles glob 展开（自实现 `*`/`**`/`?`，`**/` 匹配零层）→ schedule JSON 解析（文件级默认 + 条目覆盖 + 嵌套 target 拍平）→ 条目走 validateCreateArgs/buildAlarm **同一工厂**（无第二方言）→ 按 `decl_<sha256(file\0entry)>` 稳定 id + spec hash 幂等 diff 同步。declared 闹钟 owner=`declared-schedule`、带 `declared{file,entry,hash}`；tools 的 update/cancel 对其拒绝（文件=唯一真源）。失败语义：文件读坏/JSON 坏 → **保留**现有闹钟（transient 不炸计划）；条目存在但准备失败（target 解析失败/closed validation/过去 at）→ 保留既有同 id 闹钟（keptIds）；条目删除/文件删除/功能关 → 移除对应闹钟；in-flight 永不动。target 缺省 = 文件所在 workspace（dirname 经 resolveWorkspaceArg 反查）。**scheduleFiles 不进 HotConfig**——settings namespace schema 未声明该字段，watch 回写会剥掉它再 clobber 回 undefined；热更只能走 proactive_update_settings 的 `schedule_files` 直改 `config.scheduleFiles`（轮询每 tick 读 live config）
- `src/store.ts` — alarms.json（原子写）/runs.jsonl/state.json 持久化；corrupt 降级；alarmIsValid 校验 `declared` 来源形态
- `src/scheduler.ts` — 串行 drive 循环：门控（安静/budget/hourly/boot 策略）、重试、单定时器重臂；quiet 快进（skipPastQuiet/nextAwakeOccurrence，respect=true 的 occurrence 窗内**丢弃不补发**）+ defer 分支（min_idle，绝对时刻重臂不记 run）
- `src/wake.ts` — WakeDriver：live/cold 双路径、冷 resume 装 `installModelSelection`（`createWakeSelectionRef`：会话 request header → agentDefaultModel → warn）、runMaintenance+followup、whenIdle、dispose、inflight 守卫；静默/无输出回合结束后触发 compactWake；idleGate（`min_idle_seconds`：resume 目的地 claim 前查 live 会话日志尾 lastEventEpoch，未冷够 → `{outcome:"defer", deferUntilMs}`，冷会话天然通过，fork/new 不检查）
- `src/framing.ts` — 唤醒报文 v3（极简：身份头/now/非用户标记/alarm prompt 原文/一条静默双工具规则，~0.5KB 开销）；notice-form 用户消息；导出 FRAMING_MARKER
- `src/compact.ts` — 静默唤醒的 surface 压缩：planWakeCompaction（owned run 划分，region=framing 至其后第一个 turn/end）+ applyWakeCompaction（按 alarm.compaction 三态渲染 tombstone：minimal 含 `silence: <reason>`，aggressive 只 id+time；+ 空 content assistant/message 擦除器）；off 在 wake.ts 驱动层短路不进入；非本插件注入的 surface 节点（snapshot/mnemon/用户消息）打断 run 并保留
- `src/observer.ts` — 从会话日志切片判定 no_reply/reply/failed 与预算增量；`compactable` **显式 opt-in**（仅 proactive_reclaim 工具调用标记可回收）；extractSilenceReason 从 tool/call arguments(JSON) 提取 reason → WakeAnalysis.noReplyReason（无条件进 run history）；isFramingNotice 按 plugin source + FRAMING_MARKER 双重锚定（防 tombstone 误锚）；**不探测任何其他插件的工具名**（零耦合）
- `src/tools.ts` — proactive_set/list/cancel/update/proactive_reclaim（list 的 all=true、update、cancel 均按精确 id **跨会话**——工具=模型代用户行事，与 GUI 设置页同权；update 与 set 共享 ALARM_SPEC_PARAMETERS 同一方言、全量替换、保留 id/owner/历史，时区链跟随 owner 会话；proactive_reclaim 永远注册、需 inflight 守卫且【只作收尾不写文本】，reason 记 run history + 墓碑）
- `src/workspace.ts` — 工作区目标类型：resolveWorkspaceArg（id/path/会话 cwd 三臂归一为 id）、listMetadataOf/updatedAtOf（侧边栏折叠/排序键）、pickWorkspaceTarget（可见会话 → 空白 New Session 槽 → **none**）、`createdSessionEligible`（plugin 自建会话豁免判定）、resolveWorkspaceWakeTarget / resolvePresetWakeTarget（live 折叠 + cold 投影缓存行，archived/subagent/**plugin-created 记账**剔除，无候选 → none）、WorkspaceWakePort（attach 先于投递；cwdOf 保留 missing-dir 守卫）、liveEventsOf/live 折叠的跨版本日志读
- `src/index.ts` — 装配；agent/created 时对 roots 注册工具（resume 出的会话同样覆盖）
- `src/panel/` — 面板 host 半边：contract（面板↔client 线协议，与工具同一 create 方言）、service（快照/闭动作）、routes（/api/dsh-proactive/* + SSE）
- `src/client/` — 面板浏览器半边：sections（两面板共用组件与统一 create 表单）、panel（设置页）/session-panel（会话 tab）、locales（全部文案 zh/en，client/index.ts 的 LocaleNamespaceMap union 必须同步）、host-api（fetch+SSE）、workspaces-source（`ctx.get("workspaces").list` 的 subscribe/getSnapshot store + bindSource this 安全包装 + EMPTY_SOURCE 降级）

## 核心设计

- 状态在 host 侧（store 单例），工具通过闭包访问；与 dsh-schedule 的会话内提醒互补
- 静默 = framing 规则引导 + `exec.concludeTurn()` 机械结束（agent-loop 不再请求下一次补全）+ 不产出文本；GUI 对无文本 assistant 消息不渲染。文本先行再静默=普通 reply 计费（leak 概念已删）
- 预算：唤醒回合写了可见聊天文本 1 单位/UTC 日，上限 `maxDeliveriesPerDay`；静默免费；预算耗尽跳过主动唤醒、用户委托 alarm 仍触发
- 安静时段（IANA 时区、跨午夜，260918 改版）：`respect_quiet_hours=true` 的 occurrence 窗内**直接跳过不补发**——once 完成（记一条 skipped），every/cron 快进到窗外第一个锚点（每窗至多一条 skipped，无逐分钟空转）；hourly cap 命中仍是 deflect 等 5 分钟（限流 ≠ 不许打扰）；`false` 用户委托不受限
- min_idle 静默门（260918）：`min_idle_seconds`（0..86400，默认 0）仅作用于 resume 目的地，claim 前查 live 会话最后事件时间；未冷够 → 新 `defer` outcome（重臂 max(lastEvent+N, now+60s)，事件驱动不轮询、不记 run、不烧重试/预算/cap），不设放弃上限（耐心是设参人的选择）；活动=任意会话事件（含上次唤醒自身回合 → 自监控闹钟天然间隔 ≥N）；**declared sync 对 hash 未变闹钟完全 no-op（declared.ts:448）是 defer 状态不被轮询打回的前提，勿破坏**
- 循环模式（260916 更新）：推进改用漂移语义（`nextDriftingOccurrence`），下次唤醒时刻基于本次真实唤醒时刻（`wakeEpoch`，记录于 `lastRunAt`）加上间隔与随机抖动，允许时间漂移，确保每次唤醒之间至少保持设定的周期间隔；极端超时自动安全重锚，杜绝惊群
- 唤醒回合判定依据**已提交的会话日志**（startIndex 之后的事件切片），不信任运行期假设
- 静默唤醒压缩（260917 定案：**显式 opt-in**）：只有回合内调用了 `proactive_reclaim` 才压缩（`WakeAnalysis.compactable`）；隐式静默（无工具无文本）、其他工具的静默（如 dsh-im `no_reply`）、reply、failed 一律**保留完整交换**——模型没断言"可回收"就什么都不擦。`silentWakeCompaction`（默认 true）是总闸，per-alarm `compaction` 三态（默认 `minimal`）细化：`off` 短路；`minimal` tombstone 含 `silence: <reason>`（~200-400B，reason 来自 proactive_reclaim 参数）；`aggressive` 只 id+time（~70B）；两者都用空 content assistant/message 擦除器（deriveEventMessage→null）。非本插件注入的 surface 节点（runtime-context snapshot 等）打断 run 并保留——shadow snapshot 会使 RuntimeContextProjection.retained 置空、下回合强制重发全量快照；GUI 人类 transcript 用 append-origin 事件，不受替换影响。proactive_reclaim reason 无条件提取进 run history（runs.jsonl/面板 RunView），与上下文压缩正交
- 面板表单（两面板同一方言）：目标会话=会话 ID 文本输入（默认当前会话，设置页经 GlobalStandardProps `useSessions` 读 GUI 选中会话）；输入框下方实时显示该 ID 的会话标题（`knownSessions: ReadonlyMap<id,title>` 来自 state 快照的 session.list，精确命中即显示）；不在列表的 ID 为**软提示且 500ms settle 去抖**（负面反馈不能逐键闪现，正面标题即时）；owner 非表单字段——会话页钉死本会话（host scope 规则），设置页按目标派生（resume/fork=目标会话，new=当前会话→host-panel 伪会话）；prompt 预填 `config.defaultPrompt`（常量在 domain.ts，快照缺该字段的旧 host 由 client 回退同值，配置编辑项也仅在字段存在时渲染/提交）
- `use-locale.ts`：面板文案 hook 的 active locale **每次 snapshot 读取时从 live 服务解析**，不在 bind 时缓存——页面可在持久化偏好（zh）到达前先以回退（en）启动，bind 时缓存会把这个窗口内挂载的面板困在错误语言直到下次切换（曾导致刷新后面板 en、tab 标签 zh 的分裂）
- 工具作用域（260910）：模型工具=代用户行事，按精确 id **跨会话** actuate（list all=true / update / cancel），与 GUI 设置页同权；GUI 会话页 tab 限 owner（上下文可见性）。update 是**全量替换**方言（与 set 共享 ALARM_SPEC_PARAMETERS；省略字段回退方言默认而非旧值），保留 id/owner/createdAt/run 历史，paused 编辑后回 scheduled，in-flight/终态闭式 invalid_action；时区默认链跟随 **owner** 会话的 events（ToolServices.sessionEvents），workspace 目的无显式参数时沿用已解析 id（不重查存在性——fire 时自有闭式兜底）。AlarmView 带 timeZone 供 list→update 方言往返无损
- workspace 目标（260916 更新）：目的地排序键=侧边栏 updatedAt（max(createdAt, lastPromptAt)），数据源=live 折叠（listMetadataOf）+ cold 投影缓存行（`cachedSnapshot(header, 0)`；seeded/fork 头无缓存行——host projectionsFor 语义）；可见会话 → 空白 New Session 槽 → **none**（无候选 → fire skip，**不新建**；新建是 target_mode new 的职责）。archived/subagent/**plugin-created** 永不入选：plugin 自建会话（new 产物、fork 子）记在 `state.json.createdSessions`（kind new/fork，cap 1024，原子写），resolver 用 `createdSessionEligible(kind, lastPromptAt)` 判豁免——new 产物被用户采纳（lastPromptAt!=null）才放行，fork 永不豁免（继承历史不可判别）；cold 缓存行缺=unknown=保守剔除。收敛悖论："剔除产物 + 保留 create arm" 会每次 fire 新建登顶→自我捕获循环，故无候选改 skip 闭合（旧 create arm 与 missing-dir 检查删除；missing-dir 守卫保留在 cwdOf，服务 new+workspace）。cold 列表失败且无 live 候选 → 闭式 error（走重试，不 skip 防"看不见的会话"被误判无）；面板工作区下拉只来自 client `workspaces` service（dsh **没有** workspace/list RPC）。已知镜像差异：host summarizeCold 对"缓存行说 blank=true"的小冷日志会 probeSmallCold 纠正，插件直接信缓存行（罕见、后果仅目的地次优）。SessionEvent 的 `time` 在**事件顶层**（`{type, seq, time, data}`），data 只有 `{content, id, role, source}`——读 `data.time` 恒 undefined（260910 review B1）；user/message 的 source 也在 `data.source`（zone.ts 曾读顶层 `event.source` 从未命中——review N4，同日修复）
- skip outcome（260916）：workspace/preset resolver 返回 none → WakeDriver 返回 `{outcome:"skipped", skipReason}` → scheduler 记 run（decision="skipped"、note=skipReason、budgetDelta 0）、advancePast（once→completed、every/cron→下一锚点），**不重试、不烧 hourly cap、不计预算**。`skipReason` 字段名 driver 与 scheduler 必须一致——index.ts `runWake: (alarm) => driver.fire(alarm)` 直接透传无适配，字段名漂移会让 note 静默落兜底串「no eligible target session」（260916 review B1，已有 driver→scheduler 接线测试防回归）
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