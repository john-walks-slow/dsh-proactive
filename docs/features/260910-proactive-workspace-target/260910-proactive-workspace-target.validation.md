# 260910-proactive-workspace-target 验证

## 验证说明

- 验证对象：`target_mode: workspace`（第 4 种目标类型）——fire 时投递到工作区最近更新的可见会话；无可见会话复用最新空白 New Session 槽；都没有则在工作区内新建会话（先 attach 后投递）。含工具/面板两条创建路径与两处 dsh 0.1.2-rc.1 升级回归修复。
- 环境：隔离 E2E 实例（`DSH_HOME=/tmp/e2e-dsh-home`，端口 4599，profile e2e，包 symlink 指向工作区 packages/dsh-proactive），dsh 0.1.2-rc.1 host。浏览器验证用 camoufox。
- 单测：225/225 通过（新增 liveEventsOf 兼容读、live fold 跨 Session 两个版本排序、sessionLogOf 既有兼容测试）。

## 验证项（E2E，全部实际执行）

| # | 验证步骤 | 预期结果 | 实际结果 | 状态 |
|---|---|---|---|---|
| 1 | 模型工具创建（round 9）：owner 会话 `proactive_set target_mode=workspace target_workspace_path=/tmp/e2e-ws/alpha after_seconds≈90`，触发 | 工作区无可见会话 → 新建会话（cwd=工作区路径）+ attach 后投递，模型回复 ok | 新建 session-a052da44（cwd /tmp/e2e-ws/alpha），storages/workspace.json 记录 attach，模型回复 "ok"，GUI 侧边栏 alpha 分组出现该会话 | ✅ |
| 2 | 收敛投递（round 10）：同一工作区再触发一个闹钟 | 不再新建：落在同一 session-a052da44（此时它是最近更新的可见会话） | 落在 session-a052da44，模型回复 "ok2"，无新会话 | ✅ |
| 3 | GUI 创建：设置页 → 主动唤醒（本节在 0.1.2 host 上曾整体消失，见回归 B）→ 新建闹钟 → 目标类型选"工作区" → 下拉列出工作区（`alpha · /tmp/e2e-ws/alpha`、`e2e-dsh-home · /tmp/e2e-dsh-home`）→ 提交 | 工作区下拉数据来自 `workspaces` client service（无 HTTP RPC）；按当前会话 cwd 预选 alpha；创建成功 state=scheduled | 均通过；alarm_mtv239nmvgs83g 创建成功（mode=workspace，target=b9176204） | ✅ |
| 4 | GUI 触发 + live 分支（修复后）：GUI 新会话空白槽（live、无 .events）存在于 alpha 工作区时触发工作区闹钟 | 排序不再抛 `events is not iterable`；可见会话胜过更新的空白槽 | alarm_mtv2ibjtw59oj0 → session-a052da44，回复 "ok4"；无失败日志 | ✅ |
| 5 | 会话页 tab：打开 alpha 会话 → 主动唤醒 tab → 新建闹钟 → 目标"工作区" | 会话面板同样有工作区下拉，按本会话 cwd 预选 alpha | 均通过；面板按 owner 正确显示空列表（该会话无自有闹钟） | ✅ |
| 6 | 闹钟行展示：设置页筛选"已完成" | 工作区闹钟行显示 类型=工作区、目标=alpha（工作区标题）、所属会话标题（session/list 修复后恢复） | round9/round10 两行均正确显示 | ✅ |
| 7 | B1 判别（review 后复验）：alpha 两会话均可见——5b4c80aa（后建、先 prompt "1"）与 a052da44（先建、后 prompt "2"），触发工作区闹钟 | 落在 a052da44（旧 createdAt + 最新人类 prompt）——"最近更新"跟随最新人类活动，而非最新创建 | alarm_mtv47x5x8f832g → session-a052da44，回复 "ok5"，零失败日志 | ✅ |

## 回归修复验证（dsh 0.1.2-rc.1 升级所致，E2E 前全部修复）

