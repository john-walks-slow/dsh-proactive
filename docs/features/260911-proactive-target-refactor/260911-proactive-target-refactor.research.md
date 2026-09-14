# Proactive Target Refactor & Functional Evolution Research

## 1. 背景与意图

deep-auto 目标驱动：
重构 DeepSeek Harness 主动闹钟（dsh-proactive）的目标体系（Alarm Target），并完成功能演进：
1. **目标类型正交化**：从旧的 `"resume" | "fork" | "new" | "workspace"` 四态混乱模型，清晰解耦重构为三大核心意图：
   - **新建（`new`）**：每次触发时创建一个全新会话并唤醒。
   - **复用（`resume`）**：触发时唤醒已有会话（在同一个会话中继续对话）。
   - **分支（`fork`）**：触发时从某个源会话的历史中 fork 出新会话并唤醒。
2. **新建（`new`）功能增强**：
   - 支持（可选）指定工作区（`workspaceId`），若指定则新建的会话属于该工作区并与其关联。
   - 支持（可选）指定智能体预设（`presetId`），若指定则新建会话以该 preset 组装，否则使用默认 preset。
   - 支持（可选）指定模型（`provider` / `model`），若指定则新建会话以该模型驱动，否则使用默认模型配置。
3. **复用（`resume`）与分支（`fork`）的源会话解析策略增强**：
   - **指定会话 ID（`session`）**：直接指定固定会话 ID（如当前会话或某个已知会话）。
   - **工作区最近活跃（`workspace`）**：指定工作区，每次触发时动态解析该工作区中最近活跃的会话作为目标。
   - **Preset 最近活跃（`preset`）**：指定智能体预设，每次触发时动态解析使用该预设的最近活跃会话作为目标。

---

## 2. 既有实现分析

### 2.1 现存领域模型 (`src/domain.ts`)
```ts
export type TargetMode = "resume" | "fork" | "new" | "workspace";

export type AlarmTarget =
  | { mode: "resume"; sessionId: string }
  | { mode: "fork"; sessionId: string }
  | { mode: "new" }
  | { mode: "workspace"; workspaceId: string };
```
- 问题分析：
  - `workspace` 既不是像 `resume` 属于原地复用，也不纯粹是新建，而是“工作区里找最近活跃的 resume，找不到才新建”。
  - 它将“动作类型”（新建 vs 复用）与“会话解析源”（工作区 vs 单会话）混在了一个枚举里，导致无法表达“在某个工作区每次新建会话”、“fork 某个工作区最近活跃会话”、“复用某个 Preset 最近活跃会话”等合理场景。

### 2.2 触发时唤醒逻辑 (`src/wake.ts`)
- `target.mode === "workspace"`：
  - 调用 `workspaces.resolveTarget(workspaceId)`：
    - 返回 `{ kind: "session", sessionId }` -> 走 `acquireForResume`
    - 返回 `{ kind: "create", cwd }` -> 走 `agents.create` + `attachSession`
- `target.mode === "resume"`：
  - 走 `acquireForResume(sessionId)`
- `target.mode === "fork"`：
  - 读取父会话日志 `parentLog(sessionId)`，计算断点 `completedTurnCut`，通过 `agents.create({ seed, meta, ... })` 创建子会话。
- `target.mode === "new"`：
  - 走 `agents.create({ meta: this.defaultPresetMeta(), ... })`，没有 cwd、没有可选 preset/model。

### 2.3 候选会话排序算法 (`src/workspace.ts`)
- `updatedAtOf`: `max(createdAt, lastPromptAt)`
- `pickWorkspaceTarget`:
  - 过滤 `subagent`（从不入选）。
  - 优先选择非 `blank`（已有用户交互）的会话，按 `updatedAt` 降序 -> `createdAt` 降序 -> `sessionId` 字典序。
  - 若无非 `blank` 会话，选择最新的 `blank` 会话（New Session 槽位）。
  - 若无任何候选会话，返回 `{ kind: "create" }`。

