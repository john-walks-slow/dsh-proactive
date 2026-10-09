# 261009 文件表闹钟（第四种闹钟类型）— 计划

## 背景

260918 版声明式闹钟的做法是：宿主在 `config.scheduleFiles` 里配一个全局 glob
（线上为 `/root/agents/*/.life/wake_schedule.json`），插件启动即轮询，把命中的文件
解析成一堆 `declared` 闹钟（owner 固定为合成 id `declared-schedule`）。

问题：**"读哪个文件"是宿主的隐式配置，不是闹钟列表里的一件东西**。模型无法创建、
取消、暂停这个"订阅"；闹钟只是同步产物，没有归属、没有生命周期、在面板里也看不出
它是从哪来的。

目标：改成**第四种闹钟类型**——选择器 `schedule_file`（单个绝对文件路径）。闹钟
本身是这份计划文件的**句柄**：自己不触发唤醒，只把文件条目物化成子闹钟；创建 /
取消 / 暂停 / 编辑都随句柄走。全局 glob 机制与 `schedule_files` 设置项一并删除。

建模取舍（专家审查确认）：句柄 = 第四种 AlarmType 优于"独立 sources 集合"（那要造
第二套领域实体与 CRUD/视图 schema，违背本仓库"不做平行实现"的取向），也优于"条目即
闹钟、不设句柄"——**只有句柄能在文件缺失/为空/条目全非法时保住订阅的存在性**，这正是
260928 静默失效事故的缺口。代价是 `type` 兼具"触发计划"与"订阅"两义：收敛到 domain
里唯一谓词 `firesAlarm(type)`，所有消费点（dueAlarms / arm / toAlarmView 的 overdue /
面板 fire）只调它。

## 用户路径

1. **模型创建**：`proactive_set(schedule_file="/root/agents/yu/.life/wake_schedule.json")`
   → 生成一个 file 类型句柄；target 缺省按下面的严格规则解析；文件已存在则**立即**
   同步出子闹钟（不等到下一个轮询 tick）。
2. **world master bootstrap**：`proactive_list all=true` 查缺，为每个 living agent 工作区
   建一个句柄（**显式传 target**，已存在则跳过）；之后每天只重写 `wake_schedule.json`。
3. **面板**：类型选"文件表"，填绝对路径与目标；列表里出现一行（行内显示文件与子条数，
   子闹钟的唤醒历史**归并到句柄行**渲染）；编辑改路径/目标缺省（bare edit 不换目的地）；
   暂停 = 立即停止同步（子闹钟退出）；删除 = 句柄与子闹钟一起消失；该类型不提供"立即触发"。
4. **重复创建**：对已有句柄的同一（规范化后）文件再 set → `invalid_action`，消息给出已有 id。

## 设计

### 领域模型（domain.ts）

- `AlarmType` 增加 `"file"`；新增 `FileTrigger { file: string }` 并入 `AlarmTrigger`。
- `firesAlarm(type): boolean`（`type !== "file"`）作为唯一判据。
- `Alarm.declared` 增加 `sourceId?: string`（父句柄 id；**可选**——迁移期旧记录没有它，
  类型若写必填则读到的是谎话）。子闹钟 owner = **父句柄的 ownerSessionId**，删除合成
  owner `declared-schedule`。
- `targetArgsOf(target: AlarmTarget): Record<string, unknown>`：`AlarmTarget → 扁平
  target_* args` 的**唯一**投影函数（flattenTarget 的逆），5 个臂（session / workspace /
  preset / new / legacy workspace）各有单测，断言投影结果能过 `validateCreateArgs(args, "")`。
  没有它，session 源句柄的条目会因为投影缺 id 而走 keptIds **静默丢弃**。
- 句柄 `nextDueAt`：取在跑子闹钟（`scheduled` 与 `in-flight` 都算）里最早的 `nextDueAt`；
  **无候选时保持原值不写**（不回落 createdAt，否则每轮 sync 都 mutated 且面板显示古代时刻）。
  仅在与派生值不同时写回。`toAlarmView` 对 file 类型不做 overdue 判定。
- `AlarmView`：`type` 含 `"file"`；新增 `scheduleFile?`（自 trigger 透出）与
  `declaredEntries?`（子闹钟数，调用层现算，不落盘）。

### 创建与校验（alarm-factory.ts）

- 选择器五选一：`at | after_seconds | every_seconds | cron | schedule_file`。
- `schedule_file` 校验：非空字符串、绝对路径、无 NUL、长度 ≤512、不含 glob 元字符 `* ?`
  （明确报错，避免照旧文档写 glob 却永不匹配）。
