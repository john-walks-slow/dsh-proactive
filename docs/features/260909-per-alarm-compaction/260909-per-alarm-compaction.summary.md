# 260909-per-alarm-compaction 总结

## 背景与问题

260908-wake-context-minimization 把静默唤醒从 ~2.6KB 压到 ~70B tombstone，但留下两个缺口：

1. **no_reply reason 丢失**：模型调用 `no_reply(reason)` 时，reason 作为 tool_use 参数写在 assistant/message 里。压缩把 assistant/message 擦成空 content eraser，reason 从模型 surface 消失；且 observer 只取了 tool name、没提取 args.reason，run history（runs.jsonl / 面板）也没有 reason。reason 对后续唤醒的决策连贯性有价值（让 Agent 知道"上一轮为什么静默了"）。

2. **压缩策略不可配、默认激进**：所有静默唤醒一律压成 70B tombstone。高频闹钟省 token 了，但低频/长记忆场景也被擦光，无法逐闹钟选择。

## 方案

### 1. no_reply reason 保留（两条路，正交）

- **run history 无条件保留**：`observer.analyzeWakeTurn` 扫 `tool/call` 时，`name === "no_reply"` 从 `data.arguments`（JSON 字符串）提取 reason，经 `truncateSummary` 截断（≤200），加 `noReplyReason` 字段到 `WakeAnalysis` → `scheduler.recordRun` → `RunRecord.noReplyReason` → `runs.jsonl` → 面板 `RunView`。不受压缩级别影响。
- **tombstone 按 compaction 级别可见**：`minimal` 级别的 tombstone 含 `no_reply: <reason>`，让模型后续回合能看到上一轮静默的原因。

### 2. per-alarm compaction 三态化

Alarm 新增 `compaction` 字段，三态：

| 值 | 行为 | tombstone | 模型 surface 残留 |
|---|---|---|---|
| `off` | 不压缩，保留完整唤醒交换 | — | ~2.6KB |
| `minimal`（默认） | 温和压缩 | `[... no_reply: <reason>]` | ~200-400B |
| `aggressive` | 激进压缩（原行为） | `[... id time]` | ~70-90B |

- **off 在驱动层短路**：`wake.ts` `if (alarm.compaction !== "off")` 才调 `compactWake`，off 不规划、不 append、不 log——比在 compaction 层空操作更优。
- **默认 minimal**：既省 token（擦除 assistant reasoning + tool result），又让模型保留 reason，不至于失忆。高频闹钟可显式 `aggressive`，低频长记忆可显式 `off`。
- **reason 缺省退化**：minimal 但无 reason → 退化成 aggressive 文本（只有 id+time）。
- **可选字段 + 读时默认**：`Alarm.compaction` 可选（`compaction?: AlarmCompaction`），缺 = `DEFAULT_COMPACTION("minimal")`。老 v1/v2 记录缺字段时 `alarmIsValid` 宽容通过，消费侧 `?? DEFAULT_COMPACTION`。STORE_VERSION 不 bump，无迁移代码。

### 数据通路

```
tool/call arguments(JSON) 
  → observer extractNoReplyReason → WakeAnalysis.noReplyReason
  → wake fire → compactWake(compaction, reason) → tombstoneText（模型 surface）
  → scheduler recordRun → RunRecord.noReplyReason → runs.jsonl → panel RunView → wire DTO
```

## 效果

| 指标 | 改动前 | 改动后（默认 minimal） |
|---|---|---|
| 静默唤醒 tombstone | ~70B（无 reason） | ~70B + reason 长度（含 reason） |
| run history noReplyReason | 无 | 有（无条件） |
| 压缩策略 | 全部激进 | per-alarm 可配，默认温和 |
| off 模式 | 不存在 | 完整保留唤醒交换 |

## 验证

- 单测 183/183：reason 提取（正常/截断/缺省/malformed JSON）、三态 tombstone（minimal+reason / minimal 退化 / aggressive 无视 / off 退化）、compaction 默认/显式/非法值、schema gate 双向、createArgsFromForm compaction 透传。tsc 0 错。
- reviewer 子代理：可合入（P0/P1=0，P2 面板编辑丢 compaction 已修复，P3 七项为设计选择/可选增强）。
- 实机验收：见同目录 validation.md（5 项：minimal/off/aggressive 三态 + 面板编辑不丢 compaction + run history reason）。

## 部署注意

- host 侧改动（observer/compact/wake/scheduler/alarm-factory/domain/store）需**重启 dsh** 生效（会中断当前会话）。
- client 侧改动（sections.tsx AlarmRow + formFromAlarm）已重编进 client bundle，刷新页面即加载。
- 老 alarms.json 缺 compaction → 自动用默认 minimal，下次 persist 不写回该字段（可选字段），消费侧 `?? DEFAULT_COMPACTION`。无感升级。
