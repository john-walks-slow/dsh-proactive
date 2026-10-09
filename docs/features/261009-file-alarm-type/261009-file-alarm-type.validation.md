# 文件表闹钟（261009）用户验证

## 验证说明

- 验证对象：把「宿主配置 glob 自动读取工作区文件」改成**第四种闹钟类型**（`schedule_file` 句柄 → 子闹钟同步），并删除 `config.scheduleFiles` / `schedule_files` 设置项。
- 环境/前置条件：
  - 单元测试与 e2e（data plane，无真实模型回合）已在本机跑通：`npm run check`、受影响用例、`npm run e2e:schedule-file`（16/16）。
  - 线上验收需要**重启 dsh**（host 侧改动，会让本会话中断）→ 已由用户同意后执行；重启前已备份 `$DSH_HOME/proactive/alarms.json` 为 `alarms.json.bak-261009`。
  - **本次变更不可回滚到旧版本**（旧代码不认 `type:"file"`，会把整店判 corrupt 并清空），回退必须先停 dsh 再恢复备份。

## 验证项

| 验证步骤 | 预期结果 | 实际结果 | 状态 | 备注/证据 |
| --- | --- | --- | --- | --- |
| 重启后打开 GUI 设置页「主动唤醒」，看闹钟表格 | 出现 4 行类型为「文件表」的句柄（luna / rev / yu / world-master），每行显示文件路径与子条数（合计 6 条） | | 待验证 | 句柄由迁移步骤 3 建成；子条数在行内 type 徽标下方 |
| 点开任一句柄行的「历史」 | 子闹钟的唤醒历史折叠显示在该句柄行下（不再出现独立的子闹钟行） | | 待验证 | runs 按 `sourceId` 归并 |
| 面板新建一个「文件表」闹钟并填一个临时 JSON 路径，然后在保存的同时点「立即触发」 | 新建后立即出现子条数；「立即触发」对该行报错（句柄自身永不触发） | | 待验证 | |
| 次日检查 world master 的 05:00 演化回合 | 正常触发（该 cron 条目来自 `world-master/.life/wake_schedule.json`，句柄迁移后应照旧生效） | | 待验证 | 迁移前 3 条 declared 会在首轮同步被清、随后由句柄重新派生，id 不变 |
| 修改 `yu/.life/wake_schedule.json` 里的一条条目（如改 prompt） | 60 秒内面板该句柄子条数不变，子闹钟被替换（历史里那条 alarm 仍是新 spec） | | 待验证 | 文件为唯一真源 |

## 验证结论

待验证。

## 待跟进

- 若重启后 4 个句柄中任何一个的子条数与预期不符（luna 2 / rev 1 / yu 2 / world-master 1），先在面板查看 `server.sync` 摘要（设置页闹钟表头右侧 `文件表同步: hN +a ~b -c errN`，鼠标悬停可看错误详情）。
- `config.json` 里的旧 `scheduleFiles` 键已手动删除；`schedulePollSeconds` 保留（文件表轮询周期）。
