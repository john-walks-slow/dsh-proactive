# 260910 跨会话闹钟工具（proactive_update + cancel 放宽）

## 背景

用户验收 260910 工作区目标时问："只要能拿到闹钟 id（通过 all 之类的），也支持用工具更新不是自己创建的闹钟吧"。核实结论：**不支持**——`proactive_list all=true` 能读到所有会话的闹钟 id，但 (1) 根本没有 update 工具（连自己创建的都改不了，只能取消重建或走 GUI）；(2) `proactive_cancel` 限定 owner。只有 GUI 设置页（host-wide 视图）能跨会话编辑/取消。

## 决策

- 工具 = 模型代用户行事 → 与 GUI 设置页同权：**按精确 id 跨会话 actuate**（list all=true 的描述本来就承诺了 "manage alarms owned by other sessions"，cancel 限 owner 是与该承诺的自相矛盾）。
- GUI 会话页 tab 保持 owner 域（上下文可见性），面板语义不变。

## 设计

1. **`proactive_update`**：`id` + 与 `proactive_set` **完全同一方言**（`ALARM_SPEC_PARAMETERS` 共享常量，杜绝方言漂移）。全量替换触发面字段；保留 `id/ownerSessionId/createdAt/runCount/lastRunAt`；paused 编辑后回 scheduled；in-flight/completed/cancelled/failed → `invalid_action`；unknown → `not_found`。与面板 edit 逐行同构（同一 validateCreateArgs + buildAlarm + identity merge）。
2. **时区默认链跟随 owner**：`wireTimeZones(args, services.sessionEvents(ownerSessionId))`——闹钟语义属于 owner，不属于恰好来编辑的会话（镜像面板 edit 的 `sessionEvents(current.ownerSessionId)`）。
3. **workspace 目的三层**：显式 id/path → 走 resolver（存在性检查，同 set）；**无显式参数且现闹钟已是 workspace → 沿用已解析的 workspaceId（不再检查——工作区消失时用户仍可改 prompt/重定向，不被编辑阻塞）**；非 workspace 闹钟切到 workspace 且无参数 → executor cwd 默认（同 set）。
4. **`proactive_cancel` 放宽**：去掉 owner 检查；unknown/completed/cancelled → `not_found`（"active" 语义不变）。
5. **AlarmView 补 `timeZone`**：list → update 往返无损（模型能精确重发方言，不丢 at/cron 对齐）。

## 权衡

- 全量替换 vs patch：选全量替换（one-dialect 原则；patch 会 fork 校验方言且触发器类型切换的 patch 组合语义复杂）。代价是模型须先 list 读当前 spec——工具描述已显式提醒 "a field you omit falls back to its dialect default, NOT to the old value"。
- 沿用 workspaceId 不重新存在性检查：编辑不应因目标工作区消失而失败（fire 时自有闭式 failed 兜底）；显式换目标仍走检查。
