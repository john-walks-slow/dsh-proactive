# 260102-proactive-not-firing 收尾小结

> 撰写：2026-10-09。本文是 `99-overview.md`（缺陷根因）之后的总收尾。
> 前半段（10/02 的三个缺陷）见 `99-overview.md`；`master` 分段见 `30-compaction-contract-drift.md`。

## 现象与真实状态（2026-10-09 实测）

用户报「很久没收到 agent 们的主动消息」。实测：

- 最后一条**成功**的主动唤醒：`2026-09-25 09:07 CST`（reply），此后 `decl_*` 闹钟 0/100。
- 最后一条 run 记录：`2026-10-02 02:01 CST`，之后 `runs.jsonl` 整整 7 天没有新行。
- `GET /api/dsh-proactive/state` → **404**；本会话 `proactive_*` 工具全部缺席（同期其它 link 插件工具都在）。

## 根因链（三层叠加，缺一不可）

1. **10/01 18:39 关了总闸**：`/root/.dsh/proactive/config.json` → `enabled: false`。10/02 排障时为了「修好前不刷屏失败」刻意关的，之后一直没打开。
   `apply()` 在 `!config.enabled` 时**提前 return**（`src/index.ts:84`），在注册工具/面板路由/调度器之前 —— 所以面板 404、工具不存在，从 GUI 上完全看不出「已被关闭」。
2. **10/07 14:16 升级 dsh 到 0.2.0-rc.2**：插件 peerDependencies 不匹配，启动时被 `skipping profile bundle` 跳过（日志里连续 3 次）。
3. **10/07 17:07 提交 9ec11e6 适配 0.2.0-rc.2** 后兼容恢复；**10/08 19:08 重启**时插件已能加载 —— 但总闸仍是 `false`，于是插件加载后立刻 return，静默无动作。

## 本次实际改动

| 事项 | 内容 |
|---|---|
| compaction 契约漂移 | `test/compact.test.ts` 有 3 条红了 16 天的断言，编码的是平台 0.1.5 起已不可表达的「eraser」设计（b19a33b 改了实现却没改测试）。对齐测试到 user notice 契约、删除死代码 `eraserMessage`/`eraserProvenance`、同步模块 AGENTS.md 与文档文案（详见 `30-compaction-contract-drift.md`） |
| e2e 能力补齐 | 新增 `e2e/wake-smoke.mjs` + `npm run e2e:wake`：经面板 API 建两类闹钟，断言真实唤醒链路的 runs 决策与会话日志里的 tombstone/notice 替换 |
| 开闸准备 | `config.json`：`enabled: true` + `bootOverduePolicy: "drop"`（逾期快进，避免 5 个闹钟同时补发、把「凌晨 2 点」的 prompt 在下午放出来）；备份 `config.json.bak-2601009-before-enable` |

## 验证证据

- 单测：`test/compact.test.ts` 13/13（改前 10/13）；全量 **312/312**；`tsc` 0 错；`build` 通过且 `lib/` 已无死代码。
- E2E（隔离实例，dsh 0.2.0-rc.2 真实 agent 链路）：**9/9 通过**。
  - `new` 模式静默唤醒：`no_reply`，会话日志里**确实落地** tombstone replace 与 notice replace（压缩真的生效，不是被 catch 后静默 warn）。
  - 冷 `resume` 唤醒：`reply`，`replySummary=resume-ok`。
- 线上整树加载验证（共享 `DSH_HOME` 的临时实例，仅验证加载、不驱动任何 turn）：启动稳定，无 `plugin tree failed to load` / `ERR_MODULE_NOT_FOUND`；临时实例已停、无残留 `.credentials.yaml.lock`。

## 尚未完成（需用户点头）

- **线上重启 dsh**：改动已就位（`lib/` 已重建、config 已改），但重启会中断当前会话，按 restart-dsh 红线必须每次单独取得用户书面同意 —— 本次已申请，等待同意。

## 已发布（2026-10-09）

- **npm `dsh-proactive@0.2.4`**（`latest`）与 **GitHub `main` + tag `v0.2.4`** 已发布：包含 9ec11e6 的 dsh 0.2.0-rc.2 适配与本次 compaction 契约修复 —— 此前 npm 上的 0.2.3 在 dsh 0.2.0-rc.2 上会被 loader 的 peer 检查**跳过**，即 npm 用户其实拿不到能用的 proactive。
- tarball 已补 `README.en.md`（原先漏在 `files` 外），四个 README 都补了 **dsh 版本要求**（0.2.0-rc.1+ 用新版；0.1.x 用 0.2.3）。
- 验证：scratch profile 装 tgz 与装 registry 版各一次，layer 出现 + `apply` 可导入；`npm view version` 轮询到 0.2.4。
- 注意：本仓库 `npm run release` 里的 `npm version patch` **不会**提交或打 tag（包位于 git 仓库子目录、仓库根无 package.json 时 npm 只改 package.json，已用最小复现确认）——发版必须手动 `chore(release)` 提交 + `git tag -a`，再 `git push --follow-tags`。

## 遗留

- `world-master` 的 `world-evolution-5am` 仍无法注册：`/root/agents/world-master` 不在 DSH 工作区注册表里，declared 同步解析 `workspace_path` 失败（713d2b7 之后至少会打 warn）。
- 逾期快进后应把 `bootOverduePolicy` 改回 `fire`。
- `scheduler.test.ts` 安静时段边界用例并发全量跑偶发失败（单跑稳定）。
