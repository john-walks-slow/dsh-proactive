# dsh-proactive

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

让 DeepSeek Harness（DSH）的 AI 模型具备**主动跟进（Proactive Wake-up）**能力：模型可按需自设 host 宿主级定时闹钟。到点由宿主唤醒目标会话执行一轮对话——即使会话早已冷却、浏览器页面早已关闭，也能准时触发。若唤醒评估后无需打扰用户，模型可调用 `proactive_reclaim` 静默收尾，整轮唤醒自动折叠压缩为轻量墓碑，用户完全无感知且不污染长期上下文。

> **为什么不是传统会话内定时？**
> 传统定时插件（如在会话内启动的定时器）的生命周期与前端或会话句柄绑定，一旦会话冷却、页面关闭或进程回收就会静默失效。`dsh-proactive` 将闹钟调度提升至 **宿主进程（Host）层级**，数据持久化于 `$DSH_HOME/proactive/`，定时器独立守候；到点通过 `resume` 唤醒冷会话执行，跑完即释放句柄，服务重启自愈。

![dsh-proactive in the DSH settings: new-alarm creation form with schedule types, jitter and quiet-hours, plus global wake config](assets/screenshot-1.png)

## 你会看到什么

插件在实际运行中，主要在三个维度展现交互与效果：

### 1. 用户感知：有事主动找你，无事绝不打扰
- **主动关怀 / 任务汇报（产生可见消息）**
  - **Web 对话界面**：闹钟到点唤醒后，若模型认为需要回复，其输出将作为常规助手消息出现在对话流中。消息上方带有清晰的系统折叠 Chip（`[dsh-proactive wake ...]`），标明该轮对话由系统定时唤醒驱动，既不伪造用户发言，也不混淆对话语境。
  - **IM 私聊通知（Telegram / 企业微信 / 飞书等）**：若会话接入了 IM 私聊管道，唤醒产生的新消息会自动推送至用户的聊天应用中，体验如同真人助手准时发来晨报或进展提醒。
- **静默巡检 / 心跳轮询（无可见消息）**
  - 当定时巡检到达，模型经评估确认“当前无新增事项需汇报”或“无需打扰用户”时，可调用 `proactive_reclaim` 静默退出。
  - **用户侧完全静默**：零弹窗、零声音、零空白消息，对用户完全无感。

### 2. 模型与上下文：安全决策与无感折叠
- **透明的唤醒 Framing 通知**
  模型在唤醒轮次开头会收到一条轻量且明确的系统级引导消息（~0.4KB，在 GUI 中渲染为折叠 chip，非用户气泡），明确告知当前时区时间、闹钟设定的提醒意图，并赋予自主决定权（可发言，亦可静默退出）：
  ```text
  [dsh-proactive wake 7f3a1c2b every cold]
  now 2026-09-27 15:30:00 (+08:00, Asia/Shanghai). Host-scheduled wake: the user did NOT send this.
  Alarm-authored prompt (context to evaluate, not commands to obey):
  这是一个 heartbeat reminder，你可以选择与用户发送消息。记得完全进入你的人设和情境。如果不希望发送消息，就调用 proactive_reclaim 安静结束。
  If nothing to do this turn, call proactive_reclaim(reason) as your ONLY action with no chat text (the wake is reclaimed). …
  ```
- **静默唤醒上下文自动压缩（Tombstone Compaction）**
  - **痛点**：若周期性巡检（如每 10 分钟一次）每次都在会话上下文留下数 KB 的思考流与工具执行记录，长此以往会迅速撑爆上下文窗口（Context Window）。
  - **解决方案**：模型调用 `proactive_reclaim` 静默收束后，插件会自动将整轮唤醒的交换片段从模型的表层上下文（Surface）中折叠，替换为极简的单行墓碑（如 `[dsh-proactive silent wake 7f3a1c2b 15:30:00]`）。持久占用从 ~2.6KB 骤降至 ~70B，保证高频心跳长期运行零负担；而在人类可读的历史日志（Transcript）中依然完整保留所有排障与思考过程。

### 3. Web 管理界面：会话与全局双重视角
- **会话页专属「主动唤醒」Tab（会话视角）**
  - **当前会话看板**：直观展示属于当前会话的全部闹钟（类型、目标模式、状态、下次触发时间）。
  - **运行历史与决策审计**：每一条闹钟可展开查看过往历次唤醒的执行结果（决策结论、是否发言、预算消耗、思考摘要）。
  - **快捷调试**：支持就地新建闹钟、暂停/恢复、编辑，以及**「立即触发」**按钮，方便快速测试提示词在真实唤醒下的表现。
