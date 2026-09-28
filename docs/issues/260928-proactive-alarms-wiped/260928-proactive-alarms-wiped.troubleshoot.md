# 排查诊断：线上 proactive 闹钟全量停摆（rev/luna/yu/worldmaster 数日静默）

- 问题编号：`260928-proactive-alarms-wiped`
- 日期：2026-09-28
- 状态：已确诊并修复（commit `7ede18d`），待线上重启生效

---

## 1. 现象描述

用户报告 rev、luna 好几天没有主动说话。排查 runs.jsonl 与 alarms.json 确认闹钟全量停摆：

| 闹钟 | 模式 | 最后成功 | 状态 |
|---|---|---|---|
| rev-heartbeat | resume | 9/24 09:56 | 9/23 起大量 "no eligible session" skip |
| luna-heartbeat | resume | 9/20 | 之后被 paused |
| luna-2am | cron 0 2 * * *（new） | 从未 | 每次失败 ×3（drive 阶段，日志已滚掉） |
| worldmaster-5am | cron 0 5 * * *（new） | 从未 | 同上 |
| yu-diary | cron 0 22 * * *（fork） | 9/22 | 之后停 |

其余闹钟（含 yu-heartbeat 等）随 9/27 alarms.json 损坏全量丢失。且线上实例（127.0.0.1:4180，pid 4405）proactive store 处于 `corrupt=true`，所有 mutation 报 `corrupt_store` 拒绝执行。

## 2. 根因分析（三层叠加）

### 2.1 第一层：alarms.json 在 9/27 15:11~16:46 间损坏 → store corrupt → 启动 persist 覆盖清空

有时间戳的完整时间线（supervisord.log + 会话取证，9/28 复盘补全）：

| 时间 (CST) | 事件 | 证据 |
|---|---|---|
| 9/25 21:28 | 生产 dsh（pid 23390）启动，正常 load 23 条闹钟 | supervisord.log |
| 9/27 15:11:15 | 最后一次 run（skip）；skip 路径 advancePast → persist，文件此刻合法 | runs.jsonl mtime + scheduler.ts:305 |
| 15:20~15:23 | live-mode agent 用隔离 home（/tmp/dsh-min）起 4199 测试实例又 pkill（精确匹配 4199，不碰生产） | session ff2aa236 |
| 15:26:53 | ps 确认生产 23390 存活（当时手机并发 3~4 个 dsh 实例，各 200~430MB RSS，8GB 机型） | session ff2aa236 内 ps 输出 |
| **16:38:47** | **生产 dsh 被 SIGKILL（not expected）；窗口内无任何 agent kill 命令 → 系统级（疑似 OOM/LMK）** | supervisord.log |
| 16:38:53 | supervisord 拉起 7833；其 recoverInFlight **无条件 persist**（writeFile+rename，无 fsync） | scheduler.ts:115 |
| **16:41~16:45** | **Android 整机重启（pid 1 init 16:45:30；uptime 吻合）——非正常关机** | ps lstart + /proc/uptime |
| 16:46:04 | 4405 启动，load alarms.json → corrupt=true → **空 store**；recoverInFlight 启动 persist 把文件覆盖成合法空文件（清空实锤；18:57 还有一次空 persist，触发源未定位） | index.ts:91 + scheduler.ts:115 |
| 19:00~22:12 | 重启后 live-mode agent 起 25010/25000/25001（全部隔离 home） | ps + 租约 |

损坏机制推断（文件已被覆盖，无法尸检，置信度中等偏高）：persist 是 `writeFile(tmp)+rename` **无 fsync**（store.ts:282-288）。7833 在 16:38:53 的启动 persist 距非正常关机仅 3~7 分钟，极端内存压力下 writeback 延迟——rename 元数据落盘而数据块丢失，f2fs 恢复后文件损坏/清零。备选：15:11 的写入同样受害（同类无 fsync 缺陷，87 分钟旧，概率较低）。

**e2e 实例排除（用户疑点，已穷尽排查）**：9/25 21:00~9/27 16:46 全部 16 个活跃会话零次提及 alarms.json；live-mode/验证实例 home 全部隔离（/root/.dsh-e2e、/root/.dsh-e2e-vc、/tmp/dsh-min、/tmp/lv-*、worktree home），无任何共享 /root/.dsh 的实例。e2e 实例**写不到**生产 alarms.json——但当天下午 3~4 个并发实例的内存压力很可能是 16:38 SIGKILL 的诱因（间接相关）。

放大器（设计层）：
1. `persist()` 无 fsync——只防进程崩溃（rename 原子性），不防掉电；
2. load 语义激进：**单条记录校验失败 / 版本不匹配 → 整店判 corrupt → 空 store**（store.ts:210-251）；
3. corrupt 后启动 persist 立即覆盖原文件——损坏现场（本可修复的 23 条数据）被销毁，且 corrupt 标志只在内存，无法在线清除，只能重启 dsh。

### 2.2 第二层：declared sync 自愈通道从未生效（本 issue 的代码 bug）

config.json 的 `scheduleFiles=/root/agents/*/.life/wake_schedule.json` 于 9/18 配置，但该文件从未被创建——自愈通道形同虚设。且即使创建了也不行：

**根因 bug（dsh-proactive 0.2.2 `src/declared.ts` prepareEntry）**：entry 携带 `target_workspace_path` 时，`resolveWorkspaceArg` 返回值已删除该键，但随后 `Object.assign(args, resolved)` 只增改键、不删键——args 中残留 `target_workspace_path` → `validateCreateArgs` 白名单校验拒绝未知键 → **所有带 workspace path 的 declared entry 全部失败，一条闹钟都建不出来**。

