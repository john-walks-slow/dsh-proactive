# 260910-proactive-workspace-target 总结

## 交付内容

第 4 种闹钟目标类型 **workspace**：唤醒投递到工作区的最近更新会话——

1. **工具路径**：`proactive_set target_mode=workspace` + `target_workspace_id` / `target_workspace_path`（可省略，按会话 cwd 推导）。schema 校验闭式错误（invalid_trigger/not_found）。
2. **fire 语义**（`resolveWorkspaceWakeTarget`，GUI 侧边栏语义的精确镜像）：
   - 排序键 = 侧边栏 updatedAt（max(createdAt, lastPromptAt)），live 折叠（listMetadataOf）优先、cold 投影缓存行其次——与会话列表两个同源数据源；
   - 目的地 = 最新**可见**（非 blank、非 subagent、非 archived）会话 → 最新空白 New Session 槽 → 新建会话（cwd=工作区路径，**先 attach 后投递**，失败不投递到游离会话）；
   - 工作区目录缺失（missing-dir）→ 闭式 failed；无工作区注册表 → failed 有声（warn 日志）。
3. **面板路径**：目标类型"工作区"+ 工作区下拉（数据来自 client `workspaces` service——dsh 无 workspace/list RPC），会话页/设置页共用；按会话 cwd 预选；闹钟行显示工作区标题（title 优先，path 兜底）。exotic profile（无 workspaces service）降级为禁用+提示。
4. **agent 预设传播**（并发 agent 工作，一并交付）：create/fork/workspace-create 三臂装 `resolveSessionPreset`+`presets.mount`，fork 子会话继承父 preset；framing 本地时间格式化。

## 交付中顺带修复的 dsh 0.1.2-rc.1 升级回归（生产已受损）

| 回归 | 修复 |
|---|---|
| host 唤醒全挂（Session 移除 `.events`） | `sessionLogOf`/`liveEventsOf` 兼容 helper + `session.seq` startIndex（wake.ts、workspace.ts、index.ts、tools.ts 全部改口） |
| agents.create setup 期 resolveSessionPreset 崩（setup 期无 events） | 兼容适配器 `{header, events: sessionLogOf(...)}`；preset 在 setup 前解析 |
| 设置页面板整体消失（slots.register 竞态） | `ctx.slots.inject("settings.section", ...)` 等父声明 |
| 面板会话标题消失（session/list 404） | 两段式 method `POST /api/session/list` + `{args:{_request:{}}}` + `result.ok` 校验 |
| 工作区 live 会话排序崩溃 + 时区推导静默降级 | liveEventsOf（live 折叠与 sessionEventsOf 两个消费点） |

生产实例（端口 4175）仍跑旧代码：唤醒失败会持续到**用户书面同意后重启 dsh**（红线，重启技能已记录）。

## 依赖约束（重要）

- dsh 0.1.2-rc.1 的 dsh-invariants 不满足自身 semver range、dsh-client-runtime 无 0.1.2 发布 → **devDependencies 无法升级**，只能 pin 0.1.1-rc.2 + 运行时兼容层。升级窗口出现在 0.1.2 正式版发布后。
- `@deepseek-ai/dsh-agent-presets` 新增为 peer（^0.1.1-rc.2）+ dev（0.1.1-rc.2 pinned）。

## 验证

- 单测 229/229（workspace.test.ts 26 项：折叠/排序/两臂解析/端口、liveEventsOf/sessionLogOf 跨版本兼容、live fold 跨 Session 版本、B1 判别与 live/cold 混排、ENOENT 闭式、cold 失败闭式）。
- E2E 7/7（隔离 0.1.2 host）：创建-attach-投递、收敛投递、GUI 创建/触发/live 分支、会话页 tab、标题展示、B1 判别（旧 createdAt+新 prompt 胜——真实 GUI 双 prompt 后闹钟正确落点）。详见 validation.md。
- Review：reviewer 首轮不准入（B1 live 折叠读错时间字段），全部阻塞/建议项已修复并复验（见 validation.md 修复轮），S3 为误报，N1/N6 记录不改。
- 覆盖缺口：空白槽复用分支仅单测覆盖（E2E 场景中被可见会话击败，同一排序函数）；模型侧默认工作区推导未做 E2E。

## 后续（非阻塞）

- 生产重启（需用户书面同意）→ 回归 A 自愈。
- devDependencies 升级到 0.1.2 正式版后可删兼容层（sessionLogOf/liveEventsOf 双臂保留亦无害）。
