# 260907-proactive-alarm-v2 交付总结

## 目标

按 `/workflow-research-plan` 定稿的需求重构 dsh-proactive 的闹钟模型：

- **干掉 wake_reason（alarm/heartbeat）分类**，只留每闹钟一个开关 `respect_quiet_hours`：默认 false = 用户委托提醒，安静时段照发、不占日预算（对齐旧 alarm 语义）；true = 遵从安静时段与日预算（对齐旧 heartbeat 语义）。
- **闹钟类型 单次/循环/cron 三种**，三者统一支持 `jitter_seconds`（0..86400 随机延迟，创建时抽取、烘焙进 nextDueAt，调度循环不等待）。
- **目标会话三种**：`resume`（既有会话）/ `fork`（从既有会话 fork）/ `new`（全新会话）；fork/new 产出**真实持久化会话**（侧边栏可见），唤醒 run 记在 alarm owner 名下。
- **cron 完全自研零依赖**（官方 dsh-schedule 无 cron；仅取调度语义为风格参考）。
- **时区缺省**（追加决策）：`time_zone` 可选，绝大多数调用不传；缺省 = 目标会话最近用户消息的 `clientTimeZone`（web 每轮 prompt 都带，与 dsh-time-context 同源）→ 宿主进程时区 → UTC 兜底。工具与面板共用 `src/zone.ts` 的 `effectiveTimeZone` 单一规则。

## 关键决策（D1-D7 + 时区）

| # | 决策 | 依据 |
| --- | --- | --- |
| D1 | jitter 统一 `jitter_seconds`（计划时刻后随机延迟）三类型通用 | 单一可解释语义；对齐 systemd RandomizedDelaySec |
| D2 | `respect_quiet_hours` 默认 false | 行为对齐旧 wake_reason=alarm（用户委托豁免） |
| D3 | cron 自研零依赖（5 字段数字；Vixie dom/dow OR；相邻 ≥300s 护栏；8 年窗口；DST 间隙跳过/重叠取较早、每墙钟分钟一发） | 平台无 cron 库；保持零运行时依赖 |
| D4 | 日预算门控随 respect 开关 | 复刻旧 alarm/heartbeat 差异，不漂移 |
| D5 | fork/new 子会话保留为真实会话 | 唤醒后可继续跟进该线程 |
| D6 | wire `sessionId` 保留为 owner（新增 target 字段） | 面板过滤/排序/复制 id 零破坏 |
| D7 | cron 按 alarm.timeZone 对齐 | 缺省走会话/宿主时区，用户无需显式传参 |
| D8 | 时区缺省 = clientTimeZone → 宿主时区 → UTC | 平台无持久化用户时区概念，仅每请求 clientTimeZone（dsh-time-context 同源）；宿主进程时区对自托管部署即用户本地时区 |

## 实施要点

- `src/domain.ts`：Alarm 领域模型 v2（`type`/`target` 判别联合触发）、DST 正确时区解析、`toAlarmView`（含 `paused` 状态——修掉 v1 潜在缺项）。
- `src/cron.ts`（新）：`parseCron` + `nextCronOccurrence` 纯函数；闭式错误码；本次修复两个真实缺陷（单数字被展开成 start..max 范围；dayMatches 未实现 Vixie 通配语义）。
- `src/alarm-factory.ts`：`validateCreateArgs`/`buildAlarm` 单一入口（工具与面板共用，防方言漂移）；jitter 对三类型统一应用。
- `src/scheduler.ts`：门控顺序 quiet(仅 respect)→defer 5 分钟 / hourly→cap / 日预算(仅 respect)→skip+advance；`advance()` 按类型推进。
- `src/wake.ts`：resume/fork/new 三路；fork seed = 与宿主一致的 `completedTurnCut`（last turn/end 之后吞到下一 turn/start）；冷父用 `sessionPersistence.inspect` 取 seed；缺省降级 failed + 日志。
- `src/store.ts`：STORE_VERSION=2 + v1 迁移（wakeReason/one-shot/repeat/jitter/deliveryHint 归一），corrupt 降级。
- `src/framing.ts`：无 heartbeatPrompt；`wake_type`/`respect_quiet_hours` 行 + JSON 块；no_reply 注明每次唤醒可用。
- `src/tools.ts` + `src/zone.ts`：proactive_set v2（恰一 selector；jitter/respect/target 参数）；`time_zone` 缺省在 execute 内解析（显式优先 → sessionEventsOf(agent) 取会话事件流 → 宿主）。
- `src/panel/*` + `src/client/*`：面板表单 单次(延迟或本地日期时间)/循环(秒)/Cron(表达式) 三选、jitter 三类型通用输入、目标三选 + fork 源选择、respect 开关、编辑回填（`formFromAlarm`）；归属守卫、run 归属（owner 或本会话）。
- 测试：149 个 node:test 全绿；`npm run check`（tsc 全量 src+test+client）零错；`npm run build` 成功。

## 验证

见 `260907-proactive-alarm-v2.validation.md`（11 项实机验收，含时区缺省项 11）。

## 审查

见 `260907-proactive-alarm-v2.review.md`。结论：准入（P0/P1 = 0；P2 = 2；P3 = 5），声明全部复核属实（tsc 0 错 / 151 测试全绿 / build 成功）。合入前已处理：

- **P2-①（已修）**：面板 once"指定日期时间"曾把 at 对象时区硬编码 UTC、绕过缺省链——现由 `wireTimeZones`（src/zone.ts，工具与面板共用的唯一接线规则）补链：at 对象自带显式 zone 即显式意图（顶层不合成），否则 顶层/at 时区都走 会话浏览器时区 → 宿主时区。
- **P2-②（已修）**：README.md 全篇 v2 化（wake_reason/heartbeatPrompt/jitter 0..1/one-shot-repeat 词汇清零），按 README 调 proactive_set 与 v2 契约一致。
- **P3-①（已修）**：time_zone 对所有 selector 统一校验（cron 之外 every/after 不再放行 Not/AZone 落库）。
- **P3-②（已修）**：面板 toggle 恢复 every 改为锚定 trigger.anchor（原锚），带 jitter 的闹钟 pause/resume 不再累积网格漂移。
- **P3-⑤（部分）**：本地 at 对象的 zone 现在反映到 alarm.timeZone（buildAlarm 回填）；at 字符串自含偏移、决策保持"绝对时刻"语义不变。
- 其余 P3（cron jitter 无频率护栏追加延迟、maxWakeupsPerHour 行为测试、maxConcurrentPerSession 未接线、表格 ±Ns 徽标文案、fork/new framing 措辞）按迭代跟进，已记录于 review.md。

## 备注

- 本仓库其余未提交改动（docs/issues/260830-container-mount-canonical/）为他人并发工作，未纳入本次提交。