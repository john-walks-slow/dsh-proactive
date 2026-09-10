# 260910-proactive-workspace-target 计划

## 语义

`proactive_set` / 面板新增第 4 种目标模式 `workspace`。fire 时解析投递点：

1. 工作区内候选 = `workspace.sessionIds` − 归档 − `origin==='subagent'`；
2. 可见候选（非 blank）中取 `updatedAt = max(createdAt, lastPromptAt)` 最大者 → **resume 该会话**（live 复用 / 冷 resume，同现有 resume 模式）；
3. 无可见候选但有 blank → 复用**最新** blank（GUI New Session 槽，`connectWorkspace` 同款规则）；
4. 无任何候选 → `agents.create`（`meta.cwd = workspace.path`，装 model selection）→ `attachSession` → 唤醒（真实会话，留在侧边栏该工作区下）。

workspace 删除（registry get miss）/ 目录缺失（仅 create 路径查 `status()`）→ 唤醒 failed（带明确 message，走既有重试/failed 状态机）。

## 目标命名（create 侧）

共享方言（tools + panel）：`target_mode: "workspace"` + `target_workspace_id`（面板下拉/模型可见 id）。模型额外可省略（默认= 当前会话 cwd 所属工作区）或传 `target_workspace_path`（绝对路径，realpath 解析）。host 侧异步接线（类比 wireTimeZones）在 `validateCreateArgs` **之前**把 path/默认归一成 canonical `target_workspace_id` 并验证存在；闭式校验只认 `target_workspace_id`（path 形态在闭式层是未知键=未接线的编程错误）。无 auto-create 工作区。

## 逐文件改动

- **domain.ts**：`AlarmTarget` += `{ mode: "workspace"; workspaceId: string }`；`TargetMode` += "workspace"；`isValidWorkspaceId`（uuid 形状，≤100）；`AlarmView` += `targetWorkspaceId?`；`toAlarmView` 映射。
- **workspace.ts（新）**：
  - 纯函数：`listMetadataOf(events) → {blank, lastPromptAt}`（镜像 apiproxy 折叠：turn/start 翻 blank、`user/message`+`source.kind==="user"` 记 lastPromptAt）；`updatedAtOf(createdAt, meta)`；`pickWorkspaceTarget(candidates) → {kind:"session", sessionId} | {kind:"create"}`（可见优先、updatedAt/createdAt/id 三键确定性比较、blank 复用）。
  - `WorkspaceWakePort`（fire 时端口）：`resolveTarget(workspaceId)` / `attach(workspaceId, sessionId)`。
  - `resolveWorkspaceArg(args, deps, sessionCwd?) → args | ToolError`：path/默认/显式 id → 验证存在的 canonical id。
  - `createWorkspaceWakePort(deps)`：registry + ctx.sessions + sessionPersistence + sessionProjectionCache 的 host 装配（全部可选探测，缺失 → 明确 error）。
- **store.ts**：`TARGET_MODES` += workspace；`alarmIsValid` 校验 workspaceId 形状。
- **alarm-factory.ts**：allowed 集合 += `target_workspace_id`；target_mode 枚举 += workspace；workspace 模式要求 id、禁 `target_session_id`。
- **wake.ts**：deps += `workspaces?: WorkspaceWakePort`；fire() 提取 resume 驱动私有方法供 resume/workspace-session 复用；workspace 分支：resolveTarget → session（复用 resume 路径）/ create（`agents.create` + `attach` + 驱动）。
- **tools.ts**：proactive_set 参数与描述更新（target_mode 枚举 + 两个 workspace 参数）；ALARM_VIEW_SCHEMA targetMode 枚举 + targetWorkspaceId；execute 接 `resolveWorkspaceArg`（services 新 dep）。
- **panel/contract.ts**：PanelCreateForm += `targetMode:"workspace"` + `targetWorkspaceId?`；`createArgsFromForm` 映射。
- **panel/service.ts**：deps += workspace 解析器；create/edit 路径接线（面板恒传显式 id，无 cwd 默认臂）。
- **index.ts**：装配 host deps → WakeDriver.workspaces、tools services、panel service；registry 缺失时全部降级为明确错误路径。
- **client/host-api.ts**：`fetchWorkspaceList()`（/api/workspace.list 同信封）；AlarmRowDto += workspace 字段；stateForHost/actionForHost 三拉取 + `targetWorkspaceTitle` enrichment。
- **client/sections.tsx**：AlarmRow += workspace 字段；targetLabel/workspace 下拉/提示；AlarmTable 目标格显示工作区名；formFromAlarm/newAlarmForm/提交守卫。
- **client/panel.tsx / session-panel.tsx**：knownWorkspaces 状态、defaultWorkspaceId（当前会话所属工作区）、传参。
- **client/locales.ts**：新 key（targetWorkspace/targetWorkspaceLabel/workspaceHint/noWorkspaces 等，zh+en）。

## 测试

- **workspace.test（新）**：折叠/updatedAt/选取纯函数矩阵（含 subagent 排除、blank 复用、确定性平局）；resolveWorkspaceArg（默认 cwd、path、显式 id、不存在→not_found）；resolveWorkspaceWakeTarget（live/cold cache/缺源跳过/归档排除）。
- **wake.test**：workspace 模式——命中会话走 resume 路径、create 路径（create 参数含 meta.cwd、attach 顺序在驱动前）、port 缺失→failed、port error→failed。
- **domain/store/tools/panel.test**：闭式校验矩阵、存储往返、工具/面板接线错误路径。
- **E2E（隔离实例）**：workspace.create → 面板 API 建 workspace 闹钟（after_seconds）→ 新建会话落点（cwd/attach/非 blank）→ 二次 fire 收敛同一会话 → 新真人 prompt 后切换目标 → 模型工具默认臂（会话内 proactive_set 无显式选择器）。

## 不做

- 不 auto-create 工作区；不 mkdir 唤醒目录；不做 fork×workspace 组合；不改 observer/compact（workspace 唤醒回合就是普通唤醒回合）。
