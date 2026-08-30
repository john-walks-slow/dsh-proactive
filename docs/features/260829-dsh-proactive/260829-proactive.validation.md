# dsh-proactive 用户验证

## 验证说明

- 验证对象：dsh-proactive 插件 v0.1.0 的端到端行为。单元测试已覆盖 domain/config/store/observer/framing/scheduler/tools/wake/panel/settings（96 项全绿，含本轮 proactive_update_settings 与 heartbeat 默认前置的纯逻辑），以下场景依赖真实 DSH 服务、真实 GUI、真实时钟与真实推送通道，必须人工验证。
- 环境/前置条件：
  - dsh web 服务已重启并加载插件（日志出现 `dsh-proactive started`）
  - 本插件已按 README 安装步骤加入 profile（pnpm add + `dsh.profile.bundles` 列表；插件自带 bundle patch 自动生效），`$DSH_HOME/proactive/` 目录已生成
  - 一个真实会话（例如当前 GUI 会话）。可见投递通道：本 profile 已禁用 dsh-zen-remote（push_notify 不可用），走 dsh-wechat 的 send_wechat（需微信已绑定）；若只测聊天通道则无需额外配置
  - 建议把 `maxDeliveriesPerDay` 临时调到 1，便于验证预算上限

## 验证项

| 验证步骤 | 预期结果 | 实际结果 | 状态 | 备注/证据 |
| --- | --- | --- | --- | --- |
| 1. 冷会话唤醒：让会话进入 cold，对模型说"3 分钟后用 proactive_set 提醒我喝水"（或让模型自己订 alarm）；关闭该会话页面，等 3 分钟 | 到点后会话被自动唤醒；打开 GUI，看到模型产出的一条简短提醒（notice 小字条 + 模型回复），消息记录于 `runs.jsonl`（decision=reply） | | 待验证 | 核心场景一：用户委托闹钟跨冷会话触发 |
| 2. no_reply 深度静默：让模型订一个 heartbeat 闹钟（如每 10 分钟"检查 TODO 是否有可静默收尾的跟进"），前提是模型认为无需打扰；观察一个周期 | 到时无任何 GUI 效果、无新消息气泡、无推送；`runs.jsonl` 对应记录 decision=no_reply、budgetDelta=0；会话模型侧看到了唤醒内容（可在 next 对话中间接确认） | | 待验证 | 核心场景二：深度静默 |
| 3. 可见回复与预算：临时改 `maxDeliveriesPerDay=1`，让模型先做一次可见回复；再让模型订第二个 heartbeat 主动跟进闹钟（非 alarm） | 第二次主动唤醒被跳过：`state.json` 当日 delivered=1，第二个闹钟 runs 记录 decision=skipped（note 含 budget exhausted）；用户委托 alarm 仍可触发 | | 待验证 | 预算上限与用户委托豁免 |
| 4. 安静时段：把配置 quietHours 设为覆盖当前时刻（如 start 当前-1h，end 当前+1h），订一个 heartbeat 闹钟 30 秒后触发；同时订一个 alarm 闹钟 30 秒后触发 | heartbeat 到点不触发（`runs.jsonl` 无记录，nextDueAt 被推后）；alarm 正常触发 | | 待验证 | 安静时段仅用户委托放行 |
| 5. 重启恢复：订一个 2 分钟后的 alarm，在 30 秒内重启 dsh 服务 | 重启后插件加载，闹钟仍在 `alarms.json`，到点正常唤醒；若重启发生在触发瞬间，in-flight 记录被恢复并按 boot 策略处理（日志可见 recovered） | | 待验证 | 持久化与重启恢复 |
| 6. 用户控制：在任意会话问模型"现在有哪些主动提醒"并让模型用 proactive_list 查看；取消其中一条（proactive_cancel） | 模型列出本会话活跃闹钟及其 id；取消后该闹钟消失，到点不再触发 | | 待验证 | 用户控制闭环 |
| 7. 三场景走查（习惯教练）：让模型以习惯教练身份订每日 heartbeat（带具体跟进指令），次日或调短周期观察 | 模型在 wake 回合按 framing 规则简短跟进（或按规则 no_reply）；GUI 呈现克制（notice 小字条而非用户气泡） | | 待验证 | 场景一 |
| 8. 场景走查（陪伴互动）：让模型以陪伴 persona 的提示词订 heartbeat 闹钟并主动找用户聊天，隔一段时间触发 | 模型主动发起聊天，内容自然、符合会话 persona；频率受 hourly/每日预算约束 | | 待验证 | 场景二（wake_reason 已合并：陪伴场景用 heartbeat + persona 提示词表达） |
| 9. 泄漏验证：让模型在某一 wake 回合先输出文本再调用 proactive_no_reply | 文本已上屏（残迹被标记）；`runs.jsonl` 该次 decision 计算为 reply 且 budgetDelta=1（leaked 语义按可见输出计费）；无额外推送 | | 待验证 | 数据级静默的残余风险边界 |
| 10. 正常回合不受影响:在普通用户回合中调用 proactive_no_reply（或模型误用） | 工具返回 no_active_wake 错误，用户回合正常继续，不会静默结束 | | 待验证 | 工具守卫 |
| 11. 委托闹钟静默（角色扮演）：让模型以角色 persona 订一个 alarm 委托闹钟（如"1 小时后以角色身份找我"），到点后模型判定"静默不理更符合人设" → no_reply | 无可见输出、无推送；`runs.jsonl` 该次 decision=no_reply、budgetDelta=0；本次不打扰用户，后续正常 | | 待验证 | no_reply 对任何唤醒原因可用（角色扮演场景） |

