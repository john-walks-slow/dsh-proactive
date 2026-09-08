# dsh-proactive 模块 AGENTS.md

## 职责

注册到每个 root agent 的 `proactive_*` 工具 + host 级闹钟调度：到点 resume 冷会话（或复用 live agent）投递 framing 唤醒报文，回合结束后由 observer 依据会话日志判定决策与预算增量。

## 地图

- `src/domain.ts` — 领域模型、校验、DST 正确的时区/本地时间解析（移植 dsh-schedule）、闭式错误码
- `src/config.ts` — 默认配置 + config.json/环境变量覆盖 + 安静时段判定
- `src/store.ts` — alarms.json（原子写）/runs.jsonl/state.json 持久化；corrupt 降级
- `src/scheduler.ts` — 串行 drive 循环：门控（安静/budget/hourly/boot 策略）、重试、单定时器重臂
- `src/wake.ts` — WakeDriver：live/cold 双路径、冷 resume 装 `installModelSelection`（`createWakeSelectionRef`：会话 request header → agentDefaultModel → warn）、runMaintenance+followup、whenIdle、dispose、inflight 守卫
- `src/framing.ts` — 唤醒报文（wake_reason/user_presence/budget/quiet_hours/alarm_prompt_json + 2 条回复规则）；notice-form 用户消息
- `src/observer.ts` — 从会话日志切片判定 no_reply/reply/failed 与预算增量；leaked 标记
- `src/tools.ts` — proactive_set/list/cancel/no_reply（no_reply 需 inflight 且【只调它不写文本】）
- `src/index.ts` — 装配；agent/created 时对 roots 注册工具（resume 出的会话同样覆盖）
- `src/panel/` — 面板 host 半边：contract（面板↔client 线协议，与工具同一 create 方言）、service（快照/闭动作）、routes（/api/dsh-proactive/* + SSE）
- `src/client/` — 面板浏览器半边：sections（两面板共用组件与统一 create 表单）、panel（设置页）/session-panel（会话 tab）、locales（全部文案 zh/en，client/index.ts 的 LocaleNamespaceMap union 必须同步）、host-api（fetch+SSE）

## 核心设计

- 状态在 host 侧（store 单例），工具通过闭包访问；与 dsh-schedule 的会话内提醒互补
- 静默 = framing 规则引导 + `exec.concludeTurn()` 机械结束（agent-loop 不再请求下一次补全）+ 不产出文本；GUI 对无文本 assistant 消息不渲染。文本先行的泄漏由 observer 标记并按可见文本计费，不阻断
- 预算：唤醒回合写了可见聊天文本 1 单位/UTC 日，上限 `maxDeliveriesPerDay`；no_reply 免费；预算耗尽跳过主动唤醒、用户委托 alarm 仍触发
- 安静时段（IANA 时区、跨午夜）：非 alarm 唤醒每 5 分钟延迟重评估；重复闹钟错过不补跑，推进到下一个锚点
- 唤醒回合判定依据**已提交的会话日志**（startIndex 之后的事件切片），不信任运行期假设
- 面板表单（两面板同一方言）：目标会话=会话 ID 文本输入（默认当前会话，设置页经 GlobalStandardProps `useSessions` 读 GUI 选中会话）；owner 非表单字段——会话页钉死本会话（host scope 规则），设置页按目标派生（resume/fork=目标会话，new=当前会话→host-panel 伪会话）；prompt 预填 `config.defaultPrompt`（常量在 domain.ts，快照缺该字段的旧 host 由 client 回退同值，配置编辑项也仅在字段存在时渲染/提交）

## Pitfalls

- 字符串构造 RegExp 时 `\d` 会在一层转义后被吞掉（"d" === "d"）——一律用正则字面量
- 写 TS 源码/文档时，模板字面量内的反引号与 `$` 必须先占位后替换，否则程序级语法错误
- 用 read 工具回写文件时注意 totalLines：read(limit) 只返回前 N 行，直接按返回内容 write 会截断文件（曾把 package.json 截成非法 JSON 导致 tsc 按 CJS 报 TS1295）。改 JSON/长文件要么读全，要么用 edit 做定点替换
- 本地改完要跑 `tsc -p tsconfig.json`（src+test 一起查）再 `node --test 'dist/test/*.test.js'`；node --test dist/test/ 目录形式在 Node 22 会 MODULE_NOT_FOUND
- tools 的 output.schema 每个属性都要带 `required: true`（dsh-tools 的 per-property 约定，不是 JSON Schema 顶层 required 数组）
- notice 来源必须带 `summary`（≤120 字符），否则 MessageSource 类型不满足
- 冷 resume 的 provider/model 不能只靠 AgentOptions：新 loop 实例首次 buildRequest 只读 AgentOptions（不看持久化 request header），agentDefaultModel 取空时必抛 `has no provider/model`。必须像 web 主机（dsh-host-apiproxy selectionFor）一样经 resume `setup` 装 `installModelSelection`，水位：会话 request header → agentDefaultModel → warn（2026-09-06 根因，见 docs/issues/260906-cold-wake-provider-model/）