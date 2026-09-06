# dsh-proactive 会话级 Proactive Tab（心愿单 2：设置/历史日志 UX overhaul）评审

> 日期：2026-09-06 · 评审对象：工作树未提交变更（相对 HEAD `a2350a1`；任务描述写「相对 4ce04e0」，4ce04e0 已在 HEAD 历史内）· 变更面：后端 `store.ts`/`scheduler.ts`/`panel/{contract,service,routes}.ts`/`domain.ts`，前端 `client/{panel,sections,session-panel,style,use-locale,index,host-api,locales}`，测试 `panel.test.ts`/`scheduler.test.ts`，`package.json` devDep
> 评审方式：源码走读 + 平台 .d.ts 逐字核对（`dsh-client-ui-conversation` 0.1.1-rc.2 `ConvViewProps`、`dsh-client-runtime` `SessionStandardProps`、`dsh-client-ui-slots` `LocaleNamespaceMap`/`LocaleDictOf`、`dsh-client-locale` `LocaleSnapshot`）+ 参考实现对照（`dsh-client-ui-trajectory/lib/client.js` 注册段）+ 宿主 shell CSS token 实测（`dsh-web-frontend/dist/assets/index-*.css`）+ 独立复验（`npm run check` / `npm test` / `npm run build`，取真实退出码）

## 0. 结论摘要

| 级别 | 数量 | 摘要 |
|---|---|---|
| P0 阻断交付 | 0 | — |
| P1 必修 | 2 | ① **sessionId 未清洗直入文件路径**：`saveSessionPrefs` 以 `<dataDir>/sessions/<sessionId>/prefs.json` + `mkdir recursive` 落盘，sessionId 来自路由 query/动作 body，`..%2F` 可穿越写任意目录的 `prefs.json`——一行黑名单/白名单即可封死。② **动作作用域三处来源不一致**：cancel/toggle/fire 的 body `sessionId` 字段服务端**从不读取**（作用域只看 query），`prefs` 动作完全绕过归属守卫且无视 query 作用域，`create` 在会话作用域下仍可跨会话归属——「会话 tab 只能管理本会话」的承诺只有 query 取值一致时才成立，属信任客户端自缚，需统一为单一作用域规则 |
| P2 建议修 | 7 | ① accent token 笔误 `--dsw-alias-brand-primary-new-colorprimary-new-color` 在宿主 CSS **不存在**（实测真名 `--dsw-alias-brand-primary`），按钮/焦点/开关/pill 主色恒回退 `#4f46e5`、不随主题；② `prefsIsValid` 允许 `heartbeatEverySeconds` 1..299（低于 `MIN_EVERY_SECONDS=300`），存进去后心跳预设预填创建必报 `frequency_too_high`；③ session-panel 快速切会话时旧响应可覆盖新快照（竞态）；④ SessionPrefsCard 数字输入逐键 POST+快照回灌，快速输入丢字符；⑤ en 界面混排硬编码中文（runs 表头/meta/`fmtInstant`/状态标签映射）；⑥ 设置页全局新建仍硬编码 `sessionId:"host-panel"`（孤儿闹钟，计划 §3.2 承诺的「跨会话新建」无会话选择器）；⑦ `config.enabled=false` 时 `apply()` 提前返回 → 两个 GUI 面全部 404，计划承诺的「全局开关独立在最上」未交付 |
| P3 可后置 | 6 | `decodeURIComponent` 同步抛未捕获；prefs 门控晚于安静时段 deflect（禁用心跳安静期间每 5 分钟空转重排）；SSE 重连不重拉（既有模式）；`injectProactiveStyles` 在 render 体内调用；locale 死键 `favorite`/`okay` + 一次未复现的 flaky；脏工作树含并发文件（wake.ts 等，提交用 commit-own-changes） |
| 亮点 | — | 注册模式与 ui-trajectory 逐字同构（`ctx.effect(locale.register)` + `slots.inject("conversation.view")`）；`props.sessionId` 契约经 d.ts 链实证（`PropsRuntime → SessionStandardProps.sessionId: SessionId`）；`LocaleNamespaceMap` 精确键联合在 register 处受 `LocaleDictOf` 严格校验（多/缺键即编译错，tsc 实证）；客户端全部 dsh 导入均为 **type-only**，bundle 运行时零新增依赖；「坏值不落盘」用跨实例读取实证；scheduler 门控语义与计划一致且 alarm 旁路有测试 |