次要问题：world-master 目录从未注册为 workspace。`resolveByPath` 只精确匹配注册路径，`/root/agents/world-master/.life` 下的 schedule 文件即使解析成功也无法解析出 workspace。

### 2.3 第三层：各自独立的历史退化

- rev workspace 9/15 后无新活动，resume 心跳的候选会话全是归档/subagent/插件自建 → "no eligible session" skip（非 bug，需用户在 GUI 里激活 rev 会话）。
- luna-2am / worldmaster-5am（new 模式）drive 阶段失败原因待恢复后抓现场（历史日志已滚掉）。

## 3. 修复方案

1. **代码修复（commit `7ede18d`）**
   - `src/declared.ts`：`Object.assign` 后显式 `delete args["target_workspace_path"]`；
   - `src/index.ts`：inject 数组补 `"workspaceRegistry"`（resolveWorkspaceArg 实际访问的服务，显式声明）。
2. **声明式 schedule 文件**：创建 4 个 `wake_schedule.json`（rev/luna/yu/world-master 的 `.life/` 目录），共 6 entries，prompt 取自 9/21 快照（`alarms.json.tmp.20722.*` 备份）的原始定义：
   - rev-heartbeat（every 7200 + jitter 3600，resume）
   - luna-heartbeat（every 14000 + jitter 7000，resume）
   - luna-midnight-free（cron 0 2 * * *，new）
   - yu-heartbeat（every 7200 + jitter 3600，resume）
   - yu-diary-10pm（cron 0 22 * * *，fork）
   - world-evolution-5am（cron 0 5 * * *，new）
3. **workspace 注册**：world-master 目录注册为 workspace（此前从未注册）。
4. **线上重启**：待用户书面同意（restart-dsh skill），重启后 corrupt 清除 + 6 闹钟 load + 新 lib 生效。

## 4. 验证

独立端口临时实例（25003，同一 profile + 修复后 lib）实测：

- 6 个 declared 闹钟全部同步创建（decl_b20c5153 / decl_830c7423 / decl_6c725185 / decl_ad5ec122 / decl_526aea69 / decl_05de6864），status 全部 scheduled；
- 闹钟 nextDue 正确计算（rev-hb 05:43 / yu-hb 06:00 / luna-hb 08:47 UTC）。

线上验证项见 validation.md。

## 5. 排查弯路与经验

1. **build workdir 错误**：`npm run build` 曾两次误在 `/root/projects/dsh-im-humanize` 执行（该仓库无本修复源码，等价重建、无害但白费）；正确 workdir 是 `/root/projects/dsh-proactive/packages/dsh-proactive`。
2. **RPC 探针错误路径**：`/api/workspace/list`、`/api/proactive.alarms.list` 均为 404/unauthorized 错误路径；正确路径是 panel route `GET /api/dsh-proactive/state`。认证流程：先 `GET /?token=<token>` 换 dsh-auth cookie；临时实例的 token 在其启动 banner 里。
3. **日志假象**：cordis logger 的 info/warn 不进 `/var/log/dsh.log`（只有 error 与启动 banner 落盘）——"日志无输出"不能证明任何事；要实锤需走 panel API 或进程内探针。**连带教训：dsh.log 无时间戳，按行号位置给错误断代不可靠**——本次曾把旧进程代的 dsh-wait-subagent 崩溃错误误判到损坏窗口内，后被 supervisord.log（有时间戳）纠正。排障一律优先用带时间戳的日志源。
4. **被实验否定的假设**（避免重走）：
   - "inject 缺 workspaceRegistry 是根因"——补上后 sync 依然不建闹钟，真因是 `target_workspace_path` 残留；
   - "新校验丢弃旧闹钟"——当前代码能完整 load 9/21 快照的 23 条，排除。
5. **acquire-port 槽位**：全局槽位满时可用 `--max N` 临时扩容；收尾务必 `--release`。裸调用 `acquire-port` 会直接占槽（无确认），查看状态应用 `--list`。

## 6. 待办与风险

- [ ] 线上重启（用户书面同意）
- [ ] 重启后验证（见 validation.md）
- [ ] 凌晨 cron（luna-2am / worldmaster-5am / yu-diary）历史从未成功，恢复后首夜观察 runs.jsonl；若再 failed 用 dsh 日志抓现场
- [ ] rev workspace eligible：需用户在 GUI 打开 rev 会话说一句话，否则 resume 心跳会继续 "no eligible session" skip

## 7. 防复发加固建议（本次复盘产出，待排期）

1. **persist 加 fsync**（store.ts）：`writeFile(tmp)` → `fsync(fd)` → `rename` →（可选）目录 fsync——真正防掉电损坏； scheduler 的 "crash-window" 注释只考虑了进程崩溃。
2. **corrupt 时禁止覆盖性 persist**：load 判 corrupt 后应先把损坏文件改名备份（如 `alarms.json.corrupt-<ts>`）再以空 store 运行，或 corrupt 状态下完全拒绝写盘——保住现场可手工恢复。
3. **并发实例内存护栏**：8GB 手机上 3~4 个 dsh 实例（各 200~430MB）即逼近 OOM；临时 spike（如 4199 直连端口）应同样走 acquire-port 槽位约束。