- **路径规范化 + 唯一性**（写在 `schedule-file.ts`，tools/panel 共用）：
  - `canonicalizeScheduleFile(file)`：`path.resolve` + 去尾斜杠；目录存在时对 **dirname**
    取 `realpath`（折叠符号链接）。规范形式**同时**进 store 与子闹钟 id 计算——否则同一
    物理文件的两种写法会得到两个句柄、两套 id、同一批唤醒触发两遍。
  - `findScheduleHandle(alarms, canonicalFile, excludeId?)`：唯一性检查的单一实现。
- **target 缺省（严格规则）**：完全没有 target_* 参数时，只接受"文件的**祖父目录**
  （`dirname(dirname(file))`）恰好是一个已注册 workspace"这一约定（即 `<workspace>/<目录>/<文件>`）；
  命中 → `target_workspace_id`（源 = workspace）；未命中或没有 workspace registry →
  闭式 `not_found`，提示显式传 `target_workspace_path` / `target_session_id`。
  **不做逐级上溯**：本机 registry 里 `/root`、`/root/projects`、`/usr/bin` 都是工作区，
  上溯会把未注册的 agent 目录静默指到 `/root`（260928 同族故障：`world-master` 未注册
  → 整条通道静默失效）。命中时在返回的 view `targetWorkspaceId` 上回显 + 一条 warn。
- `prompt` 仍必填；在 file 类型下它是子条目的缺省 prompt。

### 同步（新文件 `schedule-sync.ts` + `schedule-file.ts`）

glob 死后 `declared.ts` 三合一（解析 + 同步 + 轮询）已过载，按单一职责拆成：
`schedule-file.ts`（路径规范化 / 唯一性 / 文件格式解析 / 目标投影）+ `schedule-sync.ts`
（期望集合 diff + 定时器）。删除 `globToRegExp` / `expandPattern` / `MAX_MATCHED_FILES` /
`DECLARED_OWNER`。

- 活跃句柄 = `type === "file" && status === "scheduled"`。
- 每个活跃句柄：
  - 文件 **ENOENT** → 期望集合为空（撤销计划，子闹钟移除）。
  - 读取失败 / JSON 非法 / version 不支持 → broken：**保留**该句柄现有子闹钟 + warn。
  - 解析成功 → 期望条目集合；条目准备失败（target 投影失败 / 闭式校验失败 / 过去 `at`）
    → `keptIds` 保留同 id 现有子闹钟（坏编辑降级为"无变化"）。
- **参数分层**：
  - `target`：**整对象选层**，`条目.target > 文件顶层.target > 句柄.target`，选中即用，
    其余层完全丢弃——禁止跨层 key-wise 合并（那是 260928 残留键 bug 的同一类：句柄
    `new` + 条目 `session_id` 会拼出非法组合）。
  - 其余键（`prompt` / `time_zone` / `respect_quiet_hours` / `jitter_seconds` /
    `compaction` / `min_idle_seconds`）正交，key-wise 覆盖：条目 > 文件顶层 > 句柄 > 方言默认。
- 子闹钟：id 仍 `decl_<sha256(canonicalFile\0entry)>`；`declared = { file: canonicalFile,
  entry, hash, sourceId }`；hash 未变 → 完全 no-op（保住 min_idle `defer` 状态与 jitter 锚点）。
- **移除规则一条**（in-flight 跳过本轮）：`declared` 的 `sourceId` 不指向一个活跃句柄
  → 删除（覆盖孤儿、句柄已删、句柄已暂停/终态三种情形）；否则若不在期望集合且非
  `keptIds`，且其文件不是"broken 且句柄仍在"→ 删除。
- **B2 竞态复检**：desired 计算含 `await`（工作区解析），apply 每条之前**复检**
  `store.getAlarm(handleId)` 仍存在且 `status === "scheduled"`，否则跳过——否则与
  cancel/pause 竞态会复活孤儿子闹钟，并在 `scheduled` 且已过期时**真实唤醒一次**。
- **B1 串行化**：对外只暴露 `enqueueSync()`（内部就是那条 chain，await 本次 pass 的结果）；
  轮询 tick 用同一入口；`addAlarm` 前若 id 已存在则走 replace 分支作廉价护栏。
  （原设计让 `syncOnce` 绕过 chain → 两趟 pass 并发 addAlarm → 重复 id、双触发。）
- 句柄派生 `nextDueAt` 变化时写回（无候选不写）。
- 轮询：保留 `schedulePollSeconds`（15..3600，默认 60，仅 config.json）；timer 常驻，
  无 file 闹钟时空转不读盘。
- **同步摘要（内存态，不落盘）**：`lastSummary = { lastAt, created, updated, removed,
  errors[] }` 暴露给面板快照与工具。cordis 的 info/warn 不落盘（260928 数日无人察觉的
  前提），"错误只进日志"等于保留静默失效；这条让用户/模型能自证"文件确实物化了 N 条"。

### 工具面（tools.ts）