## 验证结论

{待验证}

## 待跟进

{无}

---

# v2 GUI 管理面板验证（2026-08-29，随 v2 安装后执行）

## 前置

- 已安装带 GUI 的 v2（bundle 含 client 半边 + dsh.client 声明），重启 dsh web
- 期望：设置（齿轮）面板中出现「Proactive 闹钟」页签

| 验证步骤 | 预期结果 | 实际结果 | 状态 | 备注/证据 |
| --- | --- | --- | --- | --- |
| 1. 打开设置 → Proactive 页签 | 面板打开，显示闹钟表格（空态文案）、配置摘要、runs 空表；无控制台报错 | | 待验证 | 面板入口 |
| 2. 用模型 proactive_set 订一个 10 分钟后的闹钟，观察面板 | 面板无需手动刷新自动出现该闹钟（scheduled + 倒计时），状态正确 | | 待验证 | 工具→面板单向一致 |
| 3. 在面板新建「5 分钟后」闹钟 | 面板列表出现该闹钟；模型 proactive_list 按会话边界不显示它（面板是 host 管理台，面板建的单归属 sessionId=host-panel）——在面板内取消它验证反向一致 | | 待验证 | 面板→工具边界语义 |
| 4. 面板「立即触发」最近一条闹钟 | 面板 runs 出现新记录，decision 与唤醒行为一致（配合 no_reply 实测静默） | | 待验证 | fire 命令全链路 |
| 5. 面板「暂停」一条 repeat 闹钟，等一个周期 | 到点不触发、runs 无新记录；「恢复」后按下一锚点触发 | | 待验证 | paused 语义 |
| 6. 面板「取消」一条闹钟 | 列表消失；到点不再触发；模型 proactive_list 也查不到 | | 待验证 | cancel 双面一致 |
| 7. 设置面板改 quietHours 覆盖当前时刻并保存，面板顶部摘要即时刷新；再订一个非 alarm 闹钟 | 动闹钟被延迟（期望：配置热更生效，无需重启） | | 待验证 | 配置热更 |
| 8. 开两个浏览器标签页都在 Proactive 页，在一侧操作 | 另一侧 SSE 实时刷新（无需手动刷新） | | 待验证 | SSE 推送 |
| 9. 面板表单非法输入（间隔 <300s、空 prompt、超长） | 表单/API 拦截，返回闭式错误码文案，不产生脏数据 | | 待验证 | 校验一致 |
| 10. 同时用模型工具和面板各自新建一个闹钟后重启 dsh web | 重启后面板两个闹钟都在（持久化），状态正确恢复 | | 待验证 | 持久化 + 面板重启恢复 |
| 11. 面板「心跳预设」新建闹钟：点心跳预设按钮，再点创建 | 表单预填默认心跳提示词（设置面板配置的那段）+ 默认间隔 3600s + wake_reason=heartbeat；保存后列表出现 repeat 闹钟；改设置里 heartbeatPrompt/heartbeatEverySeconds 后面板预设随之更新 | | 待验证 | heartbeat 默认配置与面板联动 |
| 12. 「最近唤醒」摘要：触发几次唤醒（至少一次 no_reply、一次 reply）后打开面板 runs 区块 | 每条记录显示时间/决策/预算增量 + 思考与回复摘要（截断 200 字符，悬浮全文）；no_reply 记录也能看到模型静默的理由（思考摘要）；旧 runs 记录（无摘要字段）显示"—"不报错 | | 待验证 | 唤醒历史推理+回复摘要 |
| 13. 模型更新设置：在会话里让模型用 proactive_update_settings 把 heartbeat_every_seconds 从 3600 改成 1800（只传这一字段） | 只改变 interval：面板设置页 heartbeatEverySeconds 变为 1800，其余字段不变；`$DSH_HOME/proactive/config.json` 出现 `heartbeatEverySeconds: 1800`；重启 dsh web 后仍为 1800（持久化生效） | | 待验证 | 设置更新工具 partial + 持久化 |
| 14. heartbeat 默认前置：删掉某 heartbeat 闹钟的 prompt（或新建一个不带 prompt 的 heartbeat），等一个周期触发 | 唤醒内容以默认心跳提示词开头（面板设置里那段 `heartbeatPrompt`），无重复拼接；给 heartbeat 传一个附加方向 prompt 时，默认提示词在前、附加方向在后 | | 待验证 | heartbeat prompt 可选 + 默认前置 |
| 15. 面板 heartbeat 预设去重：用面板「心跳预设」新建（prompt 预填默认值，不修改） | 到点唤醒指令只有一份默认提示词，不会重复出现两遍 | | 待验证 | 预设 prefill 与默认前置的去重 |

## v2 验证结论

{待验证}
