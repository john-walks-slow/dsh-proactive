# 心愿单 2：设置/历史日志 UX overhaul（会话级 Proactive tab）实施摘要

## 需求与决策

用户对「心愿单 2」的最终期望（2026-09-06，覆盖早期版本）：

1. 命名：功能名中文「主动唤醒」，英文 "Proactive"。
2. 设置页**保留管理所有闹钟**（并显示所属会话）——不再移除闹钟表格。
3. **添加现代、简洁样式**（此前设置页无自定样式）。
4. 新增对话页「主动唤醒」tab（会话视角），偏好/闹钟/历史按会话隔离。

采纳的顶层设计（plan §7 已确认）：

- 双界面并存：对话页 tab = 会话视角（本会话闹钟 + 历史 + 会话偏好）；设置页 = 全局视角（全量闹钟 + 所属会话列 + 全局历史 + 配置摘要）。
- 会话级数据不写会话日志（observer 按 startIndex 切片判定，写日志会破坏判定），改用插件自有分片 `$DSH_HOME/proactive/sessions/<sessionId>/prefs.json`。
- 服务端 alarm/runs 模型已带 `sessionId`（先前实现遗留），本轮补全透传与作用域校验。
- SSE `/events` 不改，客户端按需过滤。

## 实施内容

### 后端

- `domain.ts`：`AlarmView` 透传 `sessionId`（toAlarmView）。
- `store.ts`：`SessionPrefs {enabled?, heartbeatEverySeconds?, jitter?}` + `SessionPrefsPatch`（null 删除键回退继承全局）+ `prefsIsValid` 形状守卫；`sessionPrefs(sessionId)` 懒加载缓存（corrupt 降级 `{}`）、`saveSessionPrefs` merge + 原子写 + onChange 通知。
- `scheduler.ts`：fireOne 增加会话级门控——`prefs.enabled === false` 且 `wakeReason !== "alarm"` 时跳过心跳唤醒（recordSkip "session proactive disabled" + advancePast）；用户委托的 alarm 不受会话开关影响。
- `panel/contract.ts`：PanelSnapshot 会话级附带 `prefs`；PanelAction 增 `prefs` 动作与 cancel/toggle/fire 可选 `sessionId`；PanelErrorCode 增 `forbidden` / `invalid_prefs`。
- `panel/service.ts`：`snapshot(sessionId?)` 会话级过滤 alarms/runs + 附加 prefs；`runAction(input, sessionId?)` 归属守卫（guardOwnership：cancel/toggle/fire 越权 → forbidden，cancel 先查后删）；prefs 动作键白名单 + null 删除 + store 守卫双层校验。
- `panel/routes.ts`：`/state` 与 `/action` 支持 `?session=`，action 的 POST 也读 query。

### 前端

- `client/style.ts`（新）：共享样式表注入 `<style>`（幂等），`dshp-` 前缀类 + `--dsw-alias-*` design tokens（卡片/表格/表单/徽标/开关/错误/空态）。
- `client/sections.tsx`（新）：共享展示组件 AlarmTable（可显会话列）/ RunsTable / CreateForm / SessionPrefsCard + 状态/模式/唤醒原因双语标签与时间格式化。
- `client/panel.tsx`：重写为设置页全局面板。
- `client/session-panel.tsx`（新）：conversation.view 组件，解构 `props.sessionId`，会话级偏好 + 闹钟 + 历史。
- `client/use-locale.ts`（新）：`useSyncExternalStore` 语言跟随 hook（`bindProactiveLocale` 由挂载点绑定真实 locale 服务，缺失时回退 zh/浏览器语言）。
- `client/index.ts`：注册两个挂载面——`settings.section`（order 120）+ `conversation.view`（id `proactive`，order 20，locale NS，label 双语） ；`ctx.locale.register` 真注册 + `LocaleNamespaceMap` 具体 key 联合；注入失败仅 log 不抛。
- `client/locales.ts`：完整双语字典（tabLabel 主动唤醒/Proactive、会话/全局两套文案、偏好文案、表格标题等）。
- `client/host-api.ts`：state/action 支持 `sessionId`（`?session=` 编码透传），SnapshotDto alarms/runs 增 sessionId、prefs 字段。
- 依赖：devDep 增 `@deepseek-ai/dsh-client-ui-conversation@0.1.1-rc.2`（仅类型用途，构建产物仍单文件 lazy-CJS）。

## 评审与修复（/spawn-reviewer，2026-09-06）

