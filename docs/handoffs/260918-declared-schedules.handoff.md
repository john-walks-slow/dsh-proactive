# 260918 声明式闹钟文件（world master 规划 proactive 唤醒）交接

## 需求与决策

用户需求：让 world master（create-simulated-events skill 的世界演化角色）能为 living
agent 规划 proactive 唤醒时间。初步两方案：

1. events.json 加唤醒参数、proactive 读 `.life` 文件 —— **否决**：通用插件耦合
   simulated-life 私有 schema，且唤醒需求不总与事件一一对应。
2. proactive 支持"时间表文件触发" + skill 指导 world master 产出时间表 —— **采纳**，
   具体化为通用「声明式闹钟文件（declared schedules）」功能；用户确认先不做 GUI 面板徽标。

关键仓库：
- `/root/projects/dsh-proactive`（live profile link 到 `packages/dsh-proactive`，`lib/` 为构建产物）
- `/root/.agents/skills/create-simulated-events`（**非 git 仓库**，改动直接落盘）
- 计划文档：`docs/features/260918-declared-schedules/260918-declared-schedules.plan.md`（含设计+验收清单）

## dsh-proactive 改动（已提交 f43223c，工作区干净）

- **`src/declared.ts`（新，核心）**：`config.scheduleFiles` glob 展开（自实现
  `*` 单层 / `**` 跨层（`**/` 匹配零层）/ `?`，无新依赖）→ schedule JSON 解析（文件级
  `target`/`time_zone`/`respect_quiet_hours`/`jitter_seconds`/`compaction` 默认 + 条目
  覆盖 + 嵌套 target 拍平成 target_* 方言）→ 条目走 `validateCreateArgs`/`buildAlarm`
  **同一工厂**（无第二方言）→ 稳定 id `decl_<sha256(file\0entry)前16hex>` + spec hash
  幂等 diff 同步。owner=`declared-schedule`，`Alarm.declared={file,entry,hash}`。
- **失败语义**（务必保持）：文件读坏/JSON 坏 → **保留**现有闹钟（transient 不炸计划）；
  条目存在但准备失败（target 解析失败/closed validation/过去 at）→ 保留既有同 id 闹钟
  （keptIds）；条目删除/文件删除/功能关 → 移除对应闹钟；in-flight 永不动；过去 `at`
  跳过不补火；target 缺省 = **文件所在 workspace**（dirname 经 resolveWorkspaceArg 反查）。
- **`config.ts`**：`scheduleFiles`（默认 `[]`=功能关，parseScheduleFiles 容错钳制，
  MAX_SCHEDULE_FILES=64）、`schedulePollSeconds`（60，15..3600）。
- **`tools.ts`**：`proactive_update`/`proactive_cancel` 对 declared 闹钟拒改
  （invalid_action，提示改源文件——文件=唯一真源）；`proactive_update_settings` 新增
  `schedule_files`（热生效）。AlarmView/settingsView 增加 declaredFile/declaredEntry/
  schedule_files。
- **关键坑（勿回退）**：`schedule_files` **不进 HotConfig**——settings namespace schema
  未声明该字段，watch 回写会剥掉它再 clobber 回 undefined；热更只能走
  proactive_update_settings 直改 `config.scheduleFiles`（轮询每 tick 读 live config）。
- **`index.ts`**：`startDeclaredScheduleSync` 接线（首轮立即同步 + 轮询，mutated 时
  requestDrive），dispose 清理。
- **`store.ts`**：alarmIsValid 校验 declared 形态（file/entry/hash 三元全字符串）。
- **测试**：298/298 全过（新增 test/declared.test.ts：glob/解析/幂等/失败语义/工具守卫）。
  `npm run build` 完成，client bundle `node --check` 过。

## skill 改动（create-simulated-events，零插件代码）

- SKILL.md：新增「主动唤醒时间表（wake_schedule.json）」节 + 工作流改 6 步（原 5 步+
  写 schedule）。指导按事件推导唤醒、作息节奏自由规划、安静时段注意、tmp+rename 原子写。
- `scripts/check_wake_schedule.mjs`：落盘自检脚本（schema/时间格式/重复 id/未来时间），
  好/坏例均已实测（exit 0 / exit 1）。

## wake_schedule.json 格式（给 world master / 调试用）

```json
{
  "version": 1,
  "target": { "workspace_path": "/root/agents/yu" },
  "entries": [
    { "id": "evt-260918-002", "at": "2026-09-18T14:20:00+08:00",
      "prompt": "此刻你如约来到旧书市集……", "jitter_seconds": 120 }
  ]
}
```
条目字段 = proactive_set 方言 JSON 投影（at/after_seconds/every_seconds/cron 四选一 +
prompt 必填）；文件级默认可提 target/time_zone 等；条目/文件层都不写 target 时默认指向
文件所在 workspace。

## 验证

- 单测 298/298；`npm run check`/`npm run build` 干净。
- e2e（4188 隔离实例 /root/.dsh-e2e，token e2etest）全过：首轮同步创建 declared 闹钟
  （past 跳过、target 解析正确）；改 prompt → 替换不重复；重启自愈；删文件 → 闹钟移除。
  **已全部清理**（e2e config 还原、/tmp/decl-e2e fixture 删、实例杀掉）。
- 坑：4188 被旧实例占用时新实例 EADDRINUSE 崩，但 proactive 先于 webserver apply，
  崩溃前已完成首轮 sync 写入——勿误判为旧实例所写。

## 当前部署状态

- 线上 `/root/.dsh/proactive/config.json` 已写入
  `"scheduleFiles": ["/root/agents/*/.life/wake_schedule.json"]`。
- **新代码尚未生效**：lib/ 已构建完毕，但 4175 线上实例需重启才加载（用户选择"只写配置
  不重启"）。下次 dsh 自然重启自动生效；生效前 world master 先写 schedule 文件无害，
  重启后首轮轮询即同步。
- skill 与校验脚本即时生效（按 session 加载读盘）。

## 待办 / 开放问题

1. **interval 心跳降频（已给建议，待用户拍板执行）**：现网 2 条 7200s（2h）+ 1 条
   14000s 心跳偏密。建议：保留 1 条/agent 降频到 4~6h、respect_quiet_hours=true、
   prompt 保持 heartbeat 静默语义；wake schedule 接管"世界节奏"（叙事同步），interval
   退守"生理节奏兜底"（world master 失败时 agent 不全静默 + 自发行为）。02:00/22:00
   cron 观察 1-2 周再定是否迁进 schedule；**05:00 world master cron 永不迁**。
2. 用户说"稍等"——为 yu 写第一份 `.life/wake_schedule.json` 示例（启用后 60s 内真实
   创建闹钟），等用户发话。
3. feature docs 的 validation.md / review.md / summary.md 未写（plan.md 已有）。
4. GUI 面板 declared 徽标（来源文件/条目显示 + 禁用编辑按钮）用户选了暂不做，字段已
   预留在 AlarmView。
5. 如需发布 npm/GitHub：走 before-publish-repo + dev-dsh-plugin 的发布流程（README
   已含新功能章节）。

## 相关文件速查

- 功能源码：`packages/dsh-proactive/src/declared.ts`
- 计划文档：`docs/features/260918-declared-schedules/260918-declared-schedules.plan.md`
- skill：`~/.agents/skills/create-simulated-events/SKILL.md` +
  `~/.agents/skills/create-simulated-events/scripts/check_wake_schedule.mjs`
- 线上配置：`/root/.dsh/proactive/config.json`；线上数据：`/root/.dsh/proactive/alarms.json`