**总体判断：需求落地与官方插槽契约、参考实现、前端类型体系高度一致；prefs 校验链、快照过滤、归属守卫的核心逻辑正确且有测试覆盖；样式注入方案可行、token 基本齐备。P1 两条均为加固性质（当前信任模型下功能路径不受影响，但「会话作用域」边界并未真正闭合），建议修复后准入。**

## 1. 复验记录（本次会话实测）

| 项目 | 结果 |
|---|---|
| `npm run check`（tsc --noEmit，src+test） | ✅ 退出码 0 |
| `npm test`（tsc 编译后 node --test） | ⚠️ **118 tests**；首跑 117/118 一次 fail（未捕获失败名），随后 **9 次全量 + 12 次分文件（scheduler/wake/panel ×4）全部绿**——见 P3-5 |
| `npm run build`（tsc + esbuild client） | ✅ `lib/client.js` 46.2kb 单文件 lazy-CJS；bundle 中 `@deepseek-ai/*` 运行时引用 **0 处**（`ui-conversation` 的 `ConvViewProps` 为 type-only，被 esbuild 剥离）——devDep「仅类型用途」成立 |
| `ConvViewProps` 契约 | `PropsRuntime<'conversation.view'> = OwnerOf & KeyPropsOf & SlotInjectFace & SessionStandardProps & GlobalStandardProps`（ui-slots index.d.ts:190）；`SessionStandardProps.sessionId: SessionId` **必选**（dsh-client-runtime index.d.ts:70-81）→ `String(props.sessionId)` 冗余但无害，scope=session 下不可能 undefined |
| 注册模式 | 与 `dsh-client-ui-trajectory/lib/client.js:7329-7379` 逐字同构（`ctx.effect(() => ctx.locale.register(NS,{zh,en}))`、`t = ctx.locale.bind(NS)`、`label: () => t(...)`、`inject: (sessionId) => ({})`）；trajectory 的 inject 返回 owner face，本插件返回 `{}` 属合法（`inject?: object`），组件吃标准 props |
| `LocaleNamespaceMap` | 精确键联合（41 键）与 zh/en 字典 **一一对应**；ui-slots 契约「缺失或多余键在 typed register 处编译错」（index.d.ts:59-63），tsc 实证通过 |
| 样式 token 实测 | 宿主 shell CSS 存在：`--dsw-alias-bg-layer-1/2`、`border-l1/l2/l3`、`label-primary/secondary/tertiary/dimmed`、`state-success-primary`、`state-error-primary`、`state-warn-label`、`brand-primary`、`--ds-font-family-code` 等；**不存在** `--dsw-alias-brand-primary-new-colorprimary-new-color`（命中 0 次） |

## 2. 检视点① — 后端契约与校验（prefs / 归属守卫 / 快照过滤）

**正确的部分：**

- **prefs 校验链闭环**：service 白名单 key（enabled/heartbeatEverySeconds/jitter）+ `null` 删除 → `store.saveSessionPrefs` merge → `prefsIsValid` 对**合并结果**全量重校验 → 通过才原子写（tmp+rename）；坏值以 `invalid_prefs` 拒绝且**不碰磁盘**——测试用全新 `ProactiveStore` 实例读盘实证（panel.test.ts:288-294），是好测试。
- **快照过滤**：`alarms`/`runs` 按 `sessionId` 双过滤；`prefs` 仅会话作用域快照携带（host 视图无此字段）；`config` 全量（会话 tab 需要全局默认做继承展示）。✓
- **归属守卫**：`guardOwnership` 的优先级正确（`not_found` 优先于 `forbidden`——不泄露 id 存在性分辨之外的信息；越权 `forbidden`；host 视图放行）；cancel/toggle/fire 三动作一致，测试覆盖越权拒绝+放行+全局放行。✓
- **副作用一致性**：prefs 保存 emitChange → SSE → 各面板自行按作用域重拉。✓

**P1-①：sessionId 未清洗即入文件路径（路径穿越写）**

