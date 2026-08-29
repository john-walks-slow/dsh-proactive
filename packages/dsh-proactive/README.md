# dsh-proactive

让 DeepSeek Harness 的模型**主动跟进**：给自己定 host 级闹钟，即使会话已冷却也会按时被唤醒；唤醒回合可以选择 `proactive_no_reply` 静默收尾——用户完全无感知。

三个典型场景：

1. **习惯教练**：模型每天定时提醒/跟进用户习惯计划（`wake_reason: check_in`）。
2. **虚拟陪伴**：模型主动找用户聊天（`wake_reason: companion`），低频、预算受限。
3. **用户委托闹钟**：用户说"1 小时后提醒我"，模型用 `proactive_set` 给自己订闹钟（`wake_reason: alarm`），到点把用户唤醒；安静时段内用户委托提醒依然放行。

## 与 dsh-schedule 的区别

dsh-schedule 的提醒是**会话内**的：会话凉了就不会触发。dsh-proactive 把闹钟存在 **host 级**（`$DSH_HOME/proactive/`），到点用 `ctx.agents.resume()` 把冷会话唤起来执行一次，跑完即释放（进程内 handle dispose，持久化会话不受影响）。

## 安装

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
  "maxPromptLength": 4000
}
```

环境变量覆盖：`DSH_PROACTIVE_ENABLED`、`DSH_PROACTIVE_MAX_DELIVERIES_PER_DAY`、`DSH_PROACTIVE_DATA_DIR`、`DSH_PROACTIVE_TIME_ZONE`。

## 工具

| 工具 | 作用 |
|---|---|
| `proactive_set` | 建闹钟：`prompt` + 恰好一个 `at`（带显式时区的 RFC3339 或 {date,time,time_zone}）/ `after_seconds` / `every_seconds`(>=300)；可选 `time_zone`、`delivery`、`wake_reason` |
| `proactive_list` | 列出本会话活跃闹钟 |
| `proactive_cancel` | 按 id 取消 |
| `proactive_no_reply` | **唤醒回合专用**：静默收尾（`concludesTurn`），需单独调用且不产出文本 |

唤醒回合的 framing 报文包含三条回复规则（重要提醒必须说、冷会话且有时效走 push_notify/send_wechat、无需用户感知就 no_reply），并如实给出今日预算用量。

## 预算与安静时段

- **预算**：任何可见输出（聊天文本、push_notify、send_wechat）1 单位/次，按 UTC 日累计，上限 `maxDeliveriesPerDay`；`no_reply` 免费不计。预算用尽后，主动型唤醒（check_in/companion/interval）不再触发；用户委托的 alarm 仍会触发（用户显式要求优先，允许轻微超限）。
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
npm test         # 编译 + node:test（39 个单测）
```

## 已知限制（v1）

- 唤醒后进程内 handle 会 dispose；若服务在唤醒途中重启，在途闹钟标记为 in-flight，重启后按 boot 策略重试/推进。
- 每个会话同一时刻最多一个在途唤醒；模型端需遵守 framing 规则按需告知用户。
- 安静时段/预算的判定基于 UTC 日 + 配置时区，不随用户时区自动迁移（重启后读取最新配置）。
