# dsh-proactive 用户验证

## 验证说明

- 验证对象：dsh-proactive 插件 v0.1.0 的端到端行为。单元测试已覆盖 domain/config/store/observer/framing/scheduler（39 项全绿），以下场景依赖真实 DSH 服务、真实 GUI、真实时钟与真实推送通道，必须人工验证。
- 环境/前置条件：
  - dsh web 服务已重启并加载插件（日志出现 `dsh-proactive started`）
  - 本插件已按 README 安装步骤加入 profile（pnpm add + `dsh.profile.bundles` 列表；插件自带 bundle patch 自动生效），`$DSH_HOME/proactive/` 目录已生成
  - 一个真实会话（例如当前 GUI 会话）。可见投递通道：本 profile 已禁用 dsh-zen-remote（push_notify 不可用），走 dsh-wechat 的 send_wechat（需微信已绑定）；若只测聊天通道则无需额外配置
  - 建议把 `maxDeliveriesPerDay` 临时调到 1，便于验证预算上限

## 验证项

| 验证步骤 | 预期结果 | 实际结果 | 状态 | 备注/证据 |
| --- | --- | --- | --- | --- |
| 1. 冷会话唤醒：让会话进入 cold，对模型说"3 分钟后用 proactive_set 提醒我喝水"（或让模型自己订 alarm）；关闭该会话页面，等 3 分钟 | 到点后会话被自动唤醒；打开 GUI，看到模型产出的一条简短提醒（notice 小字条 + 模型回复），消息记录于 `runs.jsonl`（decision=reply） | | 待验证 | 核心场景一：用户委托闹钟跨冷会话触发 |
| 2. no_reply 深度静默：让模型订一个 check_in 闹钟（如每 10 分钟"检查 TODO 是否有可静默收尾的跟进"），前提是模型认为无需打扰；观察一个周期 | 到时无任何 GUI 效果、无新消息气泡、无推送；`runs.jsonl` 对应记录 decision=no_reply、budgetDelta=0；会话模型侧看到了唤醒内容（可在 next 对话中间接确认） | | 待验证 | 核心场景二：深度静默 |
| 3. 可见回复与预算：临时改 `maxDeliveriesPerDay=1`，让模型先做一次可见回复；再让模型订第二个 check_in/companion 闹钟（非 alarm） | 第二次主动唤醒被跳过：`state.json` 当日 delivered=1，第二个闹钟 runs 记录 decision=skipped（note 含 budget exhausted）；用户委托 alarm 仍可触发 | | 待验证 | 预算上限与用户委托豁免 |
| 4. 安静时段：把配置 quietHours 设为覆盖当前时刻（如 start 当前-1h，end 当前+1h），订一个 check_in 闹钟 30 秒后触发；同时订一个 alarm 闹钟 30 秒后触发 | check_in 到点不触发（`runs.jsonl` 无记录，nextDueAt 被推后）；alarm 正常触发 | | 待验证 | 安静时段仅用户委托放行 |
| 5. 重启恢复：订一个 2 分钟后的 alarm，在 30 秒内重启 dsh 服务 | 重启后插件加载，闹钟仍在 `alarms.json`，到点正常唤醒；若重启发生在触发瞬间，in-flight 记录被恢复并按 boot 策略处理（日志可见 recovered） | | 待验证 | 持久化与重启恢复 |
| 6. 用户控制：在任意会话问模型"现在有哪些主动提醒"并让模型用 proactive_list 查看；取消其中一条（proactive_cancel） | 模型列出本会话活跃闹钟及其 id；取消后该闹钟消失，到点不再触发 | | 待验证 | 用户控制闭环 |
| 7. 三场景走查（习惯教练）：让模型以习惯教练身份订每日 check_in（带具体跟进指令），次日或调短周期观察 | 模型在 wake 回合按 framing 规则简短跟进（或按规则 no_reply）；GUI 呈现克制（notice 小字条而非用户气泡） | | 待验证 | 场景一 |
| 8. 三场景走查（陪伴互动）：让模型订 companion 闹钟并主动找用户聊天，隔一段时间触发 | 模型主动发起聊天，内容自然、符合会话 persona；频率受 hourly/每日预算约束 | | 待验证 | 场景二 |
| 9. 泄漏验证：让模型在某一 wake 回合先输出文本再调用 proactive_no_reply | 文本已上屏（残迹被标记）；`runs.jsonl` 该次 decision 计算为 reply 且 budgetDelta=1（leaked 语义按可见输出计费）；无额外推送 | | 待验证 | 数据级静默的残余风险边界 |
| 10. 正常回合不受影响:在普通用户回合中调用 proactive_no_reply（或模型误用） | 工具返回 no_active_wake 错误，用户回合正常继续，不会静默结束 | | 待验证 | 工具守卫 |

## 验证结论

{待验证}

## 待跟进

{无}
