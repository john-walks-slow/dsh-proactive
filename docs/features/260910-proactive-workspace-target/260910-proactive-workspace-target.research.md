# 260910-proactive-workspace-target 调研

需求：proactive 新增目标类型 **workspace（工作区）**——唤醒消息投递到该工作区"最近更新的会话"；若无会话则新建会话。

## 平台侧事实（以全局 dsh 安装的 .d.ts/实现为准）

### 工作区注册表：`ctx.workspaceRegistry`（@deepseek-ai/dsh-workspace）

- `Workspace`：`id`（uuid，稳定）、`path`（create 时 realpath 规范化，之后不改）、`title`、`createdAt/updatedAt`、`sessionIds`（**手动顺序**：attach 前插、insertSessionBefore 重排、**活动不重排**）。
- `sessionIds` 是"header 校验过"的会话账户：成员要求 id 在账户内 **且** 该会话 header 的 canonical cwd == workspace.path。缺 header、cwd 无效、cwd 不匹配的候选被同步过滤（后续 mutation 持久剪枝）。
- `registry.get(id)` / `registry.list()`（注册顺序）/ `resolveByPath(path)`（realpath 后匹配，不创建）/ `create(path, title?)`（存在性目录才可建，幂等）/ `archivedSessionIds`（注册表全局归档集，归档会话从所有分组表面隐藏但保留账户槽位）。
- `workspace.attachSession(sessionId)`：新 id 要求 live 或持久化 header 的 canonical cwd 等于 workspace.path，否则拒绝不写入。
- `workspace.status()`：`'ok' | 'missing-dir'`（实时 fs 检查；目录消失不改记录）。
- dsh-web-app 依赖 dsh-workspace 与 dsh-session-projection-cache → web profile 运行时两个服务都在（生产 profile 与 E2E profile 均成立，无需给插件加依赖；`ctx.get(name, false)` 可选探测即可）。

### 会话"最近更新"的权威定义（GUI 侧边栏的排序依据）

host `session.list` 的 `SessionSummary.updatedAt` = **max(header.createdAt, lastPromptAt)**，其中 `lastPromptAt` = 日志里最后一条 `user/message` 且 `data.source.kind === "user"` 的事件时间（dsh-host-apiproxy index.js `sessionListUpdatedAt` / `applySessionListMetadata`）。**wake framing 是 `source.kind: "plugin"` 的 notice → 唤醒本身不推动 updatedAt**（自激收敛无环）。

冷会话的 `{blank, lastPromptAt}` 来自持久化投影缓存 `ctx.sessionProjectionCache.cachedSnapshot(meta).values.sessionListMetadata`（断点前缀事实，"possibly stale but never wrong"；live 会话直接折内存 events）。attached 会话走 `ctx.get("sessionProjections")?.snapshot(session)`，冷会话走 cache——apiproxy `listProjectionsFor` 同款双路径。

`blank` = 日志中从未出现 `turn/start`（独立插件事件不算）。GUI **隐藏** blank 会话，并把 blank 会话当作该工作区的 "New Session" 槽。

### GUI "New Session" 的会话落点（dsh-client-runtime `connectWorkspace`）

复用条件：`summary.blank && summary.cwd === workspace.path && workspace.sessionIds.includes(id) && !archived.includes(id)`，在 updatedAt 降序的列表里取**第一个**（= 最新的 blank）；否则 `session.create({ workspaceId })` 在工作区内新建。workspace 模式"无会话则新建"必须**镜像**这条规则（复用最新 blank → 才真正新建），避免每次唤醒都造新会话。

GUI 会话可见性：`origin !== 'subagent'`（工作区树里隐藏 subagent 子会话）+ 非归档 + 非 blank（除当前 blank 槽）。**唤醒目标选取需同样排除 subagent origin**——比 GUI 更严：blank 复用也排除（唤醒绝不能落进 subagent 子会话；subagent 子会话可能因继承 cwd 进入 sessionIds 账户）。

### host `session.create` 的 host 侧等价物（dsh-host-apiproxy `ensureSession`）

`ctx.agents.create({ sessionId, agentOptions, meta: { cwd }, setup })`（目录缺失时 host 先 `mkdir -p`；cwd 冲突时报错）→ `await workspace.attachSession(sessionId)`。已存在同 id 持久会话则按 header 校验后 `ctx.agents.resume`。

### RPC 面（client 插件可直接 fetch）

- ~~`POST /api/workspace.list`（client-request 信封，同 session.list）~~ **勘误（260910 E2E 证伪）**：dsh **没有** workspace/list RPC——workspace 命名空间只有 create/delete/rename/follow/insertBefore/insertSessionBefore/archiveSession 等写侧 remote。工作区数据的唯一 client 侧来源是 `ctx.get("workspaces")` client service（dsh-api-workspace-controller/lib/client.js）：`service.list` 为 subscribe/getSnapshot 的 useSyncExternalStore store（侧边栏同源）。实现见 `src/client/workspaces-source.ts`。
- `POST /api/session.list`（两段式 method，非 dotted）：面板在用（标题 enrichment）。

## 关键推论

1. **"最近更新"必须在 fire 时解析**（不能 create 时定格）：用户可能刚在另一会话工作。投递目标 = 工作区内 updatedAt 最大的**可见**（非 blank、非归档、非 subagent）会话。
2. **收敛性**：唤醒不推动 updatedAt（framing 是 plugin source），所以每小时 workspace 闹钟会稳定落在同一个会话，直到用户在该工作区另一个会话里发出真人 prompt——那一刻起后续唤醒切换到新会话。正是"投递到该工作区的最近更新会话"语义。
3. **新建路径**：全部候选为 blank（或无候选）时，复用最新 blank（GUI New Session 槽）；仍无则 `agents.create` + `attachSession`（meta.cwd = workspace.path，不 mkdir——目录缺失时明确失败，不制造幽灵目录；host session.create 的 mkdir 是用户显式建会话的语义，闹钟唤醒不应有这个副作用）。
4. **workspaces 无 auto-create**：path/id 必须解析到已注册工作区，否则闭式 not_found 错误（工作区是用户管理的分组，模型工具不应悄悄在侧边栏造组）。
