# dsh-proactive

让 DeepSeek Harness 的模型**主动跟进**：给自己定 host 级闹钟，即使会话已冷却也会按时被唤醒；唤醒回合可以选择 `no_reply` 静默收尾——用户完全无感知。

闹钟模型（v2）：

- **三种类型**：`once`（单次）/ `every`（循环间隔）/ `cron`（五字段表达式），三类型统一支持 `jitter_seconds` 随机延迟。
- **一个开关**：`respect_quiet_hours`——`false`（默认）表示用户委托提醒：安静时段照常触发、不占日预算；`true` 表示模型自主跟进：遵从安静时段与日预算。
- **三个目标会话**：`resume`（既有会话，默认）/ `fork`（从源会话 fork 出新会话）/ `new`（新建空会话）。

## 与 dsh-schedule 的区别

dsh-schedule 的提醒是**会话内**的：会话凉了就不会触发。dsh-proactive 把闹钟存在 **host 级**（`$DSH_HOME/proactive/`），到点用 `ctx.agents.resume()` 把冷会话唤起来执行一次，跑完即释放（进程内 handle dispose，持久化会话不受影响）。

## 安装

0. 构建产物前置（本地开发包）：`pnpm install && pnpm run build`（生成 `lib/`，含浏览器半边 `lib/client.js`）。

1. 在 profile 目录（如 `/root/.dsh/profiles/web`）安装本包（本地路径）：

```bash
dsh plugin --profile web add file:/root/projects/dsh-proactive/packages/dsh-proactive
# 等价于在 profile 目录执行：pnpm add file:...
```

2. 把包名加入 profile `package.json` 的 `dsh.profile.bundles` 数组。本包自带 `dsh.bundle.patch`，bundles 加载时其 `cordis.patch.yml`（插入一行 `dsh-proactive` 插件实例）会被 dsh loader 自动应用——profile 的 cordis.patch.yml 无需手工改动。

3. 重启 dsh 服务（启动时扫描并给现有 root agents 注册 `proactive_*` 工具）。

## 配置

默认值即可用。自定义：在 `$DSH_HOME/proactive/config.json`：

```jsonc
{
  "enabled": true,
  "maxDeliveriesPerDay": 3,                    // 每 UTC 日可见聊天文本投递上限（no_reply 不计）
  "quietHours": { "start": "23:00", "end": "08:00", "timeZone": "Asia/Shanghai" },
  "maxWakeupsPerHour": 4,                      // 全 host 每小时唤醒次数上限
  "maxConcurrentPerSession": 1,                // 每会话并发在途唤醒数
  "bootOverduePolicy": "fire",                 // fire | notify-only | drop
  "maxRetriesPerFire": 3,                      // 单次唤醒的 busy/failed 重试上限
  "maxPromptLength": 4000,
  "defaultPrompt": "这是一个 heartbeat reminder，…" // 新建闹钟表单的预填文案（纯预填，闹钟各自保存 prompt）
}
```

环境变量覆盖：`DSH_PROACTIVE_ENABLED`、`DSH_PROACTIVE_MAX_DELIVERIES_PER_DAY`、`DSH_PROACTIVE_DATA_DIR`。

## GUI 管理面板（v4）

Web GUI 提供两个互补的管理面（插件随 bundle 安装自动注册，无需额外配置）：

**对话页「主动唤醒」tab（会话视角）**——每个会话的对话页头部与 Chat/轨迹 并列出现「主动唤醒」页签：

- **会话闹钟**：只显示**当前会话**的闹钟（类型/目标/状态/下次触发），可新建、暂停/恢复、立即触发、编辑、取消；会话内的操作带归属校验，不能越权管理其他会话的闹钟。
- **每闹钟历史**：每个闹钟行可展开查看自己的唤醒记录（决策/预算增量/思考与回复摘要）；fork/new 子会话的唤醒也归入 owner 历史。
- 激活的 tab 由框架记忆（切走再回仍是「主动唤醒」）。

**设置页「主动唤醒」节（全局视角）**：

- **全局配置**：启用开关、每日预算、安静时段（起止与时区）、**默认唤醒指令**（`defaultPrompt`，新建闹钟表单的预填文案），均可直接编辑保存（`update_config` 动作持久化 `config.json` 并热应用，与工具同一套校验）。
- **单一闹钟表格**：列出**所有会话**的闹钟，可**筛选**（状态/类型/会话）与**排序**（下次触发/创建时间/指令），可暂停/恢复、立即触发、**编辑**（改指令/类型参数/jitter/目标/免打扰开关，保留 id 与历史）、删除；每个闹钟行可展开查看自己的唤醒历史。所属会话列显示**会话标题**（能解析时），标题旁的复制图标一键复制会话 id。
- **新建闹钟（两面板同一表单）**：唤醒指令预填 `defaultPrompt`；类型三选（单次延迟或指定日期时间 / 循环间隔 / cron）+ 统一随机抖动 + 免打扰开关；**目标会话为会话 ID 输入框**（默认当前会话——会话页取本会话、设置页取 GUI 当前选中会话），resume=唤醒该会话、fork=从该会话分支、new=唤醒时新建空会话；输入框下方**实时显示该 ID 对应的会话标题**（session.list 命中即显示，resume/fork 两模式共用），不在列表中的 ID 停止输入 500ms 后显示笔误软提示（不阻断提交，冷会话/外部 ID 仍可创建）。归属不单独挑选：会话页钉死本会话，设置页按目标派生（resume/fork 归属目标会话，new 归属当前会话或全局伪会话）。首次拉取快照期间显示加载 spinner。
- **实时刷新**：两个面板都订阅 SSE 推送（`/api/dsh-proactive/events`），任一来源的变更（模型工具、面板、调度器）都会自动刷新；另提供 `/api/dsh-proactive/state`（快照，可带 `?session=`）与 `/api/dsh-proactive/action`（命令）。
- 无 webserver 的环境（headless profile）自动跳过面板路由，模型工具不受影响。

