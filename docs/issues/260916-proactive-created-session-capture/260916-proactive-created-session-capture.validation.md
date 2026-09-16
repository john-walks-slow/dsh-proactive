# workspace/preset 闹钟捕获 proactive 自建会话 — 用户验证

## 验证说明

- 验证对象：`target_mode: workspace` / `target_source: workspace|preset`（resume）的 proactive 闹钟不再唤醒到本插件自己创建的会话（new 产物、fork 子会话）；无合格会话时跳过本次触发（不新建、不重试、不占预算/hourly cap）；用户在 new 产物里发过消息后该会话重新成为合格目的地。
- 环境/前置条件：
  - 修复已部署：web profile `node_modules/dsh-proactive`（symlink 直连工作区 `packages/dsh-proactive/lib`）已同步新构建、dsh 已重启（重启会中断会话，安排时机注意；需用户书面同意）
  - 观察入口：`$DSH_HOME/proactive/state.json`（`createdSessions` 记账）、`$DSH_HOME/proactive/runs.jsonl`（`decision`/`note`/`sessionId`）、`/var/log/dsh.log`（`dsh-proactive: …`）、会话日志（唤醒回合落点）
- 单测：275/275 通过（`npm test`）。关键覆盖：`store.test.ts` 记账持久化/幂等/cap/容错读；`workspace.test.ts` `createdSessionEligible` 纯函数 + live/cold 剔除/豁免/fork/only-created→none；`target-v3.test.ts` preset resolver 剔除/豁免 + preset-resume skip + new+workspace 记账断言；`wake.test.ts` workspace skip + new+workspace attach 失败仍记账 + fork 记账；`scheduler.test.ts` skip outcome（once→completed/every→advance/不烧 hourly cap/不重试）。

## 验证项

| # | 验证步骤 | 预期结果 | 实际结果 | 状态 | 备注/证据 |
| --- | --- | --- | --- | --- | --- |
| 1 | 核心回归：`proactive_set target_mode=workspace target_workspace_path=<含用户会话的工作区> after_seconds≈60`，触发 | 落在该工作区的**用户会话**（非本插件产物），`runs.jsonl` 该次 `decision` 为 `reply`/`no_reply` 之一，`sessionId` 不在 `state.json.createdSessions` 里 | | 待验证 | 与"捕获产物"的旧行为形成对照 |
| 2 | 捕获修复：先触发一个 `target_mode=new target_workspace_id=<同工作区>` 闹钟（产物落该工作区、无人输入），紧接触发 #1 的 workspace 闹钟 | workspace 闹钟落在用户会话（或若无其他用户会话则 `decision:"skipped"`），**不落在新产物上**；`state.json.createdSessions` 含 `{kind:"new", sessionId:<产物>}` | | 待验证 | 核心验收 |
| 3 | 重启后 cold 剔除：#2 后重启 dsh（产物变 cold），再触发一个 workspace 闹钟 | 仍不落在产物（cold 缓存行 `lastPromptAt:null` → 剔除）；落在用户会话或 skip | | 待验证 | cold 投影缓存路径（host 真实形状） |
| 4 | 真人豁免：在 #2 的新产物会话里发一条真人消息，再触发 workspace 闹钟 | 落在产物（豁免生效，`lastPromptAt!=null`） | | 待验证 | 正向豁免路径 |
| 5 | fork 永不豁免：触发 `target_mode=fork target_source=workspace`（fork 子会话继承真人历史），紧接 workspace 闹钟 | 不落在 fork 子会话（`kind:"fork"` 无条件剔除），即使用户在 fork 子里发过消息 | | 待验证 | fork 继承历史不可判别 |
| 6 | skip 不烧预算/cap：工作区只有产物会话（或 preset 无会话跑）时触发 | `runs.jsonl` `decision:"skipped"`、`budgetDelta:0`、`note` 含 "no eligible session"/"no session is running preset"；once→`completed`、every→下一锚点；同窗口另一 ok 闹钟照常触发（不被 hourly cap 挡） | | 待验证 | scheduler skip 分支 |
| 7 | preset skip：`target_source=preset target_preset_id=<无会话跑的 preset>` 闹钟触发 | `decision:"skipped"`、`note` 含 "use target_mode new with target_preset_id" | | 待验证 | preset resolver none → skip |
| 8 | 面板可见性：设置页 → 已完成/历史 → skip 的 run 行 | 显示 `skipped` 决策文案（`decisionSkipped` locale） | | 待验证 | 面板 RunView |

## 覆盖缺口（如实记录）

- **E2E 隔离实例装配未跑通**：`DSH_HOME=/tmp/e2e-dsh-home`（端口 4599，profile e2e）上 proactive 面板 HTTP 路由 404、数据目录不写盘——插件未在该实例装配（非本改动引入，dsh 0.1.2-rc.1 升级相关，见 troubleshoot.md）。故 #3（cold 投影缓存真实形状）、#6（真实调度器 skip）的真实 host E2E 未做，以单测 fixture（真实 SessionEvent 形状）覆盖为准。
- **生产实例**（端口 4175）仍运行旧 host 侧代码，修复需用户书面同意重启 dsh 后生效。

## 验证结论

待验证（部署+重启后由用户执行 #1–#8）。

## 待跟进

- E2E 隔离实例 proactive 装配修复（`installPanelRoutes` 取 `webServer` 的方式在 0.1.2-rc.1 下的适配）另立排查。