- `proactive_set` / `proactive_update`：`ALARM_SPEC_PARAMETERS` 增加 `schedule_file`，
  描述讲清第 4 种类型、严格 target 缺省规则与"一个文件一个闹钟"。
- `ALARM_VIEW_SCHEMA`：`type` enum 加 `"file"`；加 `scheduleFile` / `declaredEntries`
  （可选属性，不能加 `required: true`——dsh-tools 会编译成顶层 required 而炸输出门禁）。
- `proactive_cancel`：句柄 → 连同子闹钟一并删除，返回值增加 `removedChildren`；
  persist 失败要**全部回滚**（句柄 + N 个子闹钟）。子闹钟仍拒绝（提示改源文件）。
  文档写明：in-flight 子闹钟的回合无法取消，结束后会写一条 `alarmId` 已不存在的 run
  （随句柄删除从面板消失）。
- `proactive_update`：句柄可编辑（全量替换语义）。**file 类型专属 carryover**：没有任何
  target 参数时把 `current.target` 整体投影注入——否则 source=session 的句柄在 bare edit
  后会被方言默认（=owner 会话）静默换目的地。换路径 → 旧子闹钟下轮同步被清、新文件条目
  重建；唯一性检查排除自身。
- `proactive_list`：**默认隐藏子闹钟**（有 `declared` 者），只列常规闹钟与文件句柄
  （`all=true` 同样隐藏）；`declaredEntries` 透出。
- `proactive_update_settings`：删除 `schedule_files` 字段、校验与回写；`settingsView` 去掉。

### 配置（config.ts）

- `ProactiveConfig` 删除 `scheduleFiles`；删除 `parseScheduleFiles` / `MAX_SCHEDULE_FILES`；
  保留 `schedulePollSeconds`。旧 `scheduleFiles` 键成为惰性未知键（不读不报错），迁移时删。

### 面板（panel + client）

- `contract.ts`：`PanelCreateForm.kind` 加 `"file"`；加 `scheduleFile?`；
  `createArgsFromForm` 在 kind=file 时产出 `args.schedule_file`；`AlarmRowView.declaredEntries?`；
  `PanelSnapshot.server.sync?`（上次同步摘要）。
- `service.ts`：file 专属处理（规范化 / 严格 target 缺省 / 唯一性 / 创建与编辑后立即
  `enqueueSync` + `requestDrive`）；`toggle` 也走 `enqueueSync`（否则暂停后最长 60s
  子闹钟仍可能触发一次）；`fire` 对 file → `invalid_action`；快照：**两个视图都**滤掉子
  闹钟行、现算 `declaredEntries`、并把子闹钟的 runs **归并到句柄行**（`runsByAlarm` 按
  `sourceId` 折叠，否则文件驱动的唤醒历史在面板彻底不可见——runs 是挂在 alarm row 下渲染的）。
- `client/host-api.ts`：客户端独立 DTO 同步加 `"file"` / `scheduleFile` / `declaredEntries`
  / `sync`。`client/index.ts` 的 `LocaleNamespaceMap` union 补新文案键。
- `client/sections.tsx`：typeLabel switch、类型下拉、三按钮数组（→ 4）、
  `formFromAlarm`（file → kind "file"，否则退化成 "once"）、submit guard（file 必填路径）；
  file 行不显示"立即触发"；行内显示文件路径与子条数。`locales.ts` 补 zh/en。

### 文档

- `README.md` / `README.en.md`：声明式章节改写为"文件表闹钟（第 4 种类型）"——工具与面板
  用法、文件格式与优先级、严格 target 缺省规则、生命周期、**原子写是硬契约**（delete+create
  之间的瞬时 ENOENT 会真的丢一条 `at` 唤醒；截断中间态由 JSON 损坏兜底）、**编辑句柄 =
  重排子条目**（recurring 子闹钟以 now 重建锚点）。配置表删除 `scheduleFiles`。
- `AGENTS.md`（根 + 包）：地图改指本特性；declared 一节替换为 schedule-file/schedule-sync；
  写明 owner 变化的两个隐性语义（new 模式子闹钟经 owner 会话继承 cwd；更新时时区默认链
  跟随 owner）。
- `create-simulated-events` SKILL.md：生效前提改为"每个 agent 工作区已有一个 file 句柄
  （world master 用 `proactive_list all=true` 查缺、**显式传 target** 补齐）"；原子写契约；
  文件格式与 `check_wake_schedule.mjs` 不变。
- 新增 `261009-file-alarm-type.validation.md`（含线上重启 + 次日 world master 重写的实机验收）。

### 迁移（不可跳过的有序清单）

> 本次变更**不可回滚到旧 lib**：旧 `ALARM_TYPES` 不认 `type:"file"` → 整店判 corrupt →
> 空 store，而 260928 已证"corrupt 后启动即 persist"会真正销毁现场。