## 工具

| 工具 | 作用 |
|---|---|
| `proactive_set` | 建闹钟：`prompt`（必填）+ 恰好一个 `at`（带显式时区的 RFC3339 或 {date,time,time_zone}）/ `after_seconds` / `every_seconds`(>=300) / `cron`(五字段，相邻触发 >=300s)；可选 `jitter_seconds`(0..86400，三类型通用)、`time_zone`（缺省 = 会话浏览器时区 → 宿主时区）、`respect_quiet_hours`(默认 false)、`target_mode`(resume/fork/new) + `target_session_id` |
| `proactive_list` | 列出本会话的活跃闹钟（含类型/目标/下次触发/状态） |
| `proactive_cancel` | 按 id 取消 |
| `no_reply` | **任意回合可用**：静默收尾（`concludesTurn`），需单独调用且不产出文本；唤醒回合内调用会记录一条 no_reply 运行记录 |
| `proactive_update_settings` | 部分更新 host 级设置：只改传入字段（`enabled`/`max_deliveries_per_day`/`quiet_hours`/`max_prompt_length`/`default_prompt` 等），持久化到 `config.json` 并热应用到运行中的调度器，重启后仍生效 |

唤醒回合的 framing 报文说明唤醒类型、`respect_quiet_hours`、今日预算用量，并给出两条回复规则（需要时简短回复、无需用户感知或静默更合适就 no_reply）。

### 随机延迟（jitter_seconds）

三种类型的闹钟都可带一个 `jitter_seconds`（0..86400，`every` 要求 ≤ 间隔）：每次计划触发时刻后追加 `uniform(0, jitter_seconds)` 秒的随机延迟，创建/恢复时抽取并**烘焙进 nextDueAt**——调度循环本身从不等待。效果类似 systemd 的 `RandomizedDelaySec`，避免多闹钟整点同步扎堆，也更像人的节奏。

- **面板展示**：带 jitter 的闹钟行显示 `±Ns` 徽标；下次触发时间如实反映延迟后的值。
- **每闹钟配置**：`proactive_set` 的 `jitter_seconds` 或面板表单，按闹钟单独填写。

### 配置的双入口语义

同一份配置有两个编辑面，写入层不同：

| 入口 | 写入层 | 生效方式 |
|---|---|---|
| `proactive_update_settings` 工具 | `config.json`（原子写，持久） | 写入后立即热应用到运行中调度器；重启后仍生效 |
| 设置面板（Proactive 页签） | settings 服务层（base=启动时 config.json 快照） | 热应用立即生效；**重启后由 settings 层持久值胜出** |

若两者交替编辑：工具改动会实时反映在运行中的调度器与 `config.json`，但面板会话内可能显示旧值；面板随后保存任一字段会把其 base 合成值整表回写，覆盖工具改动（重启后以 settings 层最终值为准）。日常使用模型自主更新走工具即可；需要面板所见一致时，改完工具设置后刷新面板或重启。数值上限：工具严格遵循 `resolveConfig` 钳制（如并发 ≤4、重试 ≤10），面板 schema 更宽——工具接受的值不会被下次启动静默截断。

## 预算与安静时段

- **预算**：唤醒回合写了可见聊天文本 1 单位/次，按 UTC 日累计，上限 `maxDeliveriesPerDay`；`no_reply` 免费不计。预算用尽后，`respect_quiet_hours=true` 的自主跟进闹钟提前跳过（记一次 skip 并推进到下一个计划点）；`false` 的用户委托闹钟照常触发（用户显式要求优先，允许轻微超限）。
- **安静时段**：`respect_quiet_hours=true` 的闹钟在安静时段内延迟（每 5 分钟重评估一次）；`false` 的闹钟不受限，照常触发。
- **失败处理**：busy/failed 递增重试，超过 `maxRetriesPerFire` 后按一次 skipped 记账并推进；重复/循环闹钟错过的时间片不补跑，只推进到下一个计划点；cron 对齐 `alarm.timeZone`（缺省 = 会话浏览器时区 → 宿主时区）。

## 数据文件（$DSH_HOME/proactive/）

- `alarms.json` — 闹钟表（原子写：tmp+rename）
- `runs.jsonl` — 每次唤醒的审计记录（决策/预算增量/备注）
- `state.json` — 每日预算计数
- `config.json` — 上述配置（可选）

## 开发

```bash
pnpm install
npm run check    # tsc --noEmit
npm run build    # tsc -p tsconfig.build.json -> lib/
npm test         # 编译 + node:test
```

## 已知限制

- 唤醒后进程内 handle 会 dispose；若服务在唤醒途中重启，在途闹钟标记为 in-flight，重启后按 boot 策略重试/推进。
- fork/new 目标在 host 缺少会话持久化（headless profile）时降级为 failed 并如实记录，不会假装成功。
- 安静时段/预算的判定基于 UTC 日 + 配置时区，不随用户时区自动迁移（重启后读取最新配置）。