`store.sessionPrefs/saveSessionPrefs` 直接拼 `<dataDir>/sessions/<sessionId>/prefs.json`，`mkdir(recursive)` + `writeFile`。sessionId 的两个入口（路由 `?session=`、动作 body）都只做了「非空字符串」检查，无字符集约束。`?session=..%2F..%2Fevil` 经 `decodeURIComponent` 得 `../../evil`，即可在 dataDir 之外创建/覆写名为 `prefs.json` 的文件（内容为 JSON `{enabled?,heartbeatEverySeconds?,jitter?}`，可控字段数受限但文件写入本身成立；读取侧可探测任意 `*/prefs.json`）。`create` 的 sessionId 只进 alarm JSON 不进路径，不受影响——风险面集中在 prefs。

建议（一行级修）：sessionId 白名单/黑名单校验，如 `/^[A-Za-z0-9._-]+$/`（dsh 会话 id 形态满足），拒绝即 `invalid_prefs`/`bad_action`；或 `path.resolve` 后 `startsWith(dataDir + "/sessions/")` 断言。fail closed。

**P1-②：动作作用域缺单一来源（信任客户端自缚）**

- `PanelAction` 的 `cancel/toggle/fire` 声明了可选 `sessionId`，但 `runAction` 对这三类**只读路由层 sessionId**，body 字段是死类型（服务端不读）。
- `prefs` 动作只校验 `action.sessionId` 非空，**无视 query 作用域、也不走归属守卫**——会话作用域请求可写任意会话的 prefs，host 请求同样可写任意会话 prefs（host 面板当前不发 prefs，但契约上已开）。
- `create` 在会话作用域下允许 body sessionId ≠ 查询作用域（创建归属其他会话的闹钟，返回快照还看不见它）。

当前 UI 路径三者恒一致所以功能正常，但「会话 tab 只能管理本会话」的边界是**客户端自觉**而非服务端强制。建议统一规则（二选一即可）：(a) 作用域以 query 为唯一来源——`create`/`prefs` 的 body sessionId 与 query 不一致时 400；(b) 去掉 cancel/toggle/fire 的 body sessionId 字段，prefs 增加与 query 作用域的一致性校验。修后补一条「动作 sessionId 与查询作用域不一致」的测试（当前无此用例）。

**P2-②：prefs 数值下界未对齐 alarm 校验域**

`prefsIsValid` 只要求 `heartbeatEverySeconds > 0`，而 alarm 校验要求 `>= MIN_EVERY_SECONDS (300)`。存 36 合法 → 会话 tab「心跳预设」预填 `everySeconds=36` → 创建必报 `frequency_too_high`，错误提示与偏好表单脱节。建议 `prefsIsValid` 引入 `MIN_EVERY_SECONDS` 下界（domain 已导出），或至少在表单侧 min=300 约束 + 文案说明。

## 3. 检视点② — scheduler 门控语义

- **位置与语义**：非 alarm 唤醒（含 legacy `check_in` 类，`wakeReason !== "alarm"` 统一覆盖）在 quiet-hours / hourly-cap deflect 之后、**budget 检查之前**查 `sessionPrefs(alarm.sessionId).enabled === false` → `recordSkip("session proactive disabled …")` + `advancePast`；`wakeReason === "alarm"` 完全旁路。与计划「alarm 委托不受影响，与全局规则一致」逐字相符。✓
- 第一读来自磁盘的 await 在串行 drive 循环内一次性发生，之后走内存缓存；`saveSessionPrefs` 同步更新缓存 → 门控读到的总是新值。✓
- **单测契合**：scheduler.test.ts 新增用例覆盖「enabled=false 跳心跳（one-shot 推进为 completed）+ skip 记录含原因 + alarm 仍触发」三条断言，恰好卡住本特性的核心语义。✓
- **P3-②**：prefs 检查在 quiet deflect **之后**——安静时段内被禁用的心跳每次到点都被 deflect 重排 +5min，安静期全程每扇区空转一次 drive（budget 耗尽同款顺序，属既有模式；新代码本可放最前）。建议把 prefs 门控挪到 quiet 检查之前（异步冷读一次之后就是内存读）。
- boot-overdue 策略（notify-only/drop）不经 prefs 门控：对禁用会话的过期心跳记的是「boot overdue」skip 而非「session proactive disabled」——同为 skip，语义可接受。

