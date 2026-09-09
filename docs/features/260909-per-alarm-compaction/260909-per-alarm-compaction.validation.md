# 260909-per-alarm-compaction 用户验证

## 验证说明

- 验证对象：no_reply reason 保留（run history + tombstone 可见）+ per-alarm compaction 三态化（off/minimal/aggressive，默认 minimal）
- 环境/前置条件：重启 dsh 服务使 host 侧改动生效（lib 硬链接已同步到 web profile；重启会中断当前会话，注意安排）。client bundle 已重编，刷新页面即加载新 client。

## 验证项

| 验证步骤 | 预期结果 | 实际结果 | 状态 | 备注/证据 |
|---|---|---|---|---|
| 1. minimal compaction 静默唤醒：设 `compaction: "minimal"`（默认）+ prompt 含"没事就 no_reply，reason 写明原因"的闹钟，短延迟触发 | 面板运行记录显示 noReplyReason；后续普通回合让模型复述 tombstone，模型能看到 `[dsh-proactive silent wake <id> <time> no_reply: <reason>]` | | 待验证 | 核心：reason 在模型 surface 可见 |
| 2. off compaction 静默唤醒：设 `compaction: "off"` 闹钟，静默触发 | 唤醒交换（framing + assistant + tool result）完整保留在模型上下文，无 tombstone 压缩；后续回合模型能复述唤醒报文 | | 待验证 | 验证 off 不压缩 |
| 3. aggressive compaction 静默唤醒：设 `compaction: "aggressive"` 闹钟，静默触发 | tombstone 只有 `[id time]`，无 reason；run history 仍记录 noReplyReason | | 待验证 | 回归当前行为 |
| 4. 面板编辑不丢 compaction：用 proactive_set 设 `compaction: "off"` 闹钟，在面板编辑改 prompt 后保存 | 闹钟 compaction 仍为 off，不被静默重置为 minimal | | 待验证 | P2 修复验证 |
| 5. reason 进 run history：任意静默唤醒后，面板运行历史查看 | 运行记录显示 noReplyReason 字段（若 UI 已展示）；runs.jsonl 含 noReplyReason | | 待验证 | 数据通路已单测覆盖；UI 展示待增强（P3-⑥） |

## 验证结论

待验证。

## 待跟进

- 面板 UI 暂不展示 compaction 级别与 noReplyReason（P3-⑥，与计划"可选增强"一致）；数据通路已打通，后续加 UI 标签只需改 sections.tsx + locales。
- 183/183 单测覆盖：reason 提取（正常/截断/缺省/malformed JSON）、三态 tombstone（minimal+reason / minimal 退化 / aggressive 无视 / off 退化）、compaction 默认/显式/非法值、schema gate 双向（接受合法值 + 拒绝缺字段）、createArgsFromForm compaction 透传（host 侧）。面板编辑 formFromAlarm（client .tsx）的 compaction 透传为 E2E 验证项 #4，不在单测套件中。
