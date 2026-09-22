# new 模式唤醒会话无 cwd，回合启动即被 dsh-mnemon 炸死

- 日期：2026-09-22
- 现象：`alarm_mu1fwnou4g3okk`（Luna 深夜 02:00）/ `alarm_mu3hilkv3kcnud`（World Master 05:00）两个 `target_mode: "new"` 闹钟**自创建起 100% 失败**，run history 全部 `failed / "wake turn ended abnormally"`。

## 根因链

1. `wake.ts` new 分支只在显式给了 `target_workspace_id` 时才给新会话设 cwd；这两个闹钟没给 → 每次新建的会话无 cwd（落在 `sessions/_no-cwd/`）。
2. dsh-mnemon 0.5.5（第三方插件）配置 `storageScope: workspace`（settings.yaml）。其 `forAgent()` 对无 cwd 会话直接 throw `"the current DSH session has no workspace for Mnemon"`。
3. throw 发生在回合启动的 mnemon hook 里，整轮 ~12ms 内死掉，**模型从未被调用**；observer 记 `failed`。
4. resume/fork/every 目的地会话天然有 cwd，所以只有 new 模式踩雷。

证据：失败会话日志（如 `session-cedec27f`）`turn/start → turn/end`（error 即上述消息），无任何模型请求事件。

## 修复

- **止血（数据面，免重启）**：`proactive_update` 给两个闹钟补 `target_workspace_id`（Luna → luna 工作区 `f68c0fcb`；WM → yu 工作区 `e047a43b`）。new 模式方言本就支持 workspaceId（cwd + attach）。Luna 的 prompt 引用相对路径 `memory/`，本来就需要该 cwd。
- **根治（代码面）**：`wake.ts` new 分支在未显式给 workspace 时，经 `parentLog(alarm.ownerSessionId)` 继承 owner 会话的 cwd（与 fork 的 parent-cwd 继承同机制；不 attach——显式 workspaceId 才有 attach）。owner 不可读或无 cwd 时保持旧行为（无 cwd）。

## 教训

- new 模式的"全新空会话"必须考虑 host 侧插件对会话元数据（cwd/preset）的隐式依赖；GUI 建的会话总有 cwd，插件自建会话不一定。
- `wake turn ended abnormally` + 会话日志 turn 时长极短（<100ms）= 回合启动期 hook 异常，先查会话日志的 turn/end error，不要怀疑模型链路。