## 4. 检视点③ — 前端 React 组件

- **SSE 订阅清理**：两个面板的 `useEffect` 均返回 `unsubscribe`（`source.close()`），依赖数组 `[reload, transport, (sessionId)]` 完整；`reload` 重建时会重订阅——无泄漏。✓
- **无会话行为**：`conversation.view` scope=session 只在严格会话体内渲染，blank 时组件不挂载、tab 自然不出现（计划 §3.3 成立），无需特判。✓
- **P2-③ 切会话竞态**：`reload` 无取消/陈旧检查——快速从会话 A 切到 B（tab 持久化下常见）时 A 的在途响应可晚于 B 落地，`setSnapshot` 用 A 数据渲染 B 的 tab（`setSnapshot(null)` 只清初始态，不解决交错）。建议 AbortController 或捕获渲染时的 sessionId 比对。
- **P2-④ SessionPrefsCard 逐键往返**：数字输入是「受控值 ← 快照」，每敲一键即 POST → 全量快照回灌 → 值重算。快速输入 `3600` 时中间响应可能覆盖正在键入的值、丢字符或 caret 跳动；清空字段即时发 null 删除也是同样往返。建议本地暂存 + blur/Enter/防抖提交（偏好本就是低频低竞态数据）。
- **P2-⑤ i18n 泄漏**：`RunsTable` 表头「决策/预算/摘要（思考 / 回复）」、全局面板 meta「服务器/心跳/闹钟/归属见表格」、`fmtInstant` 的 `toLocaleString("zh-CN")`、`STATE_LABELS`/`MODE_LABELS`/`WAKE_LABELS` 硬编码中文——en 界面会混排中文，与「tab 文案双语」的目标半途而废。建议表头/状态标签并入 locale 字典（枚举映射可保留但提供 en 对照）。
- **P2-⑥ 全局新建孤儿闹钟**：`create` 仍硬编码 `sessionId: "host-panel"`（HEAD 旧面板同款，非本轮回归），但本轮新增「所属会话」列后它会以假会话名示人，且该闹钟**永远不出现在任何会话 tab**（会话过滤）。计划 §3.2/4.2 承诺「跨会话新建/管理」——无会话选择器即未交付。二选一：创建表单加会话选择（从 `useSessions` 或快照已有会话聚合），或把该值改为「未归属」并调整文案。
- **P2-⑦ config.enabled=false 陷阱**：`apply()` 在 `!config.enabled` 时提前返回（含路由安装与 scheduler.start，HEAD 同款既有行为）→ 全局关停后两个 GUI 面全部 404，而会话偏好开关（唯一在 UI 里的 enabled 类开关）理应是「还能把自己开回来」的入口，实际连面板都进不去；计划 §3.2 的「全局开关（enabled）独立在最上」也未交付。建议：路由在禁用态也安装（面板显示只读「已禁用」态），或在设置面板补全局 enabled 开关。

## 5. 检视点④ — 类型层面

- `ConvViewProps` 使用**正确**：经 d.ts 链实证 `sessionId` 为必选 `SessionId`；`String(props.sessionId)` 防御冗余但无害；组件不依赖 `useSession`/`useProjection`（只吃 sessionId），与「列表/表单只需 scoped 数据」匹配。✓
- `LocaleNamespaceMap` 模块增强以精确键联合声明，41 键与 `ProactivePanelCopy` 完全一一对应；ui-slots 的 typed `register` 会校验字典形态（`LocaleDictOf<N> = Record<联合,string>`，缺/多键编译错）——tsc 全绿即证明字典与声明同步。这是比旧版 `Record<string,string>` 严格的正确升级。✓
- 遗留死字段：`PanelAction` 三类动作的 `sessionId?` 与 `prefs` 的守卫缺失同源（见 P1-②）——修作用域规则时一并收敛类型。
- 类型导入纪律：`import type` 全部正确标注为 type-only，esbuild 剥离后 bundle 无任何 `@deepseek-ai/*` 运行时引用，devDep 不影响产物。✓

## 6. 检视点⑤ — 样式注入可行性与隐患

