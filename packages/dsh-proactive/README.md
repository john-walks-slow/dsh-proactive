# dsh-proactive

让 DeepSeek Harness 的模型**主动跟进**：给自己定 host 级闹钟，即使会话已冷却也会按时被唤醒；唤醒回合可以选择 `proactive_no_reply` 静默收尾——用户完全无感知。

两个典型场景：

1. **模型主动跟进**（`wake_reason: heartbeat`）：习惯教练式每日跟进、陪伴类的主动聊天、周期复查等都由模型自主发起，低频、受预算与安静时段约束；面板提供「心跳预设」一键按默认提示词与间隔（60 分钟）新建。（v1 曾用 check_in/interval/companion 三种名称，行为完全一致，已合并统一为 heartbeat；旧存储值仍兼容。）
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
  "heartbeatPrompt": "这是一个 heartbeat reminder，你可以选择与用户发送消息。记得完全进入你的人设和情境。 如果不希望发送消息，则用 proactive_no_reply 安静结束。",
  "heartbeatEverySeconds": 3600                // 心跳预设默认间隔（最小 300，最大 86400）
}
```

环境变量覆盖：`DSH_PROACTIVE_ENABLED`、`DSH_PROACTIVE_MAX_DELIVERIES_PER_DAY`、`DSH_PROACTIVE_DATA_DIR`、`DSH_PROACTIVE_TIME_ZONE`。

## GUI 管理面板（v2）

Web GUI 的设置面板中会出现「Proactive 闹钟」页签（插件随 bundle 安装自动注册，无需额外配置）：

- **闹钟管理**：列出全部闹钟（状态/模式/下次触发/唤醒原因），可新建、暂停/恢复、立即触发、取消；面板操作与 `proactive_*` 工具共用同一套校验与错误码。
- **心跳预设**：点「心跳预设」一键预填默认心跳提示词与默认间隔（60 分钟、`wake_reason=heartbeat`），可改后保存；提示词与间隔在设置面板可改（`heartbeatPrompt` / `heartbeatEverySeconds`），改即生效。
- **最近唤醒**：运行记录表展示每次唤醒的时间、决策（no_reply/reply/push/skipped/failed）、预算增量，以及**思考与回复摘要**（截断至 200 字符，悬浮看全文）——帮助理解模型在唤醒回合里为什么这样决策（含静默 no_reply 的理由）。
- **配置即改生效**：设置面板中的 proactive 配置（启用、每日预算、安静时段、每小时上限、并发、boot 策略、重试、max prompt）通过官方 settings 通道热更新，无需重启；`config.json`/环境变量作为默认层继续生效，面板改动覆盖它们。
- **实时刷新**：面板订阅 SSE 推送（`/api/dsh-proactive/events`），任一来源的变更（模型工具、面板、调度器）都会自动刷新；另提供 `/api/dsh-proactive/state`（快照）与 `/api/dsh-proactive/action`（命令）。
- 无 webserver 的环境（headless profile）自动跳过面板路由，模型工具不受影响。

## 工具

| 工具 | 作用 |
|---|---|
| `proactive_set` | 建闹钟：`prompt` + 恰好一个 `at`（带显式时区的 RFC3339 或 {date,time,time_zone}）/ `after_seconds` / `every_seconds`(>=300)；可选 `time_zone`、`delivery`、`wake_reason` |
| `proactive_list` | 列出本会话活跃闹钟 |
| `proactive_cancel` | 按 id 取消 |
| `proactive_no_reply` | **唤醒回合专用**：静默收尾（`concludesTurn`），需单独调用且不产出文本 |

唤醒回合的 framing 报文包含三条回复规则（用户需要时简短回复、冷会话且有时效走 push_notify/send_wechat、无需用户感知或静默更合适就 no_reply），并如实给出今日预算用量。`proactive_no_reply` 对**任何唤醒原因**（含用户委托 alarm）都可用——角色扮演等场景允许"不理用户更真实"的静默收尾。

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
npm test         # 编译 + node:test（86 个单测）
```

## 已知限制（v1）

- 唤醒后进程内 handle 会 dispose；若服务在唤醒途中重启，在途闹钟标记为 in-flight，重启后按 boot 策略重试/推进。
- 每个会话同一时刻最多一个在途唤醒；模型端需遵守 framing 规则按需告知用户。
- 安静时段/预算的判定基于 UTC 日 + 配置时区，不随用户时区自动迁移（重启后读取最新配置）。
