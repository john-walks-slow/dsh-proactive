# Proactive Target Refactor & Functional Evolution Plan

## 1. 目标与愿景

为 `dsh-proactive` 重构闹钟会话目标（Alarm Target）体系，并实现完整的功能演进：
1. **三态核心目标类型（Target Mode）**：
   - `new`（新建）：每次触发时创建全新的会话并唤醒。
   - `resume`（复用）：触发时唤醒已有会话。
   - `fork`（分支）：触发时从源会话的历史中派生子会话并唤醒。
2. **`new`（新建）高级配置演进**：
   - 可选关联工作区（`target_workspace_id` / `target_workspace_path`），自动设置 cwd 并 attach。
   - 可选指定智能体预设（`target_preset_id`），新建会话以指定 preset 组装。
   - 可选指定模型（`target_provider` / `target_model`），新建会话以指定模型驱动。
3. **`resume`（复用）与 `fork`（分支）的源会话解析策略演进**：
   - `session`（指定会话 ID）：固定指定的 `target_session_id`。
   - `workspace`（工作区最近活跃）：指定 `target_workspace_id`，触发时动态查找该工作区内最近活跃的会话。
   - `preset`（Preset 最近活跃）：指定 `target_preset_id`，触发时动态查找使用该 preset 的最近活跃会话。
4. **全链路端到端覆盖**：
   - 领域层（`domain.ts`, `alarm-factory.ts`）
   - 调度与执行层（`wake.ts`, `workspace.ts`, `target-resolver.ts`）
   - 工具层（`tools.ts`）
   - 协议与面板服务层（`panel/contract.ts`, `panel/service.ts`, `panel/routes.ts`）
   - 前端组件与交互层（`client/sections.tsx`, `client/panel.tsx`, `client/locales.ts`）
   - 完整单元测试与端到端模拟测试。

---

## 2. 详细架构设计

### 2.1 领域模型变更 (`src/domain.ts`)

```ts
export type TargetMode = "resume" | "fork" | "new";
export type TargetSourceType = "session" | "workspace" | "preset";

export type AlarmTarget =
  | {
      mode: "resume" | "fork";
      sourceType: TargetSourceType;
      sessionId?: string;     // 当 sourceType === "session"
      workspaceId?: string;   // 当 sourceType === "workspace"
      presetId?: string;      // 当 sourceType === "preset"
    }
  | {
      mode: "new";
      workspaceId?: string;
      presetId?: string;
      provider?: string;
      model?: string;
    };
```

#### 兼容性规范：
- 兼容旧版本 `TargetMode`：若存盘或外部传入 `target_mode: "workspace"`，自动规整为 `{ mode: "resume", sourceType: "workspace", workspaceId }`。
- 若 `mode === "resume" || mode === "fork"` 且未显式提供 `sourceType`：
  - 若提供了 `workspaceId`，则 `sourceType = "workspace"`；
  - 若提供了 `presetId`，则 `sourceType = "preset"`；
  - 否则 `sourceType = "session"`。

### 2.2 视图模型变更 (`AlarmView`)
在 `toAlarmView` 中输出：
- `targetMode`: `"resume" | "fork" | "new"`
- `targetSource`?: `"session" | "workspace" | "preset"`
- `targetSessionId`?: string
- `targetWorkspaceId`?: string
- `targetPresetId`?: string
- `targetProvider`?: string
- `targetModel`?: string

### 2.3 会话解析引擎设计 (`src/workspace.ts` -> 增强并支持 Preset 解析)
现有的 `pickWorkspaceTarget` 已经实现了高精度的最近活跃排序：
`updatedAtOf = Math.max(createdAt, lastPromptAt ?? 0)`
排除 `subagent`，优先选择非 `blank` 会话，其次选择最新 `blank` 会话，最后返回 `{ kind: "create" }`。

我们将其泛化为通用的会话选择机制：
1. **工作区解析**：保持原机制。
2. **Preset 解析 (`resolvePresetWakeTarget`)**：
   - 传入 `presetId`。
   - 收集候选会话：
     - Live 会话：检查 `header.agentPreset === presetId` 或最新 `agent-preset/selected`。
     - Cold 会话：检查 `header.agentPreset === presetId`。
   - 排除 subagent，按 `updatedAt` 降序 -> `createdAt` 降序 -> `sessionId` 排序。
   - 优先非 blank 会话，次选 blank 会话。
   - 若有匹配会话，返回 `{ kind: "session", sessionId }`。
   - 若无任何匹配会话，返回 `{ kind: "create", presetId }`。

### 2.4 唤醒执行器设计 (`src/wake.ts`)
重构 `fire(alarm)` 的派发逻辑：
- 若 `alarm.target.mode === "new"`：
  - 获取 `cwd`（若指定了 `workspaceId`，则通过 workspaces 端口获取其路径）。
  - 创建新会话：`agents.create` 时传入：
    - `meta: { ...(cwd ? { cwd } : {}), ...(presetId ? { agentPreset: presetId } : this.defaultPresetMeta()) }`
    - `agentOptions: this.agentOptions(alarm.target.provider, alarm.target.model)`
  - 若指定了 `workspaceId`，在驱动前调用 `port.attach(workspaceId, actualSessionId)`。
  - 派发唤醒。