1. `cp /root/.dsh/proactive/alarms.json alarms.json.bak-261009`；同时删掉 config.json 里
   的 `scheduleFiles` 键。
2. 构建 + 部署 + 重启（需用户书面同意）。
3. **立即**为线上 4 个文件建句柄，每个**显式传 target**：`/root/agents/{luna,rev,yu,world-master}/.life/wake_schedule.json`。
   在此之前，旧的 3 条 declared 会被首轮同步按孤儿清掉，6 条定时唤醒处于断供状态
   （`0 5 * * *` 这类 cron 错过即错过）。
4. 校验：alarms.json 子闹钟数 = 6（luna-heartbeat / luna-midnight-free / rev-heartbeat /
   yu-heartbeat / yu-diary-10pm / world-evolution-5am）；`GET /api/dsh-proactive/state`
   无 corrupt；面板句柄行子条数正确。
5. 再更新 skill 与文档。子闹钟 id 不变（runs.jsonl 历史连续），但面板 runCount 从 0 重来。

## 非目标

- 不做 glob / 多文件句柄（一个闹钟 = 一个文件，要多个就多个闹钟）。
- 不落盘"文件同步健康度"字段（摘要只在内存/快照里）。
- 不为旧 `config.scheduleFiles` 做自动迁移或兼容开关。

## 实施切片

- **切片 A（无 UI，单测可验）**：domain / store / alarm-factory / schedule-file /
  schedule-sync / tools / config / index 装配（迟到绑定 holder，避免"sync 必须先于工具注册"
  这种隐式顺序耦合）+ 单测。
- **切片 B**：panel + client + README/AGENTS/skill/validation + e2e。

## 实施清单

- [ ] `domain.ts`：`AlarmType`/`FileTrigger`/`firesAlarm`/`declared.sourceId?`/`targetArgsOf`/`AlarmView.scheduleFile`/overdue 分支
- [ ] `alarm-factory.ts`：kind `file` 校验 + 触发器构造 + 五选一
- [ ] `store.ts`：`ALARM_TYPES` 加 file、`isTriggerForType` 加 file 分支、`declared.sourceId?` 校验
- [ ] `schedule-file.ts`（新）：canonicalize / findScheduleHandle / 解析 / 目标分层
- [ ] `schedule-sync.ts`（新）：串行 `enqueueSync` / 期望集合 diff / 竞态复检 / 孤儿清扫 / 派生 nextDueAt / 摘要
- [ ] 删除 `declared.ts` 与 glob 相关导出；`config.ts` 去掉 scheduleFiles
- [ ] `tools.ts`：schedule_file 参数、唯一性、cancel 连带（全量回滚）、list 隐藏子闹钟、update 的 file carryover、update_settings 收口、输出 schema enum
- [ ] `index.ts`：holder 迟到绑定 + 注入 tools/panel
- [ ] 测试：`declared.test.ts` 重写为 `schedule-sync.test.ts`（并删 glob 用例）、`config.test.ts` 删 parseScheduleFiles 用例；补 domain/factory/tools/store 用例
- [ ] 切片 B：panel contract/service、client（host-api/index/sections/locales）
- [ ] 文档：README 中英 / AGENTS 根与包 / SKILL.md / validation.md
- [ ] e2e（`schedule-file.mjs`）：用 panel action **显式传 target_session_id** 建句柄（绕开
  registry 与"祖父目录"两个不确定量），断言 `$DSH_E2E_HOME/proactive/alarms.json` 的父子
  结构、改条目替换、删文件子闹钟消失、rename 重写不抖动、坏 JSON 保留
- [ ] 构建 + 审查 + 迁移清单执行

## 验收

1. 单测：创建 kind=file（glob 拒绝、相对路径拒绝、同文件两种写法重复 → `invalid_action`）、
   严格 target 缺省（祖父目录命中 / 未命中闭式报错）、`targetArgsOf` 5 臂可过校验、
   条目优先级（target 整对象选层 + 标量 key-wise）、hash 未变 no-op、条目删除 / 文件删除 /
   句柄暂停 → 子闹钟移除、孤儿清扫、JSON 损坏保留、两趟并发 `enqueueSync` 只产生一条子闹钟、
   file 闹钟永不进入 runWake。
2. 单测：`proactive_list` 隐藏子闹钟并给出 `declaredEntries`；`cancel` 句柄连带删除、persist
   失败全量回滚。
3. 面板单测：create kind=file、edit 回填与 bare edit 不改目的地、`toggle` 暂停后子闹钟消失、
   `fire` 拒绝、子行被滤而 runs 归并到句柄行、`server.sync` 摘要。
4. e2e 按上文脚本。
5. 线上按迁移清单第 3-4 步验收（需用户同意重启）。
