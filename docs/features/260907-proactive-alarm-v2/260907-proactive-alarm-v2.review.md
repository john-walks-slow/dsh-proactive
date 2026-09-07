# 260907-proactive-alarm-v2 评审

> 日期：2026-09-07 · 评审对象：v2 重构工作区 diff（相对 HEAD c6759ff，未提交；docs/issues/260830-container-mount-canonical/ 三处他人并发改动已忽略）· 评审方式：源码走读 + 独立复验（tsc / 149 单测 / build / 针对关键语义的 node 实证脚本）
> 基线：用户需求（去掉 heartbeat 分类 → respect_quiet_hours 开关；once/every/cron 三类型 + 统一 jitter_seconds；resume/fork/new 三目标；时区缺省链；cron 自研零依赖）见 plan.md §1/§2/§13。

## 0. 结论摘要

| 级别 | 数量 | 摘要 |
|---|---|---|
| P0 阻断交付 | 0 | — |
| P1 必修 | 0 | — |
| P2 建议修 | 2 | ① **面板 once 本地绝对时间硬编码 UTC，绕过 effectiveTimeZone 缺省链**（`createArgsFromForm` 的 at 对象永远带 `time_zone:"UTC"`，表单无时区输入；工具路径正常走 clientTimeZone → 宿主时区，面板路径却按 UTC 解释本地日期时间——两条表面同一 dial 的两套语义，直接违背"工具与面板共用 src/zone.ts 同一规则"的承诺）；② **README.md 整篇停留在 v1 词汇**（wake_reason / heartbeatPrompt / jitter 0..1 / one-shot-repeat / update_settings 心跳 prompt），与 v2 契约矛盾，照 README 调用 proactive_set 会被 invalid_trigger（未知键）拒绝 |
| P3 可后置 | 5 | ① time_zone 校验按类型分裂（cron 校验、every/after/at 不校验，`Not/AZone` 可落库）；② 面板 toggle 恢复 every 以 lastRunAt 为新锚 → 带 jitter 的闹钟 pause/resume 累积网格漂移；③ cron jitter 无频率护栏（`*/5` + jitter 86400 相邻触发可几乎紧贴）；④ maxWakeupsPerHour 无行为级测试 + maxConcurrentPerSession 设置始终未接线（v1 既有，非回归）；⑤ 语义/副本小项若干（cron 推进"严格 after now"与计划文案"从上一计划点"不一致但实现更安全、at 偏移不反映到 alarm.timeZone、表格 jitter 徽标 "±N" 与 +U(0,j) 语义不符、fork/new 的 framing "this wake resumed it" 措辞） |
| 亮点 | — | cron 引擎零依赖 + 两个真 bug 修复（parseRange 单数字、dayMatches Vixie 通配）；jitter 烘焙进 nextDueAt 调度器零等待；advance 严格 after now 错拍跳过不补跑；alarm-factory 单一入口使工具/面板共用同一校验方言（panel 本地 at 例外，见 P2-①）；v1→v2 读时迁移 + corrupt 降级；输出 schema 每属性 required 约定与可选字段的正确处理（有回归测试锁定）；fork seed 与宿主 session.fork 语义对齐；时区链两端接线 + 新增 6 个时区测试 |

**总体判断：v2 核心语义（三类型 + 统一 jitter + respect_quiet_hours + fork/new + 时区链 + 迁移）实现正确、测试到位，149 全绿、tsc 零错、build 成功，未发现 P0/P1。两条 P2 建议合入前处理：面板本地时区语义（用户可见、且与承诺的共用规则相悖）与 README 契约文档。结论：准入（附 2 条 P2 跟进）。**

---

## 1. 复验记录（本次会话实测）