- 若 `alarm.target.mode === "resume"`：
  - 根据 `alarm.target.sourceType` 解析目标会话 ID：
    - `"session"`：使用 `alarm.target.sessionId`。
    - `"workspace"`：通过 `workspaces.resolveTarget(alarm.target.workspaceId)` 解析，若返回 create 则新建并 attach。
    - `"preset"`：通过 `presets.resolveTarget(alarm.target.presetId)` 解析，若返回 create 则以该 preset 新建会话。
  - 获取 agent 并驱动唤醒。
- 若 `alarm.target.mode === "fork"`：
  - 根据 `alarm.target.sourceType` 解析源会话 ID（同上逻辑，若解析出需要新建或找不到会话，则返回明确失败）。
  - 读取源会话日志，计算 `completedTurnCut`。若无已完成回合，返回失败并附带清晰原因。
  - 基于截断历史创建 fork 子会话并唤醒。

### 2.5 校验与工厂设计 (`src/alarm-factory.ts`)
更新 `validateCreateArgs`：
- 允许的参数集合增加：
  `target_source`, `target_preset_id`, `target_provider`, `target_model`。
- 根据 `target_mode` 和 `target_source` 进行严格交叉校验：
  - `mode === "new"`：不允许传 `target_session_id`；允许传 `target_workspace_id`, `target_preset_id`, `target_provider`, `target_model`。
  - `mode === "resume" | "fork"`：不允许传 `target_provider`, `target_model`。
    - `source === "session"`：校验 `target_session_id`（默认回退到调用方当前会话）。
    - `source === "workspace"`：要求合法 `target_workspace_id`，不允许传 `target_session_id` 或 `target_preset_id`。
    - `source === "preset"`：要求合法 `target_preset_id`，不允许传 `target_session_id` 或 `target_workspace_id`。

### 2.6 工具设计 (`src/tools.ts`)
- 更新 `ALARM_SPEC_PARAMETERS` 的 Schema 与 Description。
- 更新 `ALARM_VIEW_SCHEMA`。
- 更新 `proactive_set`, `proactive_update`。

### 2.7 前端与协议设计 (`src/panel/`, `src/client/`)
- `PanelCreateForm` 增加新字段：`targetSource`, `targetPresetId`, `targetProvider`, `targetModel`。
- `createArgsFromForm` 转换映射逻辑对齐。
- `sections.tsx`：
  - 目标模式分为：新建会话、复用会话、分支会话。
  - 针对新建会话：展示工作区下拉（可选）、Preset 下拉（可选）、Model 输入（可选）。
  - 针对复用与分支会话：展示来源类型单选（指定会话 / 工作区最近活跃 / Preset 最近活跃），并展开对应控件。
  - 客户端获取系统 presets 列表（通过 `agentPresets/list` RPC 或 Context），供用户在下拉菜单中直接选择！
  - 列表页面渲染针对不同模式展示清晰的徽标和描述。
- `locales.ts`：增加所有中英文文案。

---

## 3. 实施步骤（Implementation Steps）

1. **Step 1: 领域模型与校验重构**
   - 修改 `src/domain.ts`：定义新 `AlarmTarget`, `TargetMode`, `TargetSourceType`，更新 `toAlarmView`，实现向后兼容映射。
   - 修改 `src/alarm-factory.ts`：更新参数列表、交叉校验和创建逻辑。
   - 跑领域层单测并扩充测试。

2. **Step 2: 目标解析与调度执行升级**
   - 扩展 `src/workspace.ts`：支持通用活跃会话搜索，新增 Preset 候选会话解析接口。
   - 修改 `src/wake.ts`：重构 `fire()` 针对 `new`, `resume`, `fork` 的三路派发，支持 `preset` 动态解析、`new` 自定义 workspace/preset/model。
   - 编写 `wake.test.ts` 和 `workspace.test.ts` 新场景测试。

3. **Step 3: Tools 接口与跨会话操作同步**
   - 修改 `src/tools.ts`：参数定义和输出 Schema 增强。
   - 编写 `tools.test.ts` 针对新参数组合的测试。

4. **Step 4: 面板服务与客户端 UI 演进**
   - 修改 `src/panel/contract.ts`：更新 `PanelCreateForm` 与 `createArgsFromForm`。
   - 修改 `src/panel/service.ts`：更新快照字段和参数处理。
   - 修改 `src/client/sections.tsx`：重构目标选择表单与列表展示。
   - 修改 `src/client/locales.ts`：完备的 zh/en 本地化文案。
   - 编写 `panel.test.ts` 测试。

5. **Step 5: 整体回归测试与构建验证**
   - `npm run check`, `npm run build`, `npm test` 全面通过。
   - 编写文档总结与验证说明。

---

## 4. 验证策略

- 纯函数与逻辑单元测试：覆盖所有模式的校验、创建、触发时解析、失败退回与边界条件。
- 面板契约测试：验证表单输入转 API 参数、再转回表单回显的双向无损往返。
- 保证全部既有 235 个测试用例向前兼容，新增测试用例覆盖全部新分支。
