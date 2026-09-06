# dsh-proactive 会话级 Proactive Tab（心愿单 2：设置/历史日志 UX overhaul）

日期：2026-09-06
状态：待用户对齐

## 1. 背景与目标

用户心愿单 2：「设置、历史日志 ux overhaul。会话 proactive 设置不再放在设置里，而是放在对话页内（对话/轨迹/记忆系统 页签，后面新增这个）全局设置只用来做全局开关和查看全局历史」。

现状：插件的全部管理面（闹钟表格 + 创建表单 + 最近唤醒）都挂在**设置页**的 `settings.section`（id: dsh-proactive, order: 120）。设置页是 host 全局视角，用户每看一个会话的闹钟都要跳设置页，且设置页混着全局配置与会话级的闹钟，职责不清。

目标：

1. **对话页新增「主动唤醒」tab**（zh 文案；en 为「Proactive」，并入已有的对话/轨迹页签环，`conversation.view` 插槽）：展示**当前会话**的闹钟（增删改/暂停/恢复/立即触发）、该会话的唤醒历史与会话级偏好。
2. **设置页保留全量闹钟管理**（用户修正期望）：作为全局视图，列出**所有会话**的闹钟并显示**所属会话**；与对话页 tab 并存——设置页=全局视角（全量闹钟+会话归属+全局历史），对话页 tab=会话视角。
3. **样式 overhaul**（用户明确要求）：当前设置页几乎无自定样式，需要现代、简洁的视觉设计（design token、卡片/表格/表单美化）；对话页 tab 同风格。
4. 数据层不变形：alarm 已带 `sessionId`；新增会话级偏好分片（§4.1.3）。

## 2. 关键调研证据（explore 子代理报告，2026-09-06）

### 2.1 conversation.view 插槽契约

- list 槽注册选项：`{ name, id(必填), order?, label?: string|(()=>string), store?, locale?, inject? }`（`dsh-client-ui-slots/lib/types/index.d.ts:373-431`）。
- **组件直接拿到 `sessionId` 标准 prop**：`ConvViewProps = PropsRuntime<'conversation.view'>`，运行时把 `SessionStandardProps` merge 成 `{ useSession, sessionId, useProjection }`（`dsh-client-runtime/lib/types/client/index.d.ts:64-76`；`dsh-client-ui-conversation/.../contract/slots.d.ts:505-514`）。
- inject 工厂签名 `(sessionId, actions?) => owner`（`slots/index.d.ts:367`）；trajectory 先例 `dsh-client-ui-trajectory/lib/client.js:7340-7368`。
- tab 环：`tabs.length > 1` 才渲染头部 tablist（`conversation/client.js:7386`）；主体 `renderSlot("conversation.view", {...}, { only: active.id })`（7419-7427）。
- 激活 tab 持久化：`ChatStoreState.view`，机制是 `defineStore({ persist: "dsh.conversation.chat", actions: {...setView} })` → localStorage key `dsh.conversation.chat.<sessionId>`（`dsh-client-runtime/lib/client.js:5475-5477`）；未知/为 null 自动回落 chat（`DEFAULT_VIEW_ID="chat"`，7286-7291）。
- label 国际化：`ctx.locale.register(NS, {zh,en})` + `label: () => t("view.proactive")`（trajectory client.js:7359-7363）。

### 2.2 会话级数据存取（客户端）

官方**没有** `session.set` KV。可用机制：

- A. `defineStore({ persist })` 本地镜像（chat store 同款）：session 作用域实例按 sessionId 建、localStorage key `persist.<sessionId>`、会话删除自动清理。适合 UI 偏好即时镜像。
- B. `conversationViews.register` 视图折叠：只读，由会话事件派生。
- C. `sessions.provide`：注入 per-session 标准 props/hooks。
- D. 宿主推送投影 `useProjection`：读宿主算好的整值。

→ 服务端持久 truth 与 UI 本地镜像分离：durable 数据走插件自己的存储，UI 偏好用 A（可选加分）。

