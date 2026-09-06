# dsh-proactive

让 DeepSeek Harness 的模型**主动跟进**：给自己定 host 级闹钟，即使会话已冷却也会按时被唤醒；唤醒回合可以选择 `proactive_no_reply` 静默收尾——用户完全无感知。

两个典型场景：

1. **模型主动跟进**（`wake_reason: heartbeat`）：习惯教练式每日跟进、陪伴类的主动聊天、周期复查等都由模型自主发起，低频、受预算与安静时段约束；间隔/抖动等参数在创建时每个闹钟单独配置，无需全局预填。（v1 曾用 check_in/interval/companion 三种名称，行为完全一致，已合并统一为 heartbeat；旧存储值仍兼容。）
2. **用户委托闹钟**（`wake_reason: alarm`）：用户说"1 小时后提醒我"，模型用 `proactive_set` 给自己订闹钟，到点把用户唤醒；安静时段内用户委托提醒依然放行，预算耗尽也不跳过。

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
  "maxDeliveriesPerDay": 3,                    // 每 UTC 日可见投递上限（聊天文本/push/微信各计 1）
  "quietHours": { "start": "23:00", "end": "08:00", "timeZone": "Asia/Shanghai" },
  "maxWakeupsPerHour": 4,                      // 全 host 每小时唤醒次数上限
  "maxConcurrentPerSession": 1,                // 每会话并发在途唤醒数
  "bootOverduePolicy": "fire",                 // fire | notify-only | drop
  "maxRetriesPerFire": 3,                      // 单次唤醒的 busy/failed 重试上限
  "maxPromptLength": 4000,
  "heartbeatPrompt": "这是一个 heartbeat reminder，你可以选择与用户发送消息。记得完全进入你的人设和情境。 如果不希望发送消息，则用 proactive_no_reply 安静结束。"
}
```

环境变量覆盖：`DSH_PROACTIVE_ENABLED`、`DSH_PROACTIVE_MAX_DELIVERIES_PER_DAY`、`DSH_PROACTIVE_DATA_DIR`、`DSH_PROACTIVE_TIME_ZONE`。

## GUI 管理面板（v4）

Web GUI 提供两个互补的管理面（插件随 bundle 安装自动注册，无需额外配置）：

**对话页「主动唤醒」tab（会话视角）**——每个会话的对话页头部与 Chat/轨迹 并列出现「主动唤醒」页签：

- **会话闹钟**：只显示**当前会话**的闹钟（状态/模式/下次触发/唤醒原因），可新建、暂停/恢复、立即触发、编辑、取消；会话内的操作带归属校验，不能越权管理其他会话的闹钟。
- **每闹钟历史**：每个闹钟行可展开查看自己的唤醒记录（决策/预算增量/思考与回复摘要）。
- 激活的 tab 由框架记忆（切走再回仍是「主动唤醒」）。

**设置页「主动唤醒」节（全局视角）**：

- **全局配置**：启用开关、每日预算、安静时段（起止与时区）、心跳唤醒默认指令，均可直接编辑保存（`update_config` 动作持久化 `config.json` 并热应用，与工具同一套校验）。
- **单一闹钟表格**：列出**所有会话**的闹钟，可**筛选**（状态/模式/会话）与**排序**（下次触发/创建时间/指令），可暂停/恢复、立即触发、**编辑**（改指令/间隔/抖动/唤醒原因，保留 id 与历史）、删除；每个闹钟行可展开查看自己的唤醒历史。所属会话列显示**会话标题**（能解析时），标题旁的复制图标一键复制会话 id。
- **新建闹钟带目标会话**：新建表单显示「目标会话」选择器（取自现有闹钟归属 + 全局），不再产生无归属孤儿闹钟。
- **实时刷新**：两个面板都订阅 SSE 推送（`/api/dsh-proactive/events`），任一来源的变更（模型工具、面板、调度器）都会自动刷新；另提供 `/api/dsh-proactive/state`（快照，可带 `?session=`）与 `/api/dsh-proactive/action`（命令）。
- 无 webserver 的环境（headless profile）自动跳过面板路由，模型工具不受影响。

## 工具

| 工具 | 作用 |
|---|---|
| `proactive_set` | 建闹钟：`prompt` + 恰好一个 `at`（带显式时区的 RFC3339 或 {date,time,time_zone}）/ `after_seconds` / `every_seconds`(>=300)；可选 `time_zone`、`delivery`、`wake_reason`；`every_seconds` 可选 `jitter`(0..1) 让每次间隔随机抖动。`prompt` 对 `wake_reason=heartbeat` 可选（省略即用默认心跳提示词，见下） |
| `proactive_list` | 列出本会话活跃闹钟 |
| `proactive_cancel` | 按 id 取消 |
| `proactive_no_reply` | **唤醒回合专用**：静默收尾（`concludesTurn`），需单独调用且不产出文本 |
| `proactive_update_settings` | 部分更新 host 级设置：只改传入字段（`enabled`/`max_deliveries_per_day`/`quiet_hours`/`heartbeat_prompt` 等），持久化到 `config.json` 并热应用到运行中的调度器，重启后仍生效 |

唤醒回合的 framing 报文包含三条回复规则（用户需要时简短回复、冷会话且有时效走 push_notify/send_wechat、无需用户感知或静默更合适就 no_reply），并如实给出今日预算用量。`proactive_no_reply` 对**任何唤醒原因**（含用户委托 alarm）都可用——角色扮演等场景允许"不理用户更真实"的静默收尾。

### heartbeat 提示词的默认前置

`wake_reason=heartbeat` 的唤醒指令**始终**以配置的默认心跳提示词（`heartbeatPrompt`，设置面板可改）开头——那是经过调校的通用措辞，效果最好；`proactive_set` 的 `prompt` 只提供**额外方向**，在默认提示词之后追加（空或省略则只有默认提示词）。`proactive_update_settings` 的 `heartbeat_prompt` 可随时调整该默认值。

### 重复间隔的随机抖动（jitter）

固定间隔的重复闹钟（`every_seconds`）可以带一个 `jitter`（0..1）：从**第 2 次唤醒起**，每次实际间隔按 `(1 ± jitter·uniform(0,1))` 独立缩放，连续唤醒不再是节拍器——心跳更像人，也避免多会话在整点同步扎堆。首个周期固定（创建时 `now + every_seconds`，不抖动），之后每个间隔独立。细节：

- **何时生效**：`proactive_set` 或面板创建/编辑重复闹钟时显式传 `jitter`。未传则保持固定间隔（向后兼容）。
- **语义**：基于"上次唤醒之后再过一抖动间隔"，始终严格在未来（错过不补跑、不扎堆）；抖动再大也不会低于 300 秒的间隔下限。
- **面板展示**：重复闹钟行会显示 `±N%` 徽标；下一次触发时间如实反映抖动后的值。
- **每闹钟配置**：间隔与抖动没有全局/会话级默认偏好，每次创建或编辑重复闹钟时按闹钟单独填写（`proactive_set` 的 `every_seconds`/`jitter` 或面板表单）。

### 配置的双入口语义

同一份配置有两个编辑面，写入层不同：

| 入口 | 写入层 | 生效方式 |
|---|---|---|
| `proactive_update_settings` 工具 | `config.json`（原子写，持久） | 写入后立即热应用到运行中调度器；重启后仍生效 |
| 设置面板（Proactive 页签） | settings 服务层（base=启动时 config.json 快照） | 热应用立即生效；**重启后由 settings 层持久值胜出** |

若两者交替编辑：工具改动会实时反映在运行中的调度器与 `config.json`，但面板会话内可能显示旧值；面板随后保存任一字段会把其 base 合成值整表回写，覆盖工具改动（重启后以 settings 层最终值为准）。日常使用模型自主更新走工具即可；需要面板所见一致时，改完工具设置后刷新面板或重启。数值上限：工具严格遵循 `resolveConfig` 钳制（如并发 ≤4、重试 ≤10），面板 schema 更宽——工具接受的值不会被下次启动静默截断。

## 预算与安静时段

- **预算**：任何可见输出（聊天文本、push_notify、send_wechat）1 单位/次，按 UTC 日累计，上限 `maxDeliveriesPerDay`；`no_reply` 免费不计。预算用尽后，主动型唤醒（heartbeat）不再触发；用户委托的 alarm 仍会触发（用户显式要求优先，允许轻微超限）。
- **安静时段**：非 alarm 唤醒在安静时段内延迟（每 5 分钟重评估），结束时若有遗漏自动补一次；alarm 不受限。
- **失败处理**：busy/failed 递增重试，超过 `maxRetriesPerFire` 后按一次 skipped 记账并推进；重复闹钟错过的时间片不补跑，只推进到下一个锚点（对齐创建时刻）。

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

## 已知限制（v1）

- 唤醒后进程内 handle 会 dispose；若服务在唤醒途中重启，在途闹钟标记为 in-flight，重启后按 boot 策略重试/推进。
- 每个会话同一时刻最多一个在途唤醒；模型端需遵守 framing 规则按需告知用户。
- 安静时段/预算的判定基于 UTC 日 + 配置时区，不随用户时区自动迁移（重启后读取最新配置）。
