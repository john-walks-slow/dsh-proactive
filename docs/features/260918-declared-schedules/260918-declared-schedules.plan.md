# 260918 声明式闹钟文件（declared schedules）— 计划

## 背景

world master（create-simulated-events skill）每日演化 living agent 的生活事件后，希望
agent 能在恰当的时刻被 proactive 主动唤醒（体验事件、作出反应），而不是等用户打开会话。
初步两个方向：

1. events.json 加唤醒参数，proactive 读 `.life` 文件 —— 让通用插件耦合 simulated-life
   的私有 schema，还要解决"哪些 workspace / 唤醒谁"的归属问题，且唤醒需求不总是与事件
   一一对应（作息节奏类唤醒）。**否决**。
2. proactive 支持"时间表文件触发"，skill 指导 world master 同步产出时间表 —— 通用能力、
   零耦合、声明式幂等。**采纳**，具体化为「声明式闹钟文件」。

另有一个零代码 MVP（world master 每天直接 `proactive_set`）：命令式，清理靠模型自觉、
重跑重复、中断半途而废，作为对照不采纳。

## 设计

### 数据流

```
world master（每日 05:00 wake turn）
  └─ 写 events.json 的同时写 $WORKSPACE/.life/wake_schedule.json（声明式期望状态）
dsh-proactive（host 侧）
  ├─ 启动时 + 每 schedulePollSeconds 轮询 config.scheduleFiles 的 glob
  ├─ 解析文件 → 期望闹钟集合，与 store 中本文件的 declared 闹钟 diff
  └─ 增 / 删 / 改（文件 = 唯一真源，幂等，重启自愈，旧条目自动清理）
```

### 文件格式（`.life/wake_schedule.json`）

```json
{
  "version": 1,
  "time_zone": "Asia/Shanghai",
  "target": { "workspace_path": "/root/agents/yu" },
  "entries": [
    {
      "id": "evt-260918-002",
      "at": "2026-09-18T14:20:00+08:00",
      "prompt": "此刻你如约来到旧书市集……（事件 evt-260918-002）",
      "jitter_seconds": 120,
      "respect_quiet_hours": false
    }
  ]
}
```

- 条目字段 = 现有闹钟方言的 JSON 投影：选择器四选一（`at` / `after_seconds` /
  `every_seconds` / `cron`）+ `prompt`（必填）+ `jitter_seconds` / `respect_quiet_hours` /
  `compaction` / `time_zone`；target 字段同工具方言（`target_mode` / `target_source` /
  `target_session_id` / `target_workspace_path` / `target_workspace_id` / `target_preset_id`
  / `target_provider` / `target_model`）。
- **文件级默认**：`target` / `time_zone` / `respect_quiet_hours` / `jitter_seconds` /
  `compaction` 可写在顶层作为所有条目的默认，条目内显式字段覆盖。
- **target 默认 = 文件所在 workspace**：条目与文件层都没写 target 时，按文件路径经
  workspace registry 反查（`.life/wake_schedule.json` 放在 living agent 工作区即自动指向
  它）；registry 反查不到 → 该条目报错跳过。
- `at` 推荐 RFC 3339 带显式偏移（world master 落盘时已知当天日期）。
- 上限：单文件 256 KiB、200 条、glob 命中 64 个文件、pattern 64 个。

### 同步语义（declared.ts）

- 闹钟 id：`decl_` + sha256(fileAbsPath + "\0" + entryId).hex.slice(16) —— 跨同步稳定。
- `Alarm.declared?: { file, entry, hash }`（hash = 条目归一化参数 sha256）：hash 相同 →
  完全 no-op（不重绘 jitter、不动 nextDueAt）；hash 变了 → replaceAlarm（in-flight 跳过
  本轮，下轮再收敛）；条目消失 → removeAlarm；文件缺失 → 移除该文件的 declared 闹钟
  （文件删除 = 撤销计划）；**文件存在但 JSON 解析失败 → 保留现有闹钟** + warn（不因瞬时
  读取/写坏而清空）。
- 过去的 `at`（epoch <= now）静默跳过不补火（错过即错过，world master 次日重写）；
  cron/every 条目允许（循环型声明闹钟）。
- ownerSessionId = 合成 id `declared-schedule`（合法 session-id 形态；面板设置页可见，
  会话 tab 不归属）。创建走既有 `validateCreateArgs` + `buildAlarm`（同一工厂，无第二方言）。
- 同步有变更 → `scheduler.requestDrive()`。

### 配置

- `scheduleFiles: string[]`（默认 `[]` = 功能关）：glob pattern，仅支持绝对路径 +
  `*`（单层）/ `**`（跨层）/ `?`，自实现匹配（避免实验性 fs.glob）。
- `schedulePollSeconds`（默认 60，15..3600）。
- 热更新：`proactive_update_settings` 新增 `schedule_files`（校验后写 config.json 并直接
  更新 live config；轮询每 tick 读 live config，无需重建定时器）。**不进** HotConfig /
  settings namespace schema —— settings watch 回调按 HotConfig 子集回写，schema 未声明的
  字段会被 schemastery 剥掉，进 HotConfig 会被 watch 回调 clobber。
- `schedulePollSeconds` 仅 config.json（重启生效），不进工具面。

### 工具面

- `proactive_update` / `proactive_cancel` 对 declared 闹钟返回 `invalid_action`，提示改
  源文件（声明式语义：文件是唯一真源，改了也会被下一次 sync 打回）。
- `proactive_list` / 面板正常显示；`AlarmView` 增加可选 `declaredFile` / `declaredEntry`
  （面板徽标本次不做，字段先行）。

### simulated-life 侧（零插件代码）

- `create-simulated-events` SKILL.md 增加第 6 步：写 events.json 的同时写
  `.life/wake_schedule.json`（按事件推导唤醒 + delay；作息节奏类自由规划；安静时段/预算
  注意事项；tmp+rename 原子写）。
- 新脚本 `scripts/check_wake_schedule.mjs`：校验 schema / 时间格式 / 重复 id / 未来时间，
  world master 落盘后自检。

## 实施清单

- [ ] config.ts：`scheduleFiles` / `schedulePollSeconds` 解析与钳制
- [ ] domain.ts：`DeclaredSource` 类型 + `toAlarmView` 透出 declaredFile/declaredEntry
- [ ] store.ts：`alarmIsValid` 校验 declared 形态
- [ ] declared.ts（新）：glob 匹配/展开、文件解析、diff、sync 编排
- [ ] tools.ts：update/cancel 守卫；update_settings 支持 schedule_files
- [ ] index.ts：轮询同步接线 + dispose
- [ ] test/declared.test.ts + config/tools 用例
- [ ] README / AGENTS.md 更新
- [ ] skill SKILL.md + check 脚本
- [ ] 构建 + e2e（4188 独立实例）验证；线上 config.json 启用 + 重启另行征求同意

## 验收

1. e2e 实例 config 开 scheduleFiles 指向临时 workspace，写入含 2 条（未来/过去）的
   wake_schedule.json → 60s 内 alarms.json 出现 1 条 declared 闹钟（past 跳过）。
2. 二次同步（不动文件）→ alarms.json 无重写（jitter 不变）。
3. 修改条目 prompt → 闹钟被替换；删除条目 → 闹钟消失。
4. 对 declared 闹钟调 proactive_cancel → invalid_action。
5. 文件改坏（非法 JSON）→ 现有 declared 闹钟保留 + 日志 warn。