| 项目 | 结果 |
|---|---|
| `npm run check`（tsc -p tsconfig.json --noEmit，含 src/client/*.tsx） | ✅ 退出码 0 |
| `npm test`（tsc → dist 后 node --test 'dist/test/*.test.js'） | ✅ **149 passed / 0 failed** |
| `npm run build`（tsc→lib + esbuild client bundle） | ✅ 退出码 0（lib/client.bundle.js 73.0kb） |
| 实证：`parseCron("5/15 ...")` → 分钟 {5,20,35,50}（Vixie 单数字+步进语义） | ✅ 符合修复声明 |
| 实证：`nextCronOccurrence`（UTC/上海/纽约 DST 跳变、Feb 29、Feb 30 窗口耗尽、7→周日、13 OR Friday） | ✅ 与测试断言一致 |
| 实证：`validateCreateArgs` 频率护栏（`* * * * *` → frequency_too_high；`*/5 * * * *` → 通过） | ✅ |
| 实证：`every_seconds` + `time_zone:"Not/AZone"` → **通过并原样落库**（见 P3-①）；cron 同参数 → invalid_time_zone | ✅（问题复现） |
| 实证：`createArgsFromForm({kind:"once", atDate, atTime})` → `at.time_zone` 恒为 `"UTC"`（见 P2-①） | ✅（问题复现） |
| 实证：jitter 烘焙：at=2026-09-08T21:00:00+08:00 + jitter 600（random=0.5）→ nextDueAt=13:05:00.000Z（=at+300s） | ✅ 语义正确 |

## 2. 需求逐项核对（对 plan §3–§10）

### 2.1 领域模型 v2（domain.ts）— 通过

- `AlarmType`/`TargetMode`/`AlarmTarget`/`CronTrigger` 与 plan §3 逐字段一致；WakeReason/AlarmMode 移除；`toAlarmView` 保留 `sessionId`=owner、新增 target 字段（决策 D6 落地）。
- `resolveLocalInstant`/`localProjection`/`makeLocalFormatter` 保持 dsh-schedule 移植算法（重叠取较早 / 间隙拒绝 / 采样 ±5 天），不信任进程时区；`decodeInstant` 严格 canonical 往返。
- `isValidSessionId` 拒绝 "." / ".." / 超长 / 非 `[A-Za-z0-9._-]` —— 存储路径逃逸面闭环。

### 2.2 cron 引擎（cron.ts，新增）— 通过，亮点

- 五字段数字语法 + 闭式错误码；`dow 7→0` 归一化后以集合大小判"受限"（dom.size<31 / dow.size<8），正确实现 Vixie dom/dow OR 语义；本次修复的两个真 bug 均有测试锁定（`5/15` 步进、13 OR Friday）。
- 求值：逐分钟 cursor + 分层跳跃（月→日→时→分），`resolveWall` 对 DST 间隙返回 null 前进；8 年窗口 + 20 万迭代护栏；严格 after；one occurrence per wall minute（重叠不重复发射）。
- 频率下限在 **factory 层**（validateCreateArgs 对首两次 occurrence 求差 < 300s → frequency_too_high），`nextCronOccurrence` 本身不设限（纯求值器），分层正确。

### 2.3 统一 jitter（domain.ts / alarm-factory.ts / scheduler.ts）— 通过

- `jitterDelay = floor(U(0,1)·j·1000)`，烘焙进 `nextDueAt`（buildAlarm 一次、advance 每次推进时新掷），调度器零等待——计划 D1 精确落地。
- `validateJitterSeconds` 0..86400 整数闭式；every 路径额外 `jitter ≤ everySeconds` 约束；迁移 `round(j×every)` 与 plan §5.1 一致。
- every/cron 推进均以 **now（实际触发时刻）** 为准严格取下一次，错拍跳过不补跑（与计划"严格 >"语义自洽，见 P3-⑤ 的文案差异说明）。

### 2.4 respect_quiet_hours 门控（scheduler.ts）— 通过

- 门控顺序与 plan §4 完全一致：quiet(仅 respect=true) → hourly cap(全部) → budget(仅 respect=true) → fire；respect=true 的 budget 消耗走 `recordSkip + advancePast`，quiet 走 `deflect +5min` 重评估。
- 测试覆盖 respect×quiet×budget 矩阵（scheduler.test.ts "quiet hours defer…"、"daily budget gate…"），与 v1 alarm/heartbeat 差异等值复刻。

### 2.5 目标三模式（wake.ts）— 通过

- resume：live 复用 / cold `agents.resume` + setup 装 `installModelSelection`（createWakeSelectionRef：request header → agentDefaultModel → warn，260906 根因修复不回归，有专门测试）。
- fork：live/cold 双路读父日志（live session events / `sessionPersistence.inspect`），`completedTurnCut` 与宿主 session.fork 边界一致（最后一个 turn/end，含尾部非 turn 事件到下一个 turn/start），`meta{parentSession, seedLength, cwd}`；无已完成回合 / 父不可读 → failed 不抛。
- new：空 seed 建 `session-<uuid>`；fork/new 子会话为真实持久会话（决策 D5）。
- inflight 守卫按实际唤醒会话记账；run 记录 sessionId=实际会话（fork/new 为 child id），与需求"run 记录归 alarm owner"并存（panel 归属规则有测试：owner 表历史含 fork-child run）。

### 2.6 时区缺省链（zone.ts，新增）— 大体通过，一处旁路见 P2-①

- `effectiveTimeZone(显式 → clientTimeZoneOf(events) → SYSTEM_DEFAULT_TIME_ZONE → "UTC")`，clientTimeZoneOf 只认 `user/message` + `source.kind="user"` + 字符串 zone 并 canonicalize（无效 zone 跳过不抛）。
- 工具路径（tools.ts L168）与面板 create/edit 路径（service.ts L135/L158）均接线；zone.test.ts 4 个 + tools.test.ts 2 个 = 6 个时区测试与"143→149"声明吻合。
- **例外**：面板 once 的本地日期时间选择（at 对象）在 contract.ts `createArgsFromForm` 直接写死 `time_zone:"UTC"`，使该路径永远不经过缺省链（详见 P2-①）。

### 2.7 v1→v2 迁移（store.ts）— 通过

- STORE_VERSION=2；读时归一化：sessionId→owner+target.resume、one-shot→once、repeat→every（jitter 0..1→秒）、wakeReason alarm→false / 其余→true、deliveryHint 丢弃；不可用记录计入 corrupt 而非静默丢（有测试锁定）；下次 persist 落 v2。
- `alarmIsValid` v2 对主键/类型/trigger 形状做校验；`nextDueAt` 仅要求 string（容忍 legacy 非 canonical 格式——da到 Date.parse 容错），可接受。

### 2.8 工具 schema / framing / 面板 — 大体通过

- proactive_set 恰一 selector、target 规则（new 禁 target_session_id；resume/fork 缺省=创建者）、respect 缺省 false、prompt 一律必填；输出 ALARM_VIEW 可选字段**不**加 required 的注释与 dsh-tools per-property 约定自洽（"P0/P1 regression" 输出 schema 门测试锁定）。
- framing 删 heartbeat 词、wake_type/respect 行、alarm_prompt_json{id,type,respect,prompt}；no_reply 注明每次唤醒可用。
- 面板：三类型表单、target 三选（会话 tab 固定当前会话、fork 源固定）、respect 开关、jitter 输入、表格目标/免打扰徽标；设置页无"心跳默认词"。

## 3. 问题清单

### P2-① 面板 once 本地绝对时间硬编码 UTC，缺省链不生效（建议合入前修）

- 位置：`src/panel/contract.ts` `createArgsFromForm`（once 分支）`args["at"] = { date, time: form.atTime + ":00", time_zone: form.timeZone ?? "UTC" }`；配合 `src/client/sections.tsx` CreateForm **没有任何时区输入**（form.timeZone 恒 undefined）。
- 后果：工具路径（模型传 at 本地对象走 tools schema 的 required time_zone，或要求显式 zone）语义正确；面板用户在"指定日期时间"里选的 21:00 会被**按 UTC** 解释，而不是按会话 clientTimeZone / 宿主时区。实证：`createArgsFromForm` 输出 `at.time_zone === "UTC"`。面板 service 的 `effectiveTimeZone` 接线（service.ts L135/L158）只在 **top-level** `time_zone` 缺失时生效，而 at 对象内层已自带 "UTC"，故永不触发——与 plan §2.2 / §9"面板本地日期时间 + 时区缺省规则"的承诺直接相悖。
- 建议（择一）：① client 侧在 CreateForm 提交时用浏览器时区填充 at 对象（`Intl.DateTimeFormat().resolvedOptions().timeZone`，client 可用）；② host 侧在 createArgsFromForm 不带 time_zone 时对 at 对象注入 `effectiveTimeZone(undefined, sessionEvents(sessionId))`；并补面板测试锁定该路径。

### P2-② README.md 未随 v2 更新，公开契约文档与实现矛盾（建议本轮同步）

- 位置：`packages/dsh-proactive/README.md`（纳入 package files 的对外文档）。
- 证据：仍描述 `wake_reason: heartbeat|alarm` 双分类、`heartbeatPrompt` 默认提示词（§43）、`proactive_set` 的 `wake_reason`/`jitter 0..1`（§71）、`proactive_update_settings` 的 `heartbeat_prompt`（§75）、"user 委托 alarm 仍触发"的故事线（§105）——全部已在 v2 删除。按 README 传 `wake_reason`/`jitter` 会被 `validateCreateArgs` 未知键 → `invalid_trigger` 拒绝。
- 建议：本轮同步 README 到 v2 词汇（三类型/target 三模式/respect_quiet_hours/jitter_seconds/time_zone 缺省链/no_reply 每次可用）。

### P3-① time_zone 校验按类型分裂（cron 校验、其余不校验）

- 实证：`{every_seconds:3600, time_zone:"Not/AZone"}` → 校验通过、`alarm.timeZone = "Not/AZone"` 原样落库；同类 cron 请求 → `invalid_time_zone`。`after`/at-string（带偏移）同样不校验。
- 后果：坏 zone 落库（仅展示用途无害，但面板编辑 cron 时若类型切换会突然报错，语义不一致）。
- 建议：`validateCreateArgs` 对任何非空 `time_zone` 统一 `canonicalizeTimeZone`（对所有 kind），或至少在 buildAlarm 前统一 canonical，落库 canonical 值。

### P3-② 面板 toggle 恢复 every 以 lastRunAt 为新锚，jitter 网格漂移累积

- 位置：`src/panel/service.ts` toggle resume 分支 `anchor = current.lastRunAt ?? current.createdAt`。
- 后果：带 jitter 的 every 闹钟每次实际触发 = 网格拍 + U(0,j)；pause→resume 后网格被平移一个已发生的 jitter 延迟（lastRunAt 偏离原 anchor 网格），反复 pause/resume 漂移累积（每次 ≤ everySeconds）。原网格（trigger.anchor / createdAt）才是无漂移锚。
- 建议：恢复时沿用 `trigger.anchor`（或 createdAt）重新对齐；`lastRunAt ?? createdAt` 只影响"上次实际触发后未跑过的拍"的语义判断，网格锚不应被替换。

### P3-③ cron + jitter 无频率护栏

- `validateCreateArgs` 的 300s 下限只看**基础网格**两次 occurrence 之差，对 jitter 无感知：`*/5 * * * *` + `jitter_seconds:86400` 时，前一次实际触发的延迟可把下一次基础拍推近至 1 分钟甚至紧贴（advance 以 now 为准严格取后，单调性仍安全，但相邻触发可几乎同时）。D1 语义本身如此（计划明确"计划时刻后 U(0,j)"），但创建端不拦、描述未提示。
- 建议：cron 描述/面板提示给出建议（如 jitter 不宜接近网格间隔），或校验 `jitter ≤ 相邻 occurrence 间隔`（与 every 的 jitter≤every 约束对齐）。

### P3-④ 每小时上限无行为测试；maxConcurrentPerSession 始终未接线

- `hourlyCapHit`/recentFires/deflect-on-cap 全链路无测试（全测试文件仅 config 默认值断言）；这是 v1 既有路径，非本次回归，但 v2 门控顺序（quiet → cap → budget）值得一个矩阵测试锁定。
- `maxConcurrentPerSession` 出现在 config/settings/tool 输出/schema，但 scheduler/wake **从未读取**（wake 的并发守卫是 per-session 硬编码 1；grep 证实 HEAD 与 v2 均未接线）——设置可改可展示但零效果。建议明示文档或在本次顺手移除/接线。

### P3-⑤ 语义与副本小项（不阻塞）

- **cron 推进基准**：实现 `nextCronOccurrence(expr, tz, now)`（严格 after 实际触发时刻），计划 §5.1 文案是"从上一计划点"——实现更安全（一次最多补一个错拍、与 every 一致），建议在 summary 决策记录里落一句，避免后续按计划文案"修正"回去。
- **at 字符串偏移 ↔ alarm.timeZone**：`at:"…+08:00"` 时 alarm.timeZone 落的是 effective 链值（会话/宿主时区）而非 +08:00；仅展示/对齐用途且 once 无对齐依赖，无害，但值得注释。
- **表格 jitter 徽标**（sections.tsx L194）显示 "±Ns"——v2 语义是 **+U(0,N)** 纯延迟（v1 才是 ±比例），徽标文案会误导。
- **framing 对 fork/new** 的 `user_presence: cold` 文案 "session was cold; this wake resumed it"——子会话是新建而非 resume，副本级措辞。
- **proactive_list 不含 paused** 闹钟（过滤 scheduled|in-flight），面板可见、工具不可见/不可恢复——v1 语义延续，建议列表说明一句。

## 4. 亮点（值得保留的经验）

- **cron 引擎**：自研零依赖前提下复用 domain 的 Intl 投影机制（不信任进程时区），DST 间隙跳过/重叠取较早/单墙钟分钟只发射一次全部有测试；8 年窗口对 Feb 29 / Feb 30 有收敛护栏；两个修复的真 bug 都被最小用例锁定，属于"修复即测试"的样板。
- **jitter 烘焙**：随机源注入（`RandomSource`）贯穿 domain→factory→scheduler，测试用 random=0/1 精确断言 nextDueAt，时序逻辑完全确定化。
- **单一工厂方言**：validateCreateArgs/buildAlarm 被 tools 与 panel 共用（P2-① 是唯一旁路，且正因如此才被本评审抓出）。
- **读时迁移 + corrupt 降级**：v1 记录逐条归一化、坏记录进 corrupt 而非静默丢、mutating 工具拒绝——与 AGENTS.md"corrupt 降级"规范一致。
- **输出 schema 纪律**：ALARM_VIEW 可选字段不强制 required 并注释原因，"P0/P1" 回归测试直接跑 dsh-tools 输出门——防止未来加字段时踩 INVALID_TOOL_OUTPUT。
- **fork seed 语义**：completedTurnCut 纯函数可测，live/cold 双路读取，父不可读/无完成回合显式 failed——把平台最脆的部分做成可测纯函数。

## 5. 结论

准入。无 P0/P1。两条 P2（面板本地日期时间的时区语义、README 契约文档）建议在合入/验收前处理，P3 各项可按迭代节奏跟进。测试与构建声明（tsc 0 错、149 全绿、build 成功）全部复验属实。