### 2.3 后端会话数据

- `ctx.sessions`（服务端）= dsh-session 内存**事件日志**，无 per-session KV 写 API；`sessionProjections` 是事件驱动 fold 单元——proactive 偏好不是会话事件，不适合。
- alarm 模型**已带 `sessionId`**（`src/domain.ts` AlarmView.sessionId、`store.alarmIsValid` 校验）；`PanelAction.create` 已含 `sessionId`。服务端按会话分片/过滤是现成路径。
- **不建议写会话日志**：observer 按 startIndex 切日志判定决策（`src/observer.ts:101-112`），自定义事件会污染判定面。

### 2.4 设置页现状

- `settings.section` 是 list/root，每条目一个设置页；owner props 仅 `{ close }`。**没有通用 `settings.tab` 槽**（只有 `settings.plugins.tab`）。全局设置继续用 `settings.section` 收窄内容（order 120 保留）是正确的。

### 2.5 风险与工程注意

- client.js 是 `window.__ModuleLoader__.load({id, factory})` 懒加载 CJS；插件 esbuild external `@deepseek-ai/*`、react，产物同格式（scripts/build-client.mjs）。
- 类型 import：模块增强 `import type {} from "@deepseek-ai/dsh-client-ui-xxx/client"`；需补 devDep `@deepseek-ai/dsh-client-ui-conversation`（0.1.1-rc.2，仅类型用途，tsc 只查 .d.ts，运行时仍 shell 模块表提供）。
- 无会话时 `conversation.view` scope=session 只在严格会话体内渲染，blank 时 `return null`——tab 自动不出现，无需特判。
- 槽契约只约束 props 不约束 DOM/网络——组件可自由 fetch 自己的 `/api/dsh-proactive/*`（现有插件面板已这么做）。
- store handle 必须在 apply 内构造，禁止模块级导出。

## 3. 用户路径（UX 设计）

### 3.1 路径 A：查看/管理某会话的闹钟

1. 用户打开一个会话（对话页），头部 tab 环出现 **Chat | 轨迹 | 主动唤醒**（tabs>1 自动渲染；proactive order 20，位于 trajectory 10 之后）。
2. 点「主动唤醒」：主体滚动区显示该会话的闹钟卡片/表格（状态、模式、下次触发、抖动徽标、唤醒原因）+ 该会话最近唤醒历史（决策/预算/摘要）+ 会话级偏好（开关/心跳频次/抖动）。
3. 用户可新建（表单：prompt、after/every/at、jitter、delivery）、暂停/恢复、立即触发、取消——**只作用于该会话**（`sessionId` 透传）。
4. 切走再回来，主动唤醒仍是选中 tab（ChatStoreState.view 持久化）。

### 3.2 路径 B：全局巡检（设置页）

1. 设置页 →「主动唤醒」节：**全量闹钟管理**——列出所有会话的闹钟（表格显示所属会话列、状态、模式、下次触发），支持跨会话新建/管理；全局配置摘要（预算/安静时段/心跳 interval+jitter 等）；**跨会话**的最近唤醒历史；全局开关（enabled）独立在最上。
2. 与对话页 tab 并存：设置页标为「全局」，对话页 tab 标为本会话；同一闹钟在两个界面都可管理（cancel/toggle/fire 带 session 归属校验）。

### 3.3 路径 C：空闲会话

- 无会话/hero 态：conversation.view 不渲染，主动唤醒 tab 不出现；设置页全局面不受影响。

## 4. 架构设计

### 4.1 服务端：按会话过滤 + 会话级偏好

现有：`ProactivePanelService.snapshot()` 返回全量 alarms + runs（host 视图）；`action()` 已收 `sessionId`（create 用它建 alarm，但 list/cancel/toggle/fire 目前按 id 全局操作）。

改动：