结论：**0 P0 / 2 P1 / 7 P2 / 6 P3，「P1 修复后准入」**（报告：`260906-proactive-session-tab.review.md`）。已修复：

- **P1-① 路径穿越**：`saveSessionPrefs` 把 sessionId 拼入文件路径，`?session=..%2F..%2Fevil` 可穿越写任意目录的 prefs.json。修复：`domain.isValidSessionId` 白名单（`/^[A-Za-z0-9._-]+$/`，拒绝 `.`/`..`/非 ASCII）+ store 层 `assertSafeSessionId` fail-closed + service 层快照/动作入口校验；测试覆盖遍历拒绝与合法 id 往返。
- **P1-② 作用域缺单一来源**：cancel/toggle/fire 的 body sessionId 服务端从不读取，prefs 绕过归属守卫，create 可跨会话归属——「会话 tab 只能管理本会话」靠客户端自觉。修复：作用域以路由 `?session=` 为唯一来源——create 在作用域下必须命名同一会话、prefs 仅在拥有会话作用域下可用、三动作去掉 body sessionId 字段；新增 `scope_mismatch` 错误码；测试覆盖无作用域 prefs 拒绝/跨会话拒绝/作用域内 create 放行。
- **P2-① token 笔误**：`--dsw-alias-brand-primary-new-colorprimary-new-color` 宿主不存在 → 修正为 `--dsw-alias-brand-primary`（accent 随主题）。
- **P2-② prefs 下界未对齐**：`heartbeatEverySeconds` 允许 <300 导致心跳预设必报 `frequency_too_high` → 对齐 `MIN_EVERY_SECONDS`（store 校验 + 测试 36 拒绝）。
- **P2-③ 切会话竞态**：reload/run 增加 sessionRef 陈旧响应丢弃（A 会话在途响应不覆盖 B 快照）。
- **P3-① decode 异常**：`decodeURIComponent` 同步抛 → fail-closed 视为无 session。
- **P3-④ 渲染期注入**：`injectProactiveStyles` 移入 mount effect。
- **P3-⑤ 测试 flaky 根治**：根因是 scheduler 的 fire-and-forget persist 与 `tctx.after` 的 `rmSync` 清理竞态（ENOTEMPTY）→ `rmSyncSafe` async 重试；15 处清理统一替换，8/8 连跑全绿。

后置（记入待跟进，不阻塞准入）：P2-④ 数字输入逐键往返（建议防抖/blur 提交）、P2-⑤ en 界面硬编码中文残留（runs 表头/meta/远端标签，建议并入字典）、P2-⑥ 设置页新建闹钟归属 `host-panel` 孤儿（已用「全局（设置页）」友好展示，会话选择器待后续）、P2-⑦ `config.enabled=false` 时面板 404（既有行为，全局开关独立呈现代待后续）、P3-② prefs 门控晚于安静时段 deflect、P3-③ SSE 重连不重拉。

## 测试

118/118 通过（基线 110 + 新增 8）；评审修复后 **122/122**（scope 规则×2、路径穿越×2 追加）：

- panel：session 过滤（alarms/runs/prefs 作用域）、取消/暂停/触发归属守卫（越权 forbidden + 放行）、全局面取消不受限、prefs merge + 非法值拒绝 + null 删除键、prefs 跨实例持久化、坏形状拒绝。
- scheduler：会话偏好 enabled=false 跳过心跳唤醒、alarm 仍触发、skip 记录落盘。

`npm run check`（tsc nosEmit）+ `npm test` + `npm run build` 全绿。

## 验证

- `docs/features/260906-proactive-session-tab/260906-proactive-session-tab.validation.md` —— 8 项 GUI 实机验收（tab 出现、会话隔离、全局会话列、越权拒绝、偏好持久化、主题可读、无会话态）。

## 待办（发布前）

- ✅ reviewer 检视并修复（P1 准入条件已满足，见上）。
- build 后同步 web profile（hardlink 自动）+ `supervisorctl restart dsh`（会中断当前会话，**需确认时机**）→ GUI 实机验证 validation.md 8 项。
- 后置项：P2-④ 输入防抖、P2-⑤ en 混排清理、P2-⑥ 会话选择器、P2-⑦ 全局开关呈现（见评审轮）。

## 变更文件

见 260906-proactive-session-tab.plan.md §6 变更清单 + 本轮 commit。

## 用户定稿修订（2026-09-06 深夜，覆盖上文全部 prefs/心跳预设设计）

用户对新版双击界面给出收敛定稿，**推翻偏好体系与心跳预设**，并重做设置页：

