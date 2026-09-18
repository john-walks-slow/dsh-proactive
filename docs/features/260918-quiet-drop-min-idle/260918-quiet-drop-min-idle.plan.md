# 260918 安静时段直跳 + min_idle_seconds — 计划

来源：2026-09-18 会话讨论（免打扰语义 + busy 重试窗口太短）。已与
`docs/features/260918-declared-schedules/`（f43223c，声明式闹钟文件）交叉核实，结论融洽，
联动调整已并入下文「与 declared 的联动」小节。

## 改动一：安静时段 respect=true → 直接跳过（快进）

现状：`scheduler.ts` fireOne 命中安静窗且 respect=true 时 `deflect` 推 5 分钟重探，
窗口结束后迟到补发。问题：quiet 门只拦模型自设闹钟（用户委托默认 false 不受影响），
迟到补发的收益只惠及最该夜间消失的那类；且一夜到期的 N 个闹钟全部堆在窗口结束后
5 分钟内补发（安静时段本想防的轰炸）。

新语义：

- once → 直接 completed，记一条 skipped run（note=quiet hours；面板可查"为什么没跑"）。
- every/cron → 快进到安静窗外的下一个锚点：从 now 起按各自推进数学（every 走
  `nextDriftingOccurrence` 漂移锚、cron 走 `nextCronOccurrence`）迭代到首个窗外锚点，
  **一次算到位**——否则 1 分钟级闹钟整夜逐分钟空转 drive 循环 + 磁盘写。快进跳过的
  occurrence 数可附在 skipped run note。
- 进窗时每闹钟记一条 skipped run（每夜 ~1 条，不是每 occurrence 一条）。
- hourly cap 命中的 deflect（`scheduler.ts:194`）**保持不动**——cap 是瞬时限流，等
  5 分钟是对的；只有 quiet 是"不许打扰"语义。
- 安静窗判定沿用 config.quietHours.timeZone（host 全局），与闹钟自身 timeZone（锚点
  计算）独立，维持现状。

### 与 declared schedules 的联动（已核实）

1. sync 对 hash 未变闹钟完全 no-op（`declared.ts:448`），快进改写的 nextDueAt 不会被
   轮询打回；in-flight 跳过（`:447`）。
2. 对 world master 语义更正确：叙事 `at` 条目落进安静窗不再 08:00 迟到补发（叙事
   断裂），而是不发生、world master 次日重写；要夜间叙事的条目显式
   `respect_quiet_hours=false`（plan 示例已是该写法）。skill 的"安静时段注意"指引
   不变且更贴切。
3. 文档同步：根/模块 AGENTS.md「每 5 分钟延迟重评估」句、tools 描述、locales hint。

## 改动二：`min_idle_seconds`（defer-until-idle）

现状：目标会话忙只退避 3×30s（~60s）就永久跳过，监控长任务必失败。本参数语义是
「目标冷够 N 才唤醒」（defer-until），不是「不冷就丢」。

语义：

- 检查点：WakeDriver 解析出 resume 目的地后、runMaintenance claim 前，读目标会话
  最后事件时间（live 走 `sessionLogOf` 尾部，精确；cold 视为天然冷，不做投影近似）。
- 未冷 → 新增 defer outcome：scheduler 重臂到 max(lastEvent+N, now+60s)，事件驱动
  不轮询；不记 run、不烧重试预算、不烧 cap；重臂后照常过 quiet/预算/cap 门。
- 不设放弃上限——"冷够才叫"即参数本意，一直冷不下来就一直等（耐心是设参人自己选的）。
- fork/new 目标是新建会话，参数忽略（文档注明）。
- 活动判定=任意会话事件（含上次唤醒自身回合）：自监控闹钟被强制间隔 ≥N，天然防抖。
- 与 busy 的关系：min_idle 是预门（读日志），busy 是机械 claim（runMaintenance 抛错），
  两者共存；长任务场景由 min_idle 挡住，claim 竞态由 30s busy 重试兜底。
- 校验：0=关（默认），上限 86400；进 ALARM_SPEC_PARAMETERS（set/update 同方言）。

### 与 declared schedules 的联动（已核实）

1. **可行性关键前提**：sync hash 未变 → 完全 no-op（`declared.ts:448`），defer 滑动的
   nextDueAt 不会被 60s 轮询重置；唤醒进行中 in-flight 跳过（`:447`）。已按代码核实。
2. min_idle_seconds 进 `validateCreateArgs`/`buildAlarm` 同一工厂后，declared 文件
   **免费获得**该字段（无第二方言），且自动进 spec hash——文件里改 min_idle → 替换
   重建，与 declared 语义一致。
3. declared 目标默认=文件所在 workspace → `pickWorkspaceTarget` → resume 目的地，
   min_idle 正常生效；解析出 none → 既有 skip 语义优先（到不了 idle 检查那步）。
4. world master 获得作息节奏类唤醒的原生原语："会话冷够 N 才唤醒"（用户正在用会话时
   不插话）。skill 侧跟进（非阻塞）：`check_wake_schedule.mjs` schema 与 SKILL.md
   字段清单补 `min_idle_seconds`。

## 两改动的既有交互

min_idle 把唤醒推迟进安静窗且 respect=true → 按改动一快进跳过（quiet 优先，合理）。

## 实施清单

- [x] `scheduler.ts`：quiet 分支快进（once/every/cron 迭代到窗外；skipped run 记录）
- [x] `domain.ts`/`alarm-factory.ts`/`tools.ts`：min_idle_seconds 校验 + 方言参数 + 描述
- [x] `wake.ts`：claim 前 idle 检查 + defer outcome；`scheduler.ts` defer 分支
      （不计数、不记录、重臂）
- [x] 面板：create 表单字段 + AlarmView 往返 + locales zh/en
- [x] 文档：根/模块 AGENTS.md、tools 描述、README（可选）
- [x] 测试：quiet 快进（once/every/cron/跨午夜/窗界）、defer 滑动与恢复活跃顺延、
      **declared+min_idle 同步 no-op 回归**（防 sync 打回 defer 状态）、既有 298 回归
- [x] e2e：4188 隔离实例；与 declared 的 dsh 重启窗口合并验收（线上重启另行征求同意）

## 实施状态（260918）

全部落地，308/308 测试绿（+10 用例）；reviewer 条件准入，S1（快进路径 runCount/lastRunAt 语义对齐）及 N1/N2/N5 已修，见 review.md 处置记录。待用户实机验证（validation.md）与 dsh 重启生效。

## 验收

1. 安静窗内 respect=true：once → completed（skipped run 一条）；every/cron →
   nextDueAt=窗外首锚点；窗内无逐分钟空转（runs.jsonl / alarms.json mtime 佐证）。
2. min_idle：目标会话活跃 → defer（无 run 记录、alarm 保持 scheduled）；冷够 N 后
   正常唤醒；中途恢复活跃 → 重臂顺延。
3. declared 文件加 `min_idle_seconds` 条目 → 60s 内同步创建；改值 → 替换；defer 期间
   轮询不重置 nextDueAt（本轮核心回归）。
4. `npm run check` / `npm test` 全绿；e2e 4188 实例过 1–3。