1. **`/api/dsh-proactive/state?session=<sessionId>`**：可选参数；有则 `snapshot()` 只返回该会话的 alarms 与 runs（`store.listAlarms().filter(a => a.sessionId === session)`；runs 同理）；无则全量（兼容旧客户端与全局面）。
2. **`/api/dsh-proactive/action` 的 cancel/toggle/fire 加会话归属校验**：`{ kind, id, sessionId }`，服务端在 alarm.sessionId !== sessionId 时返回 `forbidden`（防止全局面误操作与会话面越权）。create 继续要求 sessionId。
3. **会话级偏好分片（用户已确认要做）**：`$DSH_HOME/proactive/sessions/<sessionId>.json` 存会话级 proactive 偏好：
   - 字段（均可选，缺省继承全局）：`{ enabled?: boolean, heartbeatEverySeconds?: number, jitter?: number }`（"该会话是否参与主动跟进 + 心跳频次/抖动覆盖"）。
   - 语义：会话级 `enabled=false` → 该会话的所有 heartbeat 唤醒被门控跳过（alarm 委托的仍放行，与全局规则一致）；`heartbeatEverySeconds`/`jitter` 覆盖全局默认（仅影响该会话新建的心跳闹钟与心跳预设预填）。
   - 存储：`ProactiveStore` 扩展 `sessionPrefs` 读写（读 `sessions/<sid>.json`、原子写同 alarms.json 机制）；启动时扫描目录或懒加载均可（默认懒加载 + 内存 Map 缓存）。
   - API：`PanelAction` 加 `{ kind: "prefs", sessionId, prefs: {...} }`（写，部分更新并 merge）；`snapshot(sessionId)` 返回 `prefs` 一并展示。
4. SSE events 流不变：客户端按 payload 的 sessionId 自行过滤（或 `?session=` 过滤，选轻量：客户端过滤）。

### 4.2 前端：conversation.view tab

新文件 `src/client/session-panel.tsx`（或复用 panel.tsx 组件 + 参数化）：

1. `src/client/index.ts`：
   - inject 列表扩为 `["slots","settingsScope","remote","connection","locale"]`（trajectory 同款不需要 conversationEvents/conversationViews）。
   - 注册：
     ```ts
     ctx.slots.inject("conversation.view", () => ctx.slots.register({
       name: "conversation.view",
       id: "proactive",
       order: 20,
       locale: "dsh-proactive",
       label: () => t("view.proactive"),
       inject: (sessionId) => ({ ... })
     }, ProactiveSessionPanel));
     ```
   - **真正注册 locale 字典**：`ctx.locale.register("dsh-proactive", {zh, en})`（现有代码只 declare 了 map 从未 register——顺手修）。
2. `ProactiveSessionPanel` 组件：解构标准 prop `sessionId`（`useSession` 不需要，除非要会话状态）；内部复用现有 ProactivePanel 的列表/表单/历史区块，但：
   - 数据源：`transport.state(sessionId)`（带 `?session=`），action 均带 `sessionId`。
   - 标题/空态用「本会话」文案；无闹钟显示引导文案（"让模型用 proactive_set 给自己订闹钟，或在此新建"）。
   - 自由布局（viewArea 整宽滚动区），CSS 用 `--dsw-alias-*` design token（trajectory 同款手法；esbuild 无 CSS module，内联 token 或 style 注入）。
3. 设置页面板（panel.tsx 全局版）**保留全量闹钟管理**（用户修正）：
   - **闹钟表格新增「所属会话」列**（alarm.sessionId 展示，短 id 或会话标题）；全量列出所有会话的闹钟，支持跨会话管理（cancel/toggle/fire 全局操作，create 仍要求 sessionId）。
   - 保留：全局开关、全局配置摘要（从 snapshot.config 渲染）、**跨会话最近唤醒**（runs 表不带 filter）。
   - 标注「全局视图」：加一行说明「会话级管理请到对应会话对话页的 主动唤醒 tab」。
   - 样式/组件复用：把 `ProactivePanel` 拆成 `AlarmList`（含行组件、可注入 filter）、`CreateForm`、`RunsTable` 三个内部组件，会话版（对话页 tab）与全局版（设置页）各自组合。