1. **删除心跳预设按钮**（两面板的 `applyHeartbeat` 与 `formFromHeartbeat`）：heartbeat 默认唤醒指令即 `heartbeatPrompt`（面板表单初始 prompt 直接取它），不再需要「一键预填」按钮。
2. **删除全局与会话级 interval/jitter 偏好项**：`config.heartbeatEverySeconds`/`heartbeatJitter`、`settings.ts` 的 HotConfig 字段与 schema、`tools.ts` 的 `SETTINGS_VIEW_SCHEMA`/`proactive_update_settings` 参数、会话 `SessionPrefs` 整套全部移除——间隔/抖动**只按每个闹钟**在创建/编辑时配置（保留 `MIN_EVERY_SECONDS=300` 与 `HEARTBEAT_MAX_SECONDS=86400` 的每闹钟校验）。
3. **删除会话偏好体系**：`store.ts` 的 `SessionPrefs/sessionPrefs/saveSessionPrefs/PREFS_DIR/assertSafeSessionId`、`scheduler` 的会话级 enabled 门控、`PanelAction.prefs`、`Snapshot.prefs`、`SessionPrefsCard`、`savePrefs`、locales 的 prefs 键全部移除。`isValidSessionId` 白名单保留（service 快照入口校验仍用）；P1-① 的路径穿越面随 prefs 目录消失而自然收敛。
4. **设置页 = 可编辑全局配置 + 单一闹钟表格**：顶部全局配置卡（启用开关、每日预算、安静时段起止+时区、heartbeat 默认指令）直接编辑保存（新 `update_config` 动作＝ `validateSettingsPatch` + `writeConfigFile` + `applyHotConfig` 复用工具语义）；下方单一表格列出**所有闹钟**，支持状态/模式/会话**筛选**与下次触发/创建时间/指令**排序**，行操作含暂停/恢复/**编辑**/取消/立即触发，每行可**展开查看该闹钟自己的唤醒历史**（原全局 Runs 表移除）；「所属会话」列显示**会话标题**（`ctx.sessions` + `dsh-session-title` 服务解析，降级空标题显示 id），标题旁**复制 icon 点击复制会话 id**；新建表单有「目标会话」选择器（取现有闹钟归属去重），**不再产生 host-panel 孤儿闹钟**（旧数据仍兼容显示「全局（设置页）」）。
5. **新增 edit 动作**：`{kind:"edit", id, args}`，args 走同一 `validateCreateArgs` 校验；保留 id/sessionId/createdAt/runCount/lastRunAt，重建 trigger/nextDueAt 并重置 scheduled；in-flight/completed/cancelled/failed 拒绝；归属守卫（scope 下越权 forbidden）。
6. **会话 tab 保留但不更新**：删除 SessionPrefsCard/心跳预设/`applyHeartbeat`，保留表格（含行内历史与编辑）+ 新建。
7. **padding 修复**：conversation.view tab 内容区 padding 待实机按计算样式微调（列入验证项）。

### 本轮变更文件

- 后端：`config.ts`（删两字段/钳制函数）、`settings.ts`（HotConfig/schema/校验删两键）、`tools.ts`（视图/参数删两键）、`store.ts`（prefs 全删）、`scheduler.ts`（会话门控删）、`panel/contract.ts`（prefs 删；`AlarmRowView` 增 sessionTitle/createdAt/everySeconds/at；PanelAction 增 edit/update_config）、`panel/service.ts`（prefs 分支删；edit/update_config 分支新增；snapshot 填标题与编辑字段）、`index.ts`（panel 注入 sessionTitle resolver）。
- 前端：`client/locales.ts`（删 prefs/heartbeatPreset 键，增筛选/排序/编辑/历史/复制/配置卡键）、`client/host-api.ts`（DTO 增 createdAt/everySeconds/at/sessionTitle）、`client/sections.tsx`（删 SessionPrefsCard/formFromHeartbeat；AlarmTable 增筛选/排序/编辑/行内历史/会话列+复制 icon；CreateForm 增目标会话选择与编辑模式）、`client/panel.tsx`（重写：配置编辑卡+单一表格）、`client/session-panel.tsx`（删 prefs 卡与心跳按钮）、`client/style.ts`（toolbar/历史行/复制按钮/toast/textarea 样式）。
- 测试：`panel.test.ts`（prefs 用例删；edit/update_config/sessionTitle/at 预填/作用域新用例）、`config/settings/tools/scheduler.test.ts`（interval/jitter/prefs 用例收敛）。
- README 更新至 v4 语义。