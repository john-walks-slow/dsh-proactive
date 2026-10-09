# 261009 文件表闹钟（第四种闹钟类型）— 总结

## 做了什么

把「宿主配 glob 自动读取工作区文件」的声明式闹钟（260918）改造成**第四种闹钟类型**：`proactive_set(schedule_file="<绝对路径>")` 创建一个 file 类型闹钟，它自身永不触发，只作为该 JSON 时间表文件的**句柄**，把文件条目物化成 `declared={file,entry,hash,sourceId}` 子闹钟。全局 `config.scheduleFiles` 与 `proactive_update_settings.schedule_files` 一并删除。

关键设计（含专家预审 6 项修正，全部落实）：

- **句柄即订阅**：暂停 → 子闹钟移除；恢复 → 按当前文件重新派生（子 id 由 canonicalFile+entry 稳定派生，runs 历史连续）；取消 → 连带子闹钟（持久化失败整组回滚，工具与面板同语义）。
- **路径规范化**：`resolve` + 去尾斜杠 + 目录 `realpath`，规范形式同时进 store 与子 id——两种写法不会变成两个句柄、两套 id、双触发；同文件重复创建 → `invalid_action`（报已有 id）。
- **严格 target 缺省**：无 `target_*` 时只认「文件的祖父目录是已注册 workspace」（`<workspace>/<目录>/<文件>`），否则闭式报错；**不做逐级上溯**（本机 `/root` 本身是工作区，上溯会静默指错会话）。
- **`target` 整层选取**（条目 > 文件顶层 > 句柄），标量键 key-wise 覆盖——避免 260928 的残留键合并 bug 类。
- **单一串行同步链** `enqueueSync()`：轮询 tick 与工具/面板的即时同步共用，两趟不会并发写重复闹钟；apply 阶段复检句柄仍在且 scheduled，cancel/pause 竞态不会复活孤儿子闹钟。
- **失败语义**：文件 ENOENT = 撤销计划（子闹钟移除，句柄保留）；读坏/JSON 坏 = 保留现有子闹钟；`sourceId` 不指向活跃句柄 = 孤儿移除（也是 260918 迁移路径）；hash 未变完全 no-op（保住 jitter 锚点与 min_idle defer）。
- **`firesAlarm(type)` 唯一判据**：dueAlarms/arm 跳过、`toAlarmView` 不判 overdue、面板 fire 拒绝。
- **面板**：第 4 种创建类型；一行句柄（`scheduleFile` + `declaredEntries`），子闹钟 runs 按 `sourceId` 折叠到句柄行；`server.sync` 摘要 + 悬停看错误；前端即时校验绝对路径/无 glob。
- **迁移（0.2.x → 0.3.x）**：旧 `decl_*` 记录由首轮同步**领养**，不再当孤儿清掉——apply 阶段对同 id 记录（`declared` 存在，或 0.2.x 最早的 pre-provenance 形态：owner `declared-schedule`、无 `declared`）按 id 重指向当前句柄并替换；孤儿规则只在「不在本轮 desired/keptIds 且 sourceId 不指向活跃句柄」时生效（顺序写反会导致领养后当场删除——离线预演抓到，已修 + 回归用例）。**该修复随 0.3.1 发布**（0.3.0 npm 产物带此缺陷，务必升级）。配套脚本 `scripts/migrate-schedule-files.mjs`（repo 内、不随 npm 发布）在停 dsh 期间为每个 `scheduleFiles` 文件写一个句柄。离线预演结果（线上真实 store + 4 个文件副本）：`handles=4 +0 ~6 -0 skippedPast=0 errors=0`，6 条子闹钟 id 与迁移前逐条相同、唤醒零中断。**不可回滚到旧 lib**（旧 `ALARM_TYPES` 不认 `type:"file"` → 整店 corrupt → 启动即 persist 清空）；重启前已备份 `alarms.json.bak-261009`。

## 验证证据

- `npx tsc -p tsconfig.json --noEmit` 通过；`npm test` **346/346** 全绿（含新增 `schedule-file.test.ts` / `schedule-sync.test.ts`，重写删除 `declared.test.ts`，tools/panel 各新增句柄用例）。
- e2e（真实 host + 面板 API + 真实轮询 tick，无模型回合）：`npm run e2e:schedule-file` **16/16**，覆盖创建/子闹钟落盘/重复拒绝/fire 拒绝/改条目替换/暂停清空/恢复重派生/删文件撤销/空计划句柄存续/同步摘要。
- reviewer 检视（`261009-file-alarm-type.review.md`）：**准入**，0 阻塞；3 条建议中 S1（前端路径即时校验）、S2（跳过原因进 `summary.errors`）已实现，S3/N1/N2 保持现状。
- 发布前隔离安装：`DSH_HOME=/tmp/pp-home dsh plugin --profile scratch add dsh-proactive-0.3.0.tgz` 成功，产物含 `lib/schedule-file.js` / `lib/schedule-sync.js` 且无旧 `declared.js`。

## 发布

- 提交：`668f1e7 feat(proactive): schedule-file alarms as the fourth alarm type` + `d484fbd chore(release): bump dsh-proactive to 0.3.0`，tag `v0.3.0`，已 `git push --follow-tags`。
- npm：`dsh-proactive@0.3.0` 已发布（webauthn 指纹授权；registry 直读有 1~2 分钟陈旧缓存，以 `registry.npmjs.org/dsh-proactive/0.3.0` 与复发的 403 "already published" 为准）。

## 线上部署状态与后续

1. 构建产物已随硬链接同步到 `/root/.dsh/profiles/web`（**host 侧需重启生效**，重启会中断当前会话 → 等用户同意）。
2. 重启后**立即**为 4 个文件建句柄（每个显式传 target）：`/root/agents/{luna,rev,yu,world-master}/.life/wake_schedule.json`，随后校验子闹钟数 = 6、`/api/dsh-proactive/state` 无 corrupt。
3. `config.json` 的旧 `scheduleFiles` 键已删除；`schedulePollSeconds` 保留。
4. world master（create-simulated-events skill）已改为「`proactive_list all=true` 查缺 → 显式传 target 建句柄 → 每天只重写 `wake_schedule.json`」，并写明原子写契约。

## 事故与修复（透明记录）

发布前用 `dsh plugin --profile web add <tgz>` 做隔离安装验证时漏了 `DSH_HOME`，把 tgz 写进了**线上 profile** 的 `package.json`（`link:…` → `file:/tmp/…tgz`）。已把依赖声明改回 `link:/root/projects/dsh-proactive/packages/dsh-proactive`，`pnpm install --lockfile-only` + `--frozen-lockfile` 复原 lockfile 与 node_modules，并逐项校验 profile 的全部 dependencies 与 bundles 均可解析（ALL DEPS RESOLVE）。教训已写入记忆：隔离验证必须 `DSH_HOME=/tmp/<scratch> dsh plugin --profile <fresh> add`。
