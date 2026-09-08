# 发布前冲刺 — 用户验收要求

实施内容需要用户在**真实环境**（生产实例 4175 重启后）最终确认。以下为建议验收点（独立实例 E2E 已覆盖的部分见 E2E 报告；此处列用户视角的高价值项）。

## 已完成验证（自动化 E2E，2026-09-09）

- **独立实例 API 面 28 项**（实例 DSH_HOME=/tmp/e2e-dsh-home，port 4599，commit 5c1f657）：state 快照/作用域过滤、create once/every/cron × resume/fork/new、全部非法参数闭式错误码、edit/toggle/cancel/fire、update_config（enabled 热切换、default_prompt 持久化、空串拒绝）、405/bad_action、SSE connected+changed、作用域守卫 forbidden/scope_mismatch —— 全 PASS。
- **GUI 面**（Camoufox）：新建表单预填默认预设、目标会话 ID 输入框默认当前会话、fork/new 标签切换、非法 id 阻断、GUI 创建/编辑/暂停/立即触发、配置卡 default_prompt 编辑+持久化、会话页与设置页表单一致、en 无中文混排、**唤醒链路**（90s 闹钟真实触发，模型调 no_reply，runs.jsonl 记录 decision=no_reply budgetDelta=0）、**模型工具链**（proactive_set→list→cancel→update_settings 全部成功）—— 全 PASS，0 个 P0/P1。
- **检视修复批（commit 31bff9a）增量验证**（实例 port 4601 + 4599 刷新加载新 client bundle）：
  - host：4001 字符 default_prompt → HTTP 400 invalid_trigger；4000 字符接受且持久化；5000 字符手写 config.json 重启后钳制到 4000 ✓
  - client：en 决策 pill "silent"、zh "静默"（悬停保留原始值）；卡片标题 en "Alarms" 大写；未知会话软提示（非阻断，Create 保持可用）且与非法 id 硬错误互斥；zh-CN 日期格式；console 零 error ✓
  - 加载态 spinner 为浏览器工具 page 隔离所限未能实时截帧（代码级验证 + 单测覆盖；未采纳 "?slow= 调试参数" 建议——测试专用参数不值得进生产路由）
  - 证据截图：/tmp/e2e-dsh-home/shots/（B1~B5 共 8 张 + C2 未知会话提示 + C3 zh 决策 pill）

## 用户最终验收清单

| # | 验收项 | 操作 | 期望 |
|---|---|---|---|
| 1 | 默认指令预填 | 重启生产 dsh 后，设置页/会话页点「新建闹钟」 | 唤醒指令预填"这是一个 heartbeat reminder，…" |
| 2 | 预设可改 | 设置页全局配置「默认唤醒指令」改为自定义文案保存 → 再新建闹钟 | 预填变为新文案；重启后仍生效 |
| 3 | 加载态 | 弱网/刷新设置页 | 首次拉取期间显示 spinner，不闪现「0 个闹钟」 |
| 4 | 目标会话输入 | 新建闹钟（两面板各一次） | 目标为会话 ID 输入框，默认当前会话；可改任意 id；fork 标签变化；new 无输入框 |
| 5 | 两面板一致 | 对照两面板新建表单 | 字段与选项完全一致（类型/抖动/免打扰/目标模式/目标会话 ID） |
| 6 | 跨会话目标 | 会话页把目标改为另一会话 id 创建 | 创建成功，两面板可见 |
| 7 | 非法 id 防线 | 输入 `abc/def` | 出现错误提示，创建按钮禁用 |
| 8 | en 无混排 | 切英文界面 | 面板全部文案（含状态 pill、runs 表头、日期）为英文 |
| 9 | 模型工具 | 让模型 proactive_set + proactive_update_settings({default_prompt}) | 工具成功，面板预填随之变化 |

## 检视修复批（commit 31bff9a）补充验收点

以下 4 项已在独立实例自动验证通过（见上节"已完成验证"），用户在真实环境按需复验即可：

| # | 验收项 | 操作 | 期望 | 状态 |
|---|---|---|---|---|
| 10 | defaultPrompt 上限 | update_config / proactive_update_settings 传 4001 字符 default_prompt | invalid_trigger 拒绝；4000 字符接受 | ✅ 已验证 |
| 11 | 预填永不超限 | config.json 手写 5000 字符 defaultPrompt 后重启 | 加载时钳制到 4000（预填始终可创建） | ✅ 已验证 |
| 12 | 未知会话提示 | 新建表单目标输入一个不存在的 id（列表已加载时） | 出现琥珀色软提示，创建按钮仍可用 | ✅ 已验证 |
| 13 | 决策 pill 本地化 | zh 界面查看 run 历史 | 显示 静默/已回复/跳过/失败（悬停见原始值） | ✅ 已验证 |
| 14 | 卡片标题 | en 界面 | 闹钟卡片标题 "Alarms"（大写） | ✅ 已验证 |

## 注意

- 生产实例（4175）host 侧未重启前：预填靠 client 内置常量回退可用；`default_prompt` 编辑项不显示（设计如此）；`proactive_update_settings` 尚不认识 `default_prompt` 键（返回 invalid_trigger）——重启后全量生效。
- 重启 dsh 会中断当前会话，安排在方便时进行。
