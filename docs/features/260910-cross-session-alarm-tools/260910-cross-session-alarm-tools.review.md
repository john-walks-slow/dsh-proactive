# 检视报告

## 概要

检视 dsh-proactive 跨会话闹钟工具交付（`proactive_update` 新工具、`proactive_cancel` 放宽、`AlarmView.timeZone`、`ToolServices.sessionEvents` 装配及配套测试/文档）。整体质量高：update 与面板 edit 逐行同构（同一 `validateCreateArgs`/`buildAlarm`/identity merge/persist 回滚），`ALARM_SPEC_PARAMETERS` 共享常量从结构上杜绝方言漂移，状态守卫与错误码闭式清晰，E2E 覆盖了用户原始场景（含 workspace 目的地跟随最新活动）。

## 需求对齐

完全满足。用户问题"拿到 id 后能否更新不是自己创建的闹钟"从"不能"变为"能"：

- plan.md 五项设计全部落实，无偏离、无过度设计：update 全量替换方言、时区链跟随 owner（`wireTimeZones(spec, services.sessionEvents?.(current.ownerSessionId))`，tools.ts:323）、workspace 三层（tools.ts:324-338，与设计逐条对应）、cancel 去 owner 检查、`AlarmView.timeZone` 往返。
- cancel 放宽同时修正了 `proactive_list all=true` 描述"manage alarms owned by other sessions"与限 owner 的自相矛盾，动机成立。
- GUI 会话页 tab 的 owner 域未被波及（`guardOwnership` 未动，panel/service.ts:103-110）；面板 edit 的 `invalid_action` 守卫与工具 update 的划分一致（存在 → `invalid_action`，不存在 → `not_found`）。
- 次生风险核查：cancel 的 owner 检查无其他消费方依赖；`invalid_action` 加入 `ProactiveErrorCode` 后无穷举 switch 消费点（唯一消费者是 contract 的 union，见 S3）；client 错误按通用文案渲染、快照行为加性消费，`timeZone` 字段与新增错误码对 client 均安全。
- 文档三件套（plan/validation/summary）齐备，validation 记录了隔离 host 上的真实模型回合全链路。

## 阻塞问题

无。

## 建议修改

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| S1 | `packages/dsh-proactive/src/tools.ts:300-303` | update 覆盖了 `target_session_id`、`target_workspace_id` 的描述，但 `target_workspace_path` 沿用 set 的共享文案"…or omit both to use this session's own workspace"，与 `target_workspace_id` 覆盖文案"omit both to keep the alarm's current workspace"在同一参数集内自相矛盾。模型读 path 描述会推断"省略=编辑会话自己的工作区"，而对 workspace 闹钟实际语义是沿用原 workspace——模型可见的方言指引不准确。 | 在 update 的 parameters 里同步覆盖 `target_workspace_path` 描述，说明"省略时 workspace 闹钟沿用当前 workspace、非 workspace 闹钟回退编辑会话 cwd 默认"，与 `target_workspace_id` 的覆盖文案对齐。 |
| S2 | `packages/dsh-proactive/src/alarm-factory.ts:73,76` | `validateCreateArgs` 错误消息硬编码"proactive_set accepts only…"、"proactive_set requires exactly one of…"，经 `proactive_update`（及面板 edit）返回时文案仍指向 proactive_set，模型在 update 语境下收到引用另一工具的错误提示。 | 改为工具中立措辞（如 "the alarm spec accepts only…" / "the alarm spec requires exactly one of…"），一处改动同时修正 update 与面板两个消费面。 |
| S3 | `packages/dsh-proactive/src/panel/contract.ts:80` | `ProactiveErrorCode` 已并入 `"invalid_action"`，`PanelErrorCode = ProactiveErrorCode \| "invalid_action" \| …` 中该项成为冗余重复（类型无害但属漂移残留）。 | 从 `PanelErrorCode` 删除重复的 `"invalid_action"` 项。 |
| S4 | `docs/features/260910-cross-session-alarm-tools/260910-cross-session-alarm-tools.summary.md:15` | "233/233 单测（+8 新增/改写）"与实际不符：tools.test.ts 由 25 个 test 块增至 29（+4 新增、1 改写 = 5 处），Changes 描述亦称"新增 5 个用例"。 | 更正为"+4 新增 / 1 改写"（或统一口径），保持验证记录可复核。 |

## 非阻塞问题

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| N1 | `packages/dsh-proactive/src/tools.ts:450` | `registerProactiveTools` 的 JSDoc 仍写"Register the five tools"，实际为六个（文件头注释与 `proactiveToolDefinitions` 的"six"已更新）。 | 顺手改为 six。 |
| N2 | `packages/dsh-proactive/src/tools.ts:149-153` 与 `src/index.ts:72-78` | 两个近似重复的 `sessionEventsOf`（agent 绑定 vs ctx 绑定）。行为等价（index 已总是注入 `services.sessionEvents`），存在将来单边漂移的余地。 | 后续迭代可让 set 也走 `services.sessionEvents?.(agent.session.id)`，收敛为一条链路；本轮不必动。 |
| N3 | `packages/dsh-proactive/src/tools.ts:308-361` | update 的状态守卫（getAlarm 时非 in-flight）与 `replaceAlarm` 之间存在 await（`resolveWorkspace`）窗口，理论上 scheduler 可在此间置 in-flight 后被覆盖回 scheduled。与面板 edit 完全同构（`wireWorkspace` 同位置 await），属已接受的既有模式，窗口极窄。 | 备忘记录即可；若未来引入跨变更串行化（如 store 级写队列）可一并消除。 |
| N4 | `packages/dsh-proactive/src/tools.ts:286`（范围外备忘） | cancel 持久化失败回滚用 `addAlarm`（追加到数组末尾，丢失创建序；面板 cancel 同），而 update 回滚用 `replaceAlarm` 保位。pre-existing，非本次引入。 | 若将来整理 list"in creation order"语义时一并处理。 |

## 准入结论

**结论**：`条件准入`

**说明**：无阻塞问题——实现与面板 edit 同构、方言共享、守卫/回滚/测试齐备，E2E 验证了原始诉求全链路。S1/S2 为模型可见的方言描述准确性问题，一行文案修改、零逻辑风险，建议合并前顺手处理；S3/S4 可随后跟进。

## 修复轮（260910）

全部建议项已处理：S1（update 覆盖 target_workspace_path 描述，与 target_workspace_id 覆盖文案一致）、S2（alarm-factory 错误文案改为工具中立的 "the alarm spec …"，一处修正 update + 面板 edit 两个消费面）、S3（PanelErrorCode 去掉并入 ProactiveErrorCode 后冗余的 "invalid_action"）、S4（summary 计数口径更正 +4 新增/1 改写）、N1（JSDoc five→six）。N2/N3/N4 备忘不改（review 已注明本轮不动）。修复后 233/233 单测 + 重新 build 通过。
