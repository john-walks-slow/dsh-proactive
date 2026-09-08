# dsh-proactive 发布前冲刺（默认指令预填 / 统一目标会话输入 / 加载态 / 全量本地化）

日期：2026-09-09 · 关联提交：968ea70（ctx.get 防御式访问）、5c1f657（本篇主体）

## 背景

用户在发布前验收中提出 7 项：

1. commit 当前所有修改（容器 canonical 文档二版、index.ts ctx.get 重构、borrow-from-schedule 研究笔记）。
2. v2 删除 heartbeatPrompt 时把**新建闹钟的默认指令预填**一起删了——用户依赖该预设（"这是一个 heartbeat reminder，…"），需要恢复。
3. 设置页首次加载闪现「0 个闹钟」，应有 spinner。
4. 新建闹钟的目标会话选择：下拉框 → **会话 ID 输入框**，默认当前会话。
5. 会话页 tab 的新建表单也要能选其他目标——**两面板表单完全一致**。
6. 深度 E2E 所有能力与接口。
7. 深度检视 polish 至可发布。

## 方案与实现

### 默认指令预填（2）

- `domain.ts` 新增 `DEFAULT_WAKE_PROMPT` 常量（用户指定的原 heartbeat 预设文案）。沉在 domain（零 import 的纯模块）是为了 host（config.ts）与浏览器 client bundle（sections.tsx 回退值）**共享同一事实源**。
- `config.defaultPrompt`：`resolveConfig` 读 config.json（trim 非空则用，超长按 maxPromptLength 钳制），默认=常量；`HotConfig`/`proactiveSettingsSchema`/`validateSettingsPatch`（`default_prompt` 键，非空 ≤20000）/`proactive_update_settings`（参数+SETTINGS_VIEW_SCHEMA+settingsView）/面板 `update_config` 全链路贯通。
- 面板快照 `ConfigView.defaultPrompt`；client DTO 标记可选——**旧 host 未重启时** client 回退内置常量（预填立即生效），配置卡编辑项仅在字段存在时渲染/提交（旧 host 不收到未知键）。host 重启后全量生效。

### 目标会话 ID 输入 + 两面板一致（4、5）

- `CreateForm` 重构为两面板唯一方言：目标模式 select（resume/fork/new，均可自由切换，不再钉死）+ **会话 ID 文本输入**（mono，resume 标签「目标会话 ID」/fork 标签「分支源会话 ID」；new 模式隐藏并显示提示）。
- 默认值=当前会话：会话页取本会话；设置页经 slot 全局标准钩子 `useSessions((s) => s.current)` 读 GUI 当前选中会话（防御式可选 prop，旧框架/单测无此钩子仍可挂载）。
- **owner 不再是表单字段**：会话页钉死本会话（host scope 规则）；设置页派生——resume/fork owner=目标会话（时区推断也随目标会话，语义更对），new owner=当前会话（无则 host-panel 伪会话）。原先「所属会话下拉 + 分支源下拉」两个选择器收敛为一个输入框。
- `createArgsFromForm`：`new` 模式**丢弃**残留 targetSessionId（否则共享校验器拒收）；resume/fork 发送前 trim。
- 客户端即时校验 `isValidSessionId`（非法字符显示错误、创建禁用）；空目标（resume/fork）禁用创建。

### 加载态（3）

- 两面板首次快照拉取（snapshot===null && error===null）显示 `LoadingBlock`（`.dshp-spinner` 旋转 + 「加载中…」），表格与配置卡位置不闪现「0 闹钟」/空表；头部计数显示「加载中…」；`prefers-reduced-motion` 降级。加载完成后的 SSE 刷新保留旧快照无闪烁。

### en 混排清理（7 附带）

- 状态/类型/目标 pill、runs 表头（时间/决策/预算/摘要+思考/回复前缀）、`fmtInstant` 日期 locale（zh-CN/en-US）、存储损坏提示、host-panel 标签、安静时段开始/结束、预算 "/日"、prompt 占位符——全部进入 locales.ts 词典（`LocaleNamespaceMap` union 同步）。

### 附带修复

- **204292f 起单测损坏 13 例**：tools.ts `sessionEventsOf` 改用 `agent.ctx.get("sessions", false)` 后测试 mock 未跟上（`agent.ctx.get is not a function`）。mock 补 cordis 形状 `ctx.get`，bare agent 场景给 `get: () => undefined`。
- once 类型切换即播种 afterSeconds=3600（修「输入框显示回退值但 canSubmit 仍为假」的卡顿）。

## 验证

- 单测 158/158（新增：defaultPrompt 解析/钳制、default_prompt patch 校验、new 模式目标守卫、trim、快照 defaultPrompt、工具 default_prompt 更新/持久化/视图）。
- E2E：独立实例（DSH_HOME=/tmp/e2e-dsh-home，profile=e2e=minimal bundles，port 4599）全量矩阵——见 validation.md。
- tsc 干净；构建产物已硬链同步 web profile。

## 兼容与发布说明

- client 侧改动页面刷新即生效（bundle 内容哈希 rev）；host 侧（config/settings/tools/panel service）需重启 dsh。未重启期间：预填经 client 回退常量可用，default_prompt 配置编辑隐藏，其余功能不受影响（目标会话 create 走 v2 既有 target 参数，旧 host 已支持）。