- **方案成立**：单 `<style>` 注入 + `dshp-` 前缀 + `--dsw-alias-*` token + 全量 fallback，与 trajectory 同款；`injectProactiveStyles` 幂等保护 + `removeProactiveStyles` 供测试/热更；类选择器全部收在 `.dshp-panel` 作用域下，宿主样式冲突面小。✓
- **P2-① token 笔误（唯一硬伤）**：`--dshp-accent: var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4f46e5)` —— 实测宿主 shell CSS 中该 token 命中 0 次（真名 `--dsw-alias-brand-primary`，另有 `button-primary-fill` 等）。后果：accent 恒为 fallback `#4f46e5`，**深色主题下主按钮/焦点环/开关/pill 不随主题**（mid-indigo 在深底上对比度尚可用，但与本轮「token 驱动」目标相悖）。一行修正。其余 token 名逐一核验存在 ✓。
- `color-mix()` 需 2023+ 浏览器——DSH web 同代基线，可接受。`String.raw` 模板内无 `${}` 插值，无构建期转义风险。✓
- **P3-④**：`injectProactiveStyles()` 在两个组件的 render 体内调用（DOM 副作用入 render，幂等使 StrictMode 双调用安全，但纯度上建议挪到 mount effect 或挂载点）。

## 7. 检视点⑥ — 与既有测试的契合度

- 新增 8 项面板测试 + 1 项 scheduler 门控测试，全部挂在既有 harness 风格下（内存 store + 假 scheduler + 注入时钟），与 110+ 既有测试同构；总套件 118。
- 覆盖面：会话过滤（alarms/runs/prefs 字段）、归属守卫（越权 forbidden + 放行 + 全局放行）、prefs 合并/校验/null 删除/跨实例持久化/坏形状拒绝、scheduler 会话门控（心跳跳 + alarm 放行 + skip 记录）——**核心语义全覆盖**。
- 缺口：
  1. `routes.ts` 的 `sessionParam` query 解析（含 `decodeURIComponent` 异常路径）无测试——私有函数未导出，可导出或以 `installPanelRoutes` 假 webserver 测；
  2. P1-② 修复后需补「动作 body sessionId 与查询作用域不一致 → 400」用例（当前无）；
  3. 全局 create 的 `host-panel` 归属、SessionPrefsCard 表单交互等前端行为无测试（无 jsdom 测试链，可接受，实机验收补齐）。
  - **P3-⑤ flaky 观察**：首次全量跑 117/118 一次失败（未抓到失败名），随后 9 次全量 + 12 次分文件复跑全绿。疑似计时型用例（busy 重试/jitter walk 的真实定时器）偶发；提交前建议连跑 3-5 次全量确认稳定。
- 与 118 单测的契合结论：新测试沿用既有 harness 与断言风格，不破坏任何旧用例；存量用例零改动通过。

## 8. 其他说明（工作树卫生）

- 工作树含与本特性无关的并发未提交文件：`src/wake.ts`/`test/wake.test.ts`（冷唤醒 P2 加固：`WakeResumeSetup = AgentSetup`、agent 缺失显式 throw，与 4ce04e0 修复配套但未提交）、`AGENTS.md`、`README.md`、`docs/issues/260830-*`、`docs/issues/260906-cold-wake-provider-model/*`。提交本特性时按项目纪律走 **commit-own-changes** 只收 session-tab hunk。
- 本评审未对 wake.ts/wake.test.ts 内容做判定（不在本次变更清单内），仅提示归属。

## 9. 结论

架构与官方插槽契约、参考实现、前端类型体系高度一致；prefs 校验链（白名单 → merge → 全量重校验 → 原子写）、快照过滤、归属守卫逻辑正确且有实证测试；样式注入方案可行（除一个 token 笔误）；类型层 `ConvViewProps`/`LocaleNamespaceMap` 用法经 d.ts 链与 tsc 双重实证。**未发现 P0**。

P1 两条为安全与契约硬化，建议修复：① sessionId 路径穿越（一行白名单）；② 动作作用域收敛为单一来源并对 prefs 动作补守卫/一致性校验。P2 优先处理 accent token 笔误与 prefs 下界对齐，其余（竞态、输入丢字、i18n、host-panel 孤儿、全局开关）可随后续迭代。

**结论：P1 修复后准入。**