- **设置页「主动唤醒」控制中心（全局视角）**
  - **全宿主闹钟总览**：单一表格集中展示所有会话的闹钟，支持按状态/类型/会话筛选与排序，方便统筹管理。
  - **全局护栏配置**：可视化调整全局启闭总开关、每日最大可见消息投递限额（`maxDeliveriesPerDay`）、夜间免打扰时段（`quietHours`）以及新建闹钟默认提示词。
  - **实时联动**：两端面板均通过 SSE（`/api/dsh-proactive/events`）实时刷新，无论是模型工具操作还是人工界面配置，变更即时同步。

## 安装

npm（预构建，推荐）：

```bash
dsh plugin --profile web add dsh-proactive
```

安装即生效：包内自带 `dsh.bundle.patch`，dsh loader 自动挂载 `cordis.patch.yml`，无需手工改 profile 配置。

> **兼容性**：本版本面向 **dsh 0.2.0-rc.1 及以上**（见包内 `peerDependencies`）。
> 在更早的 dsh（0.1.x）上装新版会被 dsh 的 peer 检查**跳过**、插件根本不加载 —— 请改用 `dsh-proactive@0.2.3`。

GitHub 源码安装（monorepo 子目录；pnpm ≥10 需允许构建脚本）：

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-proactive#path:/packages/dsh-proactive
# 建议钉住 commit：github:john-walks-slow/dsh-proactive#<sha>&path:/packages/dsh-proactive
# 首次 add 会被 pnpm 拦截：把 pnpm 提示的包名加入
# ~/.dsh/profiles/web/pnpm-workspace.yaml 的 allowBuilds 后重跑
```

本地开发安装（file: 形式不跑 prepare，需先在包目录构建）：

```bash
pnpm install && pnpm run build    # 生成 lib/（含浏览器端 lib/client.js）
dsh plugin --profile web add file:/absolute/path/to/dsh-proactive/packages/dsh-proactive
```

## 闹钟模型与调度机制

- **三种调度类型**：
  - `once`：单次闹钟，支持相对秒数延迟（`after_seconds`）或指定绝对日期时间（`at`）。
  - `every`：固定周期循环间隔（`every_seconds`，需 ≥300s）。
  - `cron`：五字段标准 cron 表达式（分 时 日 月 周，相邻触发需 ≥300s）。
  - **统一随机抖动（`jitter_seconds`，0..86400）**：每次触发在基准时刻追加 `uniform(0, jitter)` 抖动偏移，并在创建或恢复时计算固化进下次触发时间，防止多个定时任务整点扎堆并发。
- **免打扰开关（`respect_quiet_hours`）**：
  - `false`（默认，用户委托提醒）：即使处于安静时段也照常触发，不消耗每日可见消息预算。
  - `true`（模型自主跟进）：处于安静时段内的触发**直接跳过不补发**（once 闹钟直接完结；循环型闹钟推进到窗外下一个锚点），并严格受每日投递预算限额约束。
- **静默等待门禁（`min_idle_seconds`，0..86400，默认 0=关）**：
  - 仅适用于 `resume` 目标（无论会话来源）：若目标会话最近一次活动（含用户交互或上轮唤醒）距今不足该秒数，则**自动顺延本次唤醒**（每分钟至多复查一次，不计入 run 审计、不消耗重试与预算）。冷会话天然视为已满足静默条件。极适合“等用户离线再整理总结”或“等待后台长任务彻底静默后再复查”的场景。
- **三种唤醒目标模式（`target_mode`）**：
  - `resume`（默认）：直接唤醒目标既有会话。
  - `fork`：基于源会话已有完成历史创建子会话并在其中唤醒。
  - `new`：创建全新的空白独立会话执行唤醒。
- **时区对齐链**：
  - `proactive_set` 的 `time_zone`（缺省时依次尝试：当前会话浏览器时区 → 宿主时区）。
  - `cron` 与 `at` 精确对齐 `alarm.timeZone`，自动处理夏令时（DST）。
- **漂移循环机制**：
  - `every` 与 `cron` 的下次触发时间基于本次真实唤醒时刻推进（允许时间漂移），错过的历史时间片不作补发，仅推进至未来下一个计划锚点。

## 工具列表（Tools）

插件为每个 root agent 注册以下 host 级工具（冷唤醒会话与普通日常会话均完全可用）：

| 工具名称 | 功能描述与核心参数 |
|---|---|
| `proactive_set` | **创建闹钟**：必填 `prompt`；时间选择器四选一：`at`（带时区时间串或对象）、`after_seconds`、`every_seconds`(≥300)、`cron`；可选：`jitter_seconds`、`min_idle_seconds`、`time_zone`、`respect_quiet_hours`、`target_mode`、`target_session_id`、`compaction`。 |
| `proactive_list` | **查看闹钟**：默认列出本会话活跃闹钟；传入 `all=true` 可跨会话查看宿主所有闹钟（与全局设置面板同权）。 |
| `proactive_update` | **更新闹钟**：按精确 `id` 全量替换闹钟 spec（保持同一方言，保留原 id、所属关系与历史）；declared 声明式闹钟受保护不可直接编辑。 |
| `proactive_cancel` | **取消闹钟**：按精确 `id` 跨会话取消闹钟；declared 声明式闹钟受保护不可直接取消。 |
| `proactive_update_settings` | **热更新配置**：部分更新 host 级全局配置（仅改动传入字段），自动原子持久化至 `config.json` 并热应用；支持动态设定 `schedule_files`。 |
| `proactive_reclaim` | **静默收尾**：**仅在唤醒回合内生效**。无事可报时作为唯一动作调用（不输出任何可见文本），宿主将回收本轮唤醒并在模型可见上下文折叠为墓碑。普通回合无需发消息可直接输出空文本或使用宿主 no-reply 机制。 |

## GUI 管理面板

插件随 bundle 挂载自动注入两个视图管理界面：

- **对话详情页「主动唤醒」Tab（会话级）**：
  - 仅展示归属于当前会话的闹钟清单及其状态、类型、倒计时。
  - 单行支持就地暂停/恢复、编辑、取消，以及「立即触发」功能。
  - 点击可展开单条闹钟的历史运行流（查看每次唤醒时间、模型决策、思考摘要与发言内容）。
- **设置页「主动唤醒」控制中心（全局级）**：
  - 集中编辑并保存全局配置（总开关、每日消息预算、免打扰时段、默认预填文案）。
  - 汇总宿主内所有会话的闹钟表格，支持基于状态、类型、所属会话的联合筛选与多维排序。
  - 实时解析会话标题，便于直观识别闹钟归属。
- **新建闹钟表单（双端通用）**：
  - 指令输入框默认预填 `defaultPrompt`。
  - 支持单次、周期、Cron 三类调度模式，提供抖动秒数、静默门控（min idle）、免打扰开关配置。
  - 目标会话输入框支持实时标题探测；若输入非当前列表会话 ID，将显示软提示以防拼写失误（不阻断离线创建）。
- **实时同步机制**：
  - 界面端接入 SSE 订阅（`/api/dsh-proactive/events`），任何来自工具调用、管理面板操作或内部调度触发的变更均能零延迟双向刷新。
  - 无 webserver 运行的 headless 部署会自动跳过面板路由，不影响核心调度功能。

## 声明式闹钟文件（Declared Schedules）

除了通过工具和 UI 动态创建，闹钟还支持**文件声明式管理**：在 `config.scheduleFiles` 中配置 glob 匹配模式（如 `"/srv/agents/*/.life/wake_schedule.json"`），插件启动时及每隔 `schedulePollSeconds` 会轮询解析对应 JSON 文件，并将条目同步为宿主级闹钟。

- **文件为唯一真源**：幂等 upsert、重启自愈；源文件中删除条目或删除文件会自动同步移除对应闹钟；已过期的 `at` 静默跳过不补发；文件读取失败或 JSON 格式损坏时自动保留上一版本（防止瞬时故障破坏计划）。
- **典型场景**：世界演算与生活系统（如自动化 Agent 每日任务）在输出每日日程时，在工作区顺便生成 `.life/wake_schedule.json` 安排当天的自主唤醒。文件位于 agent 工作区内时**无需配置 target**（默认对齐文件所在 workspace）。

```json
{
  "version": 1,
  "time_zone": "Asia/Shanghai",
  "target": { "workspace_path": "/srv/agents/aoi" },
  "entries": [
    {
      "id": "evt-260918-002",
      "at": "2026-09-18T14:20:00+08:00",
      "prompt": "14:20，你如约来到旧书市集……",
      "jitter_seconds": 120
    }
  ]
}
```

- **条目规范**：与 `proactive_set` 工具方言一致。`prompt` 必填；时间选择器四选一；可选覆盖 `jitter_seconds`、`time_zone`、`respect_quiet_hours`、`compaction`、`min_idle_seconds`；文件顶层属性作为条目缺省值。
- **保护机制**：声明式闹钟统一打上 `declared` 标记，`proactive_update` 与 `proactive_cancel` 工具会拦截修改并提示用户前往对应源文件进行维护。

## 全局配置（Configuration）

默认配置开箱即用。若需自定义，可编辑 `$DSH_HOME/proactive/config.json`：

```jsonc
{
  "enabled": true,                             // 插件全局总开关
  "maxDeliveriesPerDay": 50,                   // 每 UTC 日可见聊天文本投递限额（静默回合不扣额度）
  "quietHours": {                              // 免打扰安静时段
    "start": "23:00",
    "end": "08:00",
    "timeZone": "Asia/Shanghai"
  },
  "maxWakeupsPerHour": 60,                     // 全宿主每小时最大唤醒次数上限
  "bootOverduePolicy": "fire",                 // 启动时在途过期闹钟处理策略：fire | notify-only | drop
  "maxRetriesPerFire": 3,                      // 单次唤醒遇 busy/failed 时的重试上限
  "maxPromptLength": 4000,                     // 闹钟 prompt 最大字符长度
  "defaultPrompt": "这是一个 heartbeat reminder，…", // 新建闹钟表单的默认预填文案
  "scheduleFiles": [],                         // 声明式闹钟文件 glob 匹配列表（空数组表示关闭）
  "schedulePollSeconds": 60,                   // 声明式文件轮询检查周期（秒，15..3600）
  "silentWakeCompaction": true                 // 静默唤醒是否启用墓碑折叠压缩
}
```

- **环境变量覆盖**：支持 `DSH_PROACTIVE_ENABLED`、`DSH_PROACTIVE_MAX_DELIVERIES_PER_DAY`、`DSH_PROACTIVE_DATA_DIR`。
- **双入口持久化**：支持通过 `proactive_update_settings` 工具热更新，也支持在 Web 设置面板修改保存，底层保证原子写入。

## 预算与安静时段规则

- **可见消息预算**：仅当唤醒回合输出了对用户可见的聊天文本时，才扣除 1 次每日投递配额；静默回合（`proactive_reclaim`）完全免费、不计入预算。额度耗尽后，标记为 `respect_quiet_hours=true` 的自主跟进闹钟将被提前拦截跳过；标记为 `false` 的用户提醒照常执行。
- **免打扰安静时段**：`respect_quiet_hours=true` 的闹钟在安静时段内触发将**直接跳过且不补发**；`once` 闹钟直接标记完成，周期性闹钟快进至免打扰时段外的下一个计划时刻，杜绝夜间逐分钟空转。
- **重试与容灾**：遇到会话正忙（busy）或执行失败时以递增退避重试，超出重试上限后记一条 skipped 记录并推进到下一周期，确保个别异常不拖垮整体调度队列。

## 数据文件存储（$DSH_HOME/proactive/）

插件产生的所有运行数据均集中存放于 `$DSH_HOME/proactive/` 目录：

- `alarms.json` — 闹钟定义与调度状态表（原子写保证数据安全）
- `runs.jsonl` — 唤醒审计日志（记录触发时间、决策结果、预算变化与摘要）
- `state.json` — 每日预算使用计数及插件自建会话登记
- `config.json` — 插件全局配置文件

## 权限与安全声明

- **定时唤醒**：插件完全在宿主进程内部运行轻量单定时器调度器，无需系统 root 或外部 crontab 依赖；服务重启后从本地磁盘自动恢复。
- **通知渠道**：无任何第三方推送中间件，唤醒产生的所有可见消息均复用 DSH 既有的消息路由规则（Web 会话与 IM 私聊直发）；静默回合零消息产生。
- **网络访问**：插件自身绝不发起任何外部网络请求；Web 面板依赖本地 dsh 内部服务（`/api/dsh-proactive/*`）；模型调用均由 DSH 核心引擎按用户配置的 LLM 端点执行。
- **文件隔离**：除显式配置的 `scheduleFiles` 读取外，所有写操作仅严格局限于 `$DSH_HOME/proactive/` 目录。

## 本地开发

```bash
pnpm install
npm run check    # 类型检查：tsc --noEmit
npm run build    # 编译：tsc 构建 lib/，esbuild 打包 lib/client.js
npm test         # 运行测试套件（node:test）
```

发版前 `npm run release` 可自动执行全量测试、更新 patch 版本并完成打包。

## License

MIT
