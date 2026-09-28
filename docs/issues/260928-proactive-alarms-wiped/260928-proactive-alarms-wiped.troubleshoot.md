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

### 2.1 第一层：alarms.json 在 9/27 15:11~16:45 间损坏 → store corrupt

- 最后一次成功 run 15:11；容器 16:45:54 重启（当前 4405 进程即该次启动）。
- 4405 启动 load 时 alarms.json 已损坏 → 内存 `corrupt=true`；18:57 persist 写出合法空文件（23 条闹钟全丢）。
- 确切凶手无日志实锤：该窗口内只有 plugin 崩溃循环记录，无新 tmp 文件。
- corrupt 标志只在内存，无法在线清除——只能重启 dsh。

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
3. **日志假象**：cordis logger 的 info/warn 不进 `/var/log/dsh.log`（只有 error 与启动 banner 落盘）——"日志无输出"不能证明任何事；要实锤需走 panel API 或进程内探针。
4. **被实验否定的假设**（避免重走）：
   - "inject 缺 workspaceRegistry 是根因"——补上后 sync 依然不建闹钟，真因是 `target_workspace_path` 残留；
   - "新校验丢弃旧闹钟"——当前代码能完整 load 9/21 快照的 23 条，排除。
5. **acquire-port 槽位**：全局槽位满时可用 `--max N` 临时扩容；收尾务必 `--release`。裸调用 `acquire-port` 会直接占槽（无确认），查看状态应用 `--list`。

## 6. 待办与风险

- [ ] 线上重启（用户书面同意）
- [ ] 重启后验证（见 validation.md）
- [ ] 凌晨 cron（luna-2am / worldmaster-5am / yu-diary）历史从未成功，恢复后首夜观察 runs.jsonl；若再 failed 用 dsh 日志抓现场
- [ ] rev workspace eligible：需用户在 GUI 打开 rev 会话说一句话，否则 resume 心跳会继续 "no eligible session" skip