| 回归 | 症状 | 根因 | 修复 | 验证 |
|---|---|---|---|---|
| A. host 唤醒全挂 | 生产 10:25 起所有 wake "wake failed ×3"（runs.jsonl） | Session 类 0.1.2-rc.1 移除 `.events` getter（0.1.1 为数组）；wake.ts 多处直接读 | `sessionLogOf` 兼容 helper（events / snapshotEvents / []）；startIndex 改 `session.seq` | E2E #1/#2/#4（全新 0.1.2 host 上跑通）；生产重启后自愈（待用户批准） |
| B. 设置页"主动唤醒"节消失 | `slots.register` 抛 `slot "settings.section" is not declared`（面板整体不挂载） | 0.1.2 中父条目 children 表声明 settings.section 变晚，直接 register 竞态失败 | 与 conversation.view 一致改用 `ctx.slots.inject("settings.section", () => register(...))` 等声明 | E2E #3（导航出现、面板渲染） |
| C. 面板会话标题消失 | state 快照 session/list 404（dot 端点） | 0.1.2 网关只认两段式 method（`session/list`）+ 严格 envelope | fetchSessionList 改 `POST /api/session/list` + `{args:{_request:{}}}` + `result.ok` 校验 | E2E #6（行内标题恢复） |
| D. 工作区 live 会话排序崩溃 | `workspace resolution failed: events is not iterable`（GUI 空白槽 live 时触发必挂） | workspace.ts live 折叠仍读 `live.events` | `liveEventsOf` 兼容读（可失败折叠为 blank）；index.ts/tools.ts 的 sessionEventsOf 同步修复（时区推导静默降级一并消除） | E2E #4 |
| E. workspace/list RPC 不存在 | 原计划面板工作区下拉走 HTTP | dsh 无此 RPC；工作区数据只能来自 client `workspaces` service | workspaces-source.ts（subscribe/getSnapshot store）+ bindSource（this 安全）+ useSyncExternalStore；exotic profile 降级为禁用+提示 | E2E #3/#5 |

## 覆盖缺口（如实记录）

- 空白 New Session 槽复用分支（GUI 空白槽被选中为目的地）：单测覆盖 pickWorkspaceTarget 排序语义；E2E 未构造"工作区只有空白槽且无可见会话"的触发场景（#4 场景中空白槽被可见会话击败，验证的是同一排序函数）。
- 模型工具默认工作区推导（proactive_set 无 target_workspace_* 时按会话 cwd）：单测覆盖 resolveWorkspaceArg 三臂；未做模型侧 E2E。
- retry 造成的孤儿会话自愈（round 5 曾见）：attach 后 header 未持久化的会话被 membership 检查剪除——设计上自愈，未重复构造。
- 生产实例（端口 4175）仍运行旧 host 侧代码：回归 A 在生产将继续表现为唤醒失败，直到用户书面同意重启 dsh（红线规则，已记录 skill + 记忆）。

## 验证结论

通过。7/7 E2E 场景 + 5 项回归修复全部验证；229/229 单测。

## Review 修复轮（260910 reviewer 准入驳回后）

| 项 | 处理 | 复验 |
|---|---|---|
| B1（阻塞）：live 折叠读 `data.time` 恒 undefined，"最近更新"退化为"最新创建" | 改读事件顶层 `time`（真实 SessionEvent `{type,seq,time,data}`，data 无 time；host applySessionListMetadata 同读法）+ last-wins 折叠精确镜像；单测 fixture 全部改真实形状 + 判别用例（旧 createdAt 新 prompt 胜）+ live/cold 混排用例 | 单测 229/229；E2E #7 判别场景（两会话真实 GUI prompt 后闹钟落 a052da44） |
| S1：resolveByPath 对已消失目录抛 ENOENT 未闭式 | resolveWorkspaceByPath 包装，ENOENT → 闭式 not_found | 新单测（ENOENT + 非 ENOENT 两臂） |
| S2：resolveSessionPreset 具名 import 在 0.1.2-rc.1（已移除该导出）会 ESM link 期炸整棵 plugin tree | 改 namespace import + 运行期守卫 + 本地等价折叠兜底（resolveSessionPresetOf） | tsc + 既有 preset 传播单测（走 upstream 分支） |
| N2：全冷工作区 + cold 列表失败 → 误 create 重复会话 | 无 live 候选 + cold 失败 → 闭式 error（走重试不重复建） | 新单测 |
| N4：zone.ts clientTimeZoneOf 读顶层 `event.source`（真实在 data.source）从未命中——浏览器时区推导一直静默降级 | 改读 data.source；zone/panel/tools fixture 全部改真实形状 | zone 单测（东京时区推导恢复真实匹配） |
| S4：framing.ts 重复实现 DST 投影 | 复用 domain.ts makeLocalFormatter/localProjection（含 robust longOffset 解析） | framing 单测 |
| N3：WorkspaceInfo 注释过时 + workspaceItemsOf 恒等函数 | 注释改为 client service；恒等函数内联删除 | tsc |
| N5：attach 失败的孤儿会话不显式 | attach catch 显式报 "created session X left unattached" | tsc |
| S3：conversation.view 裸 register？ | **误报**——该处本就 `ctx.slots.inject` 包裹（reviewer 看到的是 inject 内部的 register） | 代码 inspection |
| S5：research.md 断言 workspace.list RPC 存在（已证伪） | 加勘误（唯一来源 client workspaces service） | — |
| N1：cold 臂未镜像 host probeSmallCold | 不改（罕见、后果仅次优）；AGENTS.md 记录已知差异 | — |
| N6：编辑已删工作区闹钟无"已不存在"提示 | 不改（保存时闭式 not_found 可接受）；记录 | — |
