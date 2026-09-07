# remove-push-coupling 代码审查

- 审查对象：PR 变更（未提交工作树 diff，仅限任务列出的范围内文件）
- 审查方法：逐文件 diff 审读 + 全包 grep 残留扫描 + `npm run check`（tsc --noEmit）+ `npm test`（tsc 编译 + node --test）复跑 + 关键路径（observer 决策闭环、store 加载容忍度、client 契约）源码精读
- 审查结论：**通过（无阻塞问题）**，附 1 处声明级偏差与 2 条部署/历史数据注意点

## 1. 删除彻底性：零残留

全包（src + test + README.md + AGENTS.md）大小写不敏感 grep `push_notify | send_wechat | DeliveryHint | deliveryHint | VISIBLE_TOOLS` **零命中**；`"push"` 决策字符串字面量在 src/ 中**零命中**（diff 前的 `RunDecision` push、observer 的 `decision = "push"`、`"no_reply raced a push tool"` note 均已消失）。

现有 `delivery*` 命中逐条归类（均为应保留项）：

| 位置 | 内容 | 判定 |
|---|---|---|
| `domain.ts:109,398` | `AlarmView.deliveryMode: "host"` + `toAlarmView` 注入 | ✅ 保留项（投递模式常量，非通道耦合） |
| `tools.ts:81` | proactive_list **输出** schema `deliveryMode: { const: "host" }` | ✅ 保留项；是 list 输出不是 set 输入，proactive_set 参数已无 delivery |
| `config.ts:3` / `store.ts:6,136` | "chat-text delivery" 措辞 | ✅ 语义已简化为可见聊天文本 |
| `client/host-api.ts:15` | `deliveryMode: string`（类型声明） | ✅ 保留项 |
| `test/domain.test.ts:139`、`test/tools.test.ts:125,136` | 夹具 `deliveryMode: "host"` | ✅ 保留项 |

client（panel.tsx / session-panel.tsx / sections.tsx）无任何 delivery 表单残留——创建/编辑表单从未收集通道勾选（旧逻辑是把默认 `{chat:true,push:false,wechat:false}` 在 `createArgsFromForm` 里服务端注入，本次已删）。`createArgsFromForm` 现仅产出 `{prompt,at/after_seconds/every_seconds/jitter,time_zone,wake_reason}`，与 `validateCreateArgs` 的 allowed keys（已删 delivery）严格互洽。

## 2. 无误删：deliveryMode / "host" 常量 / 预算机制

- `AlarmView.deliveryMode` 及 `const "host"` 全链路保留：domain 定义 → toAlarmView → tools list 输出 schema → client 宿主类型 → 测试夹具断言（`test/domain.test.ts:139`）。
- 预算系统机制完整：`config.ts maxDeliveriesPerDay`、`store.ts budgetFor/spendBudget`（含 state.json 持久化与原子写）、`scheduler.ts:232-233`（`analysis.budgetDelta > 0` 才 spendBudget）、`framing.ts` budget 曝光、`proactive_update_settings` 的 `max_deliveries_per_day` 参数——全部保留，仅措辞从"可见输出（聊天/push/微信）"改为"可见聊天文本"。
- 数据兼容：`store.ts alarmIsValid` 只校验 id/sessionId/nextDueAt，**旧 alarms.json 中带 `deliveryHint` 字段的闹钟照常加载显示**（多余字段被容忍），满足 validation.md 第 16 行验收项；旧 runs.jsonl 中 decision="push" 是历史字符串，GUI 以 pill 原样直显（`sections.tsx:273`），无映射表、不报错。

## 3. observer 决策闭环：正确且自洽

删除 push 分支后的判定覆盖所有输入组合（`observer.ts:142-154`）：

| 输入特征 | 决策 | 计费 |
|---|---|---|
| no_reply 且无文本 | `no_reply` | 0 |
| 有可见文本（含 no_reply 泄漏） | `reply`（泄漏时附 note） | 1 |
| 未正常结束 / error/aborted/max-tokens | `failed`（"ended abnormally"） | 0 |
| 干净结束但无输出且未 no_reply | `failed`（"produced no visible output without no_reply"） | 0 |

budgetDelta 仅 `reply` 计 1（`observer.ts:157`）——与简化语义"预算只统计可见聊天文本"精确一致。行为变化点：**push-only 回合（调工具、无文本）从"push/计 1"变为 `failed/计 0`**。这在闭环上是对的：proactive 不再承认 push 通道的可见性，无文本则无可见交付；且该分支在改前对非 push 工具本就是这个判定（"produced no visible output without no_reply"），删除只合并了 push 特例，未引入新路径。下游消费点（scheduler recordRun 直传、无任何 `decision==="push"` 字符串分支）同步干净。

## 4. 测试覆盖评估

- 实测：`npm run check` exit 0；`npm test` → **121 tests / 121 pass / 0 fail**（信息见 §5 第一点）。
- 删除的 1 个用例（"push tool costs one budget unit"）是唯一 push 特例测试，删除合理；其余覆盖矩阵完整：observed no_reply 深静默（含带 reasoning）、reply 计 1、泄漏 note、unsettled→failed、error/aborted/max-tokens 三种异常结尾→failed、干净结束无输出→failed+note、framing 锚定/进位切片隔离。
- 面板：`test/panel.test.ts:230` 新增 `!("delivery" in args)` 无泄漏断言，等效覆盖了原 delivery 断言；`createAction` 夹具同步去掉 delivery。
- 轻微缺口（低风险）：无"干净结束 + 调了非 no_reply 工具 + 无文本 → failed"的显式用例——该分支行为在本次变更前后对非 push 工具完全一致（未变语义），不构成回归风险，可留待自然覆盖。
- 计数复核：源码级 `test(` 全包 HEAD=119 → 现 118（observer HEAD=15→14，其余文件均不变），运行时 HEAD=122 → 现 121，差值恰为删除的 1 个用例。

## 5. 问题与注意点

1. **[低/声明偏差]** 任务 Context 中"node --test dist 122 用例全绿"是**改前基线**；本次变更删除 1 个 push 用例后实测为 **121/121 全绿**。属预期而非回归，但总结/提交信息建议用 121 表述，避免误读。
2. **[部署要求]** 面板与工具是同源 bundle：`contract.ts` 变更需重建 client bundle（`npm run build`）并重启 dsh 才在 web profile 生效——validation.md 验收项已覆盖，此处提醒与代码审查口径一致。
3. **[信息/运行期]** 旧客户端若仍传 `delivery`，会被 `validateCreateArgs` 的 allowed-keys 校验以 `invalid_trigger` 闭式拒绝——正是验收预期"不再被接受"，无需额外迁移逻辑。
4. **[信息/历史文档]** `docs/features/260829-dsh-proactive/`（research/plan/validation）与 `docs/issues/260906` 的 push 内容属历史设计记录，不在本次清理范围，保持一致性的方式是文档注明"已随 260907 移除"而非改写，可后续补一行指引。

## 6. 结论

变更与任务描述逐文件吻合：删除了 domain/alarm-factory/tools/observer/framing/config/panel-contract/store 中的全部 push 语义；保留项（deliveryMode、"host"、预算全机制）无一误删；observer 判定在删除后四态闭环正确且与预算简化语义自洽；测试与文档同步到位。**准予通过**。