### 4.4 样式 overhaul（用户明确要求）

当前设置页面板几乎无自定样式（裸 HTML 表格）。本次统一做现代简洁视觉：

1. **设计 token**：复用 dsh web 的 `--dsw-alias-*` CSS 变量（bg-layer-1/2、border-l1/2/3、label-primary/secondary/tertiary、state-*、`--ds-font-family-code` 等；trajectory 同款手法）。
2. **布局**：卡片式区块（闹钟列表 / 创建表单 / 最近唤醒），圆角 + 边框 + 分层底色；表格行 hover 高亮；徽标（状态、抖动 ±N%）用 pill 样式。
3. **表单**：输入框/选择器/按钮统一描边与 focus 态；间距网格（8px 基）。
4. **实现方式**：esbuild 无 CSS module——用**动态注入 `<style>` 标签**（trajectory/conversation 同款模式：`document.createElement("style")` + className 前缀 `dshp_`）或内联 style；两者结合（结构用注入 CSS 类，动态色用 token 变量）。
5. 设置页与对话页 tab 共用同一套样式（一个注入函数、两个挂载点）。

4. **devDep 补充**：`@deepseek-ai/dsh-client-ui-conversation@0.1.1-rc.2`（仅类型，import type ConvViewProps 等）。

### 4.3 不做什么（边界）

- 不写会话日志（observer 判定面保护）。
- 不用 sessionProjections（偏好非事件）。
- 不做 `settings.plugins.tab`（非插件赛道）。
- 会话偏好分片默认不做（§4.1.3，待确认）。
- 不引入 CSS module 构建链（token 内联即可）。

## 5. 验证（check/test/build + 实机）

1. `npm run check`（tsc 全量）→ `npm test`（后端单测：state?session 过滤、cancel/toggle/fire 归属校验）→ `npm run build`（client bundle 含新 tab）。
2. 实机验证（validation.md 追加）：
   - 打开会话，头部出现 Chat | 轨迹 | Proactive；点 Proactive 只见本会话闹钟。
   - 会话内新建闹钟 → 列表出现；切走会话再回来仍是 Proactive tab。
   - 设置页 Proactive 节只剩全局开关 + 跨会话历史。
   - 无会话（hero）不渲染 tab。
   - 冷会话 resume 的唤醒（proactive_set 建的闹钟）在该会话 tab 可见。

## 6. 变更文件清单（预估）

- 后端：`src/panel/service.ts`（snapshot 过滤 + prefs 动作 + 归属校验）、`src/panel/contract.ts`（state/action 参数、prefs）、`src/panel/routes.ts`（query 解析）、`src/store.ts`（sessionPrefs 落盘）、`src/client/host-api.ts`（state(sessionId)）
- 前端：`src/client/index.ts`（view 注册 + locale.register）、`src/client/session-panel.tsx`（新，会话版 tab）、`src/client/panel.tsx`（拆组件 + 全局版会话列 + 样式）、`src/client/style.ts`（新，注入 CSS）、`src/client/locales.ts`（view.proactive 等文案）、`package.json`（devDep）
- 测试：`test/panel.test.ts`（session 过滤/归属/prefs）、`test/store.test.ts`（prefs 落盘）
- 文档：`docs/features/260906-proactive-session-tab/` 下 summary/validation；README「GUI 管理面板」节更新

## 7. 已确认决策（2026-09-06 用户对齐）

1. tab 文案双语：zh「主动唤醒」/ en「Proactive」。
2. 设置页**保留全量闹钟管理**（新增「所属会话」列），与对话页 tab 并存（全局 vs 会话视角）。
3. 会话级偏好分片**本轮实现**（enabled/heartbeatEverySeconds/jitter 会话级覆盖）。
4. **样式 overhaul 本轮必做**（现代简洁，token + 卡片 + 注入 CSS）。