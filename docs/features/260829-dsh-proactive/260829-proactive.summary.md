# dsh-proactive 实现总结

日期：2026-08-29 · 阶段：M1–M3 实现 + 评审修复完成（62/62 单测全绿）· M4 安装/验收待用户执行

## 交付物

| 产物 | 位置 | 说明 |
| --- | --- | --- |
| 插件包 | `packages/dsh-proactive/` | cordis 4 函数插件；`lib/` 已构建、已 gitignore |
| 模块 | src/{domain,config,store,scheduler,wake,framing,observer,tools,index}.ts | 见下 |
| 单测 | test/*.test.ts（62 项，8 个文件） | node:test；`npm test`（tsc + dist/test） |
| 计划 | docs/features/260829-dsh-proactive/260829-proactive.plan.md | 设计基线 |
| 验收清单 | docs/features/260829-dsh-proactive/260829-proactive.validation.md | 待用户验证 |
| 代码审查 | docs/features/260829-dsh-proactive/260829-proactive.review.md | reviewer 产出 + §12 处置记录 |

## 模块职责

- domain.ts：领域模型 + 校验 + DST 正确的本地时间解析（移植自 dsh-schedule 算法）+ 闭式错误码
- config.ts：默认配置、`config.json`/环境变量覆盖、安静时段判定（IANA 时区、跨午夜；非法 HH:MM 回退默认）
- store.ts：`alarms.json`（原子写）/ `runs.jsonl` / `state.json`；corrupt 降级不崩
- scheduler.ts：串行 drive 循环（异常隔离：单闹钟失败不杀链）；boot 逾期策略、安静/每小时/每日预算门控、busy/failed 重试、单定时器重臂、fireOne 前持久化 in-flight（崩溃窗口语义）
- wake.ts：live 复用 / 冷会话 `ctx.agents.resume()`；`runMaintenance+followup` 排队；`whenIdle` 沉降；handle dispose；inflight 并发保护
- framing.ts：唤醒报文（wake_reason / user_presence / budget / quiet_hours / alarm_prompt_json 标注不可信 + 3 条回复规则）；`form:"notice"` + summary 的 user 消息
- observer.ts：以 framing notice 为切片锚点，从已提交会话日志判定 no_reply / reply / push / failed 与预算增量、leaked 标记（读真实 turn/end `reason.kind`）
- tools.ts：proactive_set（after/every 上限 10 年）/ list / cancel（未知 id 返回 not_found）/ no_reply（inflight 守卫 + `exec.concludeTurn()`）
- index.ts：插件装配、agent/created 注册工具 + 启动时扫描既有 root agents、teardown

## 已落地设计决策

- D1 host 级独立闹钟存储（不复用 dsh-schedule 会话内提醒）
- D2 唤醒 = resume 冷会话或复用 live agent；framing 呈 notice 小字条
- D3 no_reply = `concludesTurn` 机械结束 + 不产出文本（数据级无感知）；文本先行的泄漏由 observer 标记并按可见输出计费
- D4 预算 = 任一可见输出 1 单位/UTC 日 3 上限；no_reply 免费；预算耗尽跳过主动唤醒、用户委托 alarm 仍触发（允许轻微超限）
- D5 原子写 + 审计 runs.jsonl；D6 IANA 时区、every_seconds>=300、锚点对齐

## 评审处置（review.md §12）

- P0：`package.json` 截断损坏 → 恢复完整 JSON（独立于评审发现）
- P1-1：driveChain 无异常隔离 → per-alarm try/catch + advance fail-closed + resolveConfig 校验 quietHours
- P1-2：proactive_cancel 契约矛盾（cancelled:false 违反 const 校验）→ 未知 id 返回 `not_found`
- P1-3：in-flight 从未落盘（recoverInFlight 死代码）→ fireOne 先持久化 in-flight
- P2：observer 改读真实 `reason.kind`；leaked 加 note；framing 锚点切片
- P3：after/every 上限（10 年）；alarm_prompt_json 标注不可信来源；预算措辞与实际语义一致；hourly cap 只计成功唤醒
- 补测：tools.test.ts（11 项）、wake.test.ts（6 项）、observer 真实形状、scheduler 注入回归、config 回退回归、in-flight 观测 → 62/62 三连全绿

## 与计划的主要一致性确认

- 工具契约与闭式错误码按计划实现；新增 `no_active_wake` 错误码（no_reply 非唤醒回合守卫）；`not_found` 已闭环
- 安静时段 5 分钟重评估延迟（计划值），alarm 豁免
- bootOverduePolicy：fire 补跑一次（重复闹钟只推进锚点不补历史）、notify-only 记 skipped、drop 取消/推进

## 待办（后续步骤）

1. 用户执行 validation.md 的 10 项验收（需重启 dsh 服务；M4 安装步骤见 validation.md 前置条件）
2. 本次 git 提交已完成（初始提交）
3. v2 候选：GUI 管理面板、push 通道去重确认、dsh-schedule 互通、runs/alarms 无界增长归档策略