---

## 3. 架构方案与技术细节

### 3.1 统一领域模型 (Domain Model)
将目标分为两部分：
1. **`mode`**: `"new" | "resume" | "fork"`
2. **对于 `resume` 和 `fork`**：引入 `sourceType: "session" | "workspace" | "preset"`
   - `session`: `sessionId: string`
   - `workspace`: `workspaceId: string`
   - `preset`: `presetId: string`
3. **对于 `new`**：
   - `workspaceId?: string`
   - `presetId?: string`
   - `provider?: string`
   - `model?: string`

### 3.2 兼容性设计（向前与向后兼容）
存盘数据兼容：
- 旧 `{ mode: "resume", sessionId }` -> 视为 `sourceType: "session"`
- 旧 `{ mode: "fork", sessionId }` -> 视为 `sourceType: "session"`
- 旧 `{ mode: "new" }` -> 视为纯新建
- 旧 `{ mode: "workspace", workspaceId }` -> 自动映射为 `{ mode: "resume", sourceType: "workspace", workspaceId }`
这样旧 `alarms.json` 文件在加载或迁移时 100% 无缝兼容，没有任何断层或数据损坏。

### 3.3 最近活跃会话解析器抽象 (`src/workspace.ts` 进化为会话解析引擎)
对于 `preset` 最近活跃查找：
- 扫描 live 会话和 cold 会话。
- 会话的 preset 来源：
  1. Header 中的 `agentPreset`（LiveSession / SessionHeader 均携带）。
  2. 事件日志中最新的 `agent-preset/selected`（若有）。
- 排序与筛选规则完全对齐工作区模式：
  - 排除 `subagent`。
  - 计算 `updatedAt = max(createdAt, lastPromptAt)`。
  - 优先非 blank 会话，次选 blank 会话。
  - 对于 `resume`：若完全无匹配会话，则返回 `{ kind: "create", presetId }`，唤醒系统自动新建该 preset 的会话并 resume！
  - 对于 `fork`：若无匹配会话，返回明确错误；若有会话但无已完成轮次，提示该会话尚无已完成轮次。

### 3.4 工具接口 (`src/tools.ts`) 与 参数校验 (`src/alarm-factory.ts`)
- `proactive_set` / `proactive_update` 支持参数：
  - `target_mode`: `"resume" | "fork" | "new"`（接受 `"workspace"` 作为兼容别名）
  - `target_source`: `"session" | "workspace" | "preset"`
  - `target_session_id`: 会话 ID（当 source 为 session 时）
  - `target_workspace_id` / `target_workspace_path`: 工作区 ID 或路径（当 source 为 workspace，或 mode 为 new 时）
  - `target_preset_id`: 预设 ID（当 source 为 preset，或 mode 为 new 时）
  - `target_provider`: 模型提供商（当 mode 为 new 时）
  - `target_model`: 模型名称（当 mode 为 new 时）
- `AlarmView` 统一返回上述视图字段，在客户端列表与详情无损显示。

### 3.5 前端交互 (`src/client/`)
- 客户端同时获取 `knownWorkspaces` 和 `knownPresets`（通过 `ctx.get("agentPresets")` 或 RPC `agentPresets/list`）。
- 目标表单：
  - 模式下拉：新建 / 复用 / 分支。
  - 若选新建：展示工作区（可选下拉）、Preset（可选下拉）、Model（可选输入）。
  - 若选复用/分支：展示来源单选（指定会话 / 工作区最近活跃 / Preset 最近活跃），并展开对应控件。
  - 表单回显与编辑完全同步，国际化（zh/en）全面覆盖。

---

## 4. 结论与实施路径
该设计完全满足用户需求，概念清晰正交，扩展性强，且与现存实现高度兼容。
接下来输出详细实施计划并在实施阶段全面落实。
