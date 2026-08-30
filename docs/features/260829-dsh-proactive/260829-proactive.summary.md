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

---

# v3 增量（2026-08-30：设置更新工具 + heartbeat 提示词默认前置）

## 背景

用户两处体验反馈：

1. **设置可改**："添加更新设置的工具，比如可以只是改interval不改别的"——此前配置只能靠手改 config.json 或设置面板 UI，模型无工具面。
2. **heartbeat 提示词语义**："heartbeat工具的prompt我感觉还真可以optional，甚至无论如何前面都应该接那个默认值的…默认值最general所以效果很好…prompt只有有额外方向要求的时候才补充在后面"——现有实现把 heartbeat 的 prompt 当必填且直接替代默认值，用户期望默认提示词永远在场、prompt 只作附加方向。

## 已落地决策

- **`proactive_update_settings` 工具**（第 5 个）：
  - partial update：10 个可选 snake_case 参数（enabled/max_deliveries_per_day/quiet_hours/max_wakeups_per_hour/max_concurrent_per_session/boot_overdue_policy/max_retries_per_fire/max_prompt_length/heartbeat_prompt/heartbeat_every_seconds），至少传一个；只改传入字段。
  - 执行链：`validateSettingsPatch`（闭式校验，未知键拒、逐字段类型/范围）→ `writeConfigFile`（读现有 config.json 合并 patch，tmp+rename 原子写）→ `applyHotConfig`（就地热应用到 scheduler/wake/tools 共享的 config 对象）→ 返回更新后完整设置视图。
  - 校验上限与 resolveConfig 钳制**逐项一致**（对传入字段既不静默截断也不热应用、重启后回落分裂）；heartbeat prompt 上限沿用 MAX_PROMPT_LENGTH。
- **heartbeat prompt 可空 + 默认前置**：
  - `proactive_set` 的 `prompt` 参数 schema 去掉 `required:true`（描述：heartbeat 可省略，alarm 必填）；`validateCreateArgs` 先解析 wake_reason 再分支校验——heartbeat 缺失/空/纯空白 → ""（超长仍拒），alarm 走 `validatePrompt` 必填非空。面板共享同校验，语义自动一致。
  - `effectiveWakePrompt(ctx)`：heartbeat 永远以配置默认心跳提示词开头；用户 prompt（trim 后非空且 ≠ 默认）作为附加方向以 `\n\n` 接在后面；等于默认时去重（覆盖面板预设 prefill 默认值的存量路径）。alarm/legacy 原样。
  - FramingContext 新增 `heartbeatPrompt`（wake.ts 从 config 传入）；renderFraming 的 alarm_prompt_json.prompt 与 notice summary 均用 effective 文案。
- **测试**：96/96 全绿（新增 settings.test.ts 1 个文件 + tools/framing 用例）；补了 partial 只改 interval、heartbeat 无 prompt 创建、默认去重等关键断言。

## 代表性变更文件

- `src/tools.ts`（新工具 + prompt 可选化）、`src/settings.ts`（validateSettingsPatch）、`src/config.ts`（writeConfigFile 原子持久化）、`src/alarm-factory.ts`（按 wake_reason 分支校验）、`src/framing.ts`（effectiveWakePrompt）、`src/wake.ts`（透传 heartbeatPrompt）
- 测试：`test/settings.test.ts`（新）、`test/tools.test.ts`、`test/framing.test.ts`

## 待办（追加）

4. v3 验证项见 validation.md 13–15（需实机：设置工具持久化重启后生效、heartbeat 默认前置、面板预设去重）
