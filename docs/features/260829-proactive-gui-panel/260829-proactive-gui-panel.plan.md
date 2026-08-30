# dsh-proactive GUI 管理面板 · 计划

日期：2026-08-29 · 阶段：Plan（已对齐 ✅）· 前置：260829-proactive-gui-panel.research.md（机制实证）

> **决策记录（2026-08-29 Align）**：① 入口 = 设置面板内「Proactive」页签（settings.section 官方 slot）；② 权限 = 面板为 host 级管理台，显示/操作全部闹钟（归属会话作展示列）；③ v2 边界按 §6 执行。

## 1. 目标

给 Web GUI 增加**Proactive 闹钟管理面板**：

- 可视查看所有闹钟（触发方式、下次触发、状态、归属会话、run 历史）与最近审计（runs：decision/budget/note）
- 直接创建/编辑/取消/启用停用闹钟，立即生效（scheduler 联动）
- 配置（安静时段/每日预算/重试等）在设置面板中编辑，**即时热生效**，不再依赖 config.json 手改
- 面板与模型工具的领域契约完全一致（同一套校验/错误码/归属检查），谁操作都不会漂移

## 2. 用户路径

P1（看）：Web GUI → 设置 → Proactive → 「闹钟」页签：表格列出 alarms（下次触发倒计时、状态徽标、模式、来源会话），下方最近 runs 摘要；订阅 SSE，任何变更实时刷新。
P2（改）：点「新建」弹表单（提示词/触发方式/重复/唤醒原因/交付渠道）→ 保存即时生效；行上操作：暂停/恢复、立即触发一次、取消、删除。
P3（配）：设置面板「常规」页签：quietHours/每日预算/重试次数/默认打盹时长，改即生效；改坏回退校验拦截。

## 3. 架构

### 3.1 双面插件（对齐平台机制）

| 面 | 运行处 | 内容 |
| --- | --- | --- |
| host 半边（现有） | 宿主进程 | domain/store/scheduler/wake/tools + **新增** panel-routes/panel-service/config-settings |
| client 半边（新增） | 浏览器 bundle | React 面板（src/client/*）+ HTTP/SSE 传输 + settings.section 注册；package.json 声明 dsh.client = { inject, platform:"web" } + exports["./client"] |

cordis.patch.yml 仍是裸包名一行 insert（v1 同款，bundle 加载器按 dsh.client 自动装配浏览器半边，task-board 实证）。

### 3.2 数据通道（每条都有官方注册面，不 fork 平台）

1. **配置**：`"proactive"` settings namespace。ctx.settings.register(ns, schema, { applies:"live" })；config.ts 重构为运行时快照服务（ConfigService）：初始值 = settings 解析结果，监听 scope.watch → 深比较差异 → 重新解析（quietHours 等立即替换，scheduler 全部按需读快照）→ 面板与 tools 共用同一个 config 读取。v1 config.json 兼容：首次无 settings 用户段时把 config.json 值作为默认层合并并提示（迁移一次性）。新增 DSH_PROACTIVE_* 环境变量语义：仍有效，作为默认层之上的一层（预留给调试）。
2. **运行时状态 + 命令 + 推送**：ctx.webserver.register 三条路由（dataDir 无关、纯内存服务）：
   - GET  /api/dsh-proactive/state   → { alarms: AlarmView[], runs: RunsWindow, config: 快照 }
   - POST /api/dsh-proactive/action  → 闭式命令 load：{ kind:"create"|"edit"|"cancel"|"toggle"|"fire", ...}，校验/归属检查/落库/requestDrive，返回新快照
   - GET  /api/dsh-proactive/events  → SSE：scheduler/store 每变更广播 alarms-changed / runs-append，EventSource 推送（心跳 15s）
3. **展示**：settings.section 官方 slot（'settings.section'）注册 id="proactive" 面板；owner 收 {close}；React 组件直接 fetch + EventSource（同源 /api，无需 CORS）。

### 3.3 领域契约单一性

- 把 tools.ts 的 validateCreateArgs/buildAlarm/inputError 系列**上提/复用**到 domain.ts（或新增 panel 专用但引用同一实现），UI action 与模型工具共用 create/cancel 逻辑与闭式错误码
- AlarmView = toAlarmView 的同一函数；runs 读取 = store.listRuns 的同一封装
- 归属检查：action 按 sessionId 过滤沿用 store 语义；extra 校验 cancel 的权力边界（host 面板操作视为用户本人，等同 v1 的 scheduler 权限）

## 4. 实现方案（模块级）

### 4.1 host 半边新增/改动

| 文件 | 内容 |
| --- | --- |
| src/panel/contract.ts | action/state/SSE 负载的封闭类型 + 错误码（复用闭式码 + DUP/UNKNOWN 之类新增码） |
| src/panel/service.ts | ProactivePanelService：读快照、执行 action（复用领域层）、SSE 发射器（订阅 store/scheduler 变更 → 广播） |
| src/panel/routes.ts | 三条 WebRoute 注册（ctx.webserver.register inject ["webserver"]），body 上限/loopback 校验参照 task-board |
| src/config.ts | 改为 ConfigService：resolveConfig 保留（初始），新增 applySettingsPatch（热更）+ watch 接线；scheduler/tools/wake 读取点改为取快照 |
| src/index.ts | 装配：settings.register + installSettingsSection 接线 + webserver 注册 + 变更广播 hook |
| src/domain.ts | （小幅）导出供 panel 复用的校验/构造函数签名整理 |

### 4.2 client 半边新增

| 文件 | 内容 |
| --- | --- |
| src/client/index.ts(x) | apply(ctx)：slot 注册（settings.section）、transport 装配、locale 注册（zh/en） |
| src/client/panel/AlarmsTable.tsx | 列表表格（状态/下次触发/模式/操作） |
| src/client/panel/AlarmForm.tsx | 新建/编辑表单（复用同款字段：prompt/trigger/wakeReason/delivery） |
| src/client/panel/RunsFeed.tsx | 最近 runs 列表 |
| src/client/panel/index.tsx | 面板组（section 入口） |
| src/client/host-api.ts | HttpProactiveHostTransport：state/action/events(SSE) + 重连/心跳 |
| src/client/apply-guard.ts | 防重复挂载（task-board 同款） |
| src/client/locales.ts | zh/en 文案（NS="proactive"） |

### 4.3 构建链

- 新增 devDeps：react/react-dom ^18、vite（library mode，css-modules 顺手）或 esbuild；@deepseek-ai/dsh-client-runtime、-connection、-ui-settings 的 client 类型（peer 或 dev）
- scripts：`"build:client"` = vite build（入口 src/client/index.ts(x) → lib/client.js + .map）；`npm run build` = tsc(host+types) + build:client
- npm test 仍只跑 host 侧单测（node --test，行为不变）

### 4.4 安全

- 路由注册于宿主 webserver（信任围栏已覆盖 /api 全部请求）；只走 loopback（web profile 默认 127.0.0.1）
- body 上限 64KiB（参照 task-board）；JSON 校验先行；错误走闭式码 + HTTP 4xx
- action 无副作用外溢：只在 store + scheduler 内生效，不暴露文件/系统能力

### 4.5 测试与回归

- host 单测新增：config 热更（settings patch → 快照替换 + scheduler 读取新值）、panel action 生命周期（create→list→toggle→fire→cancel 全链路 + 错误分支）、SSE 发射（变更触发广播）、loopback/body 校验
- 既有 62 项回归保持绿；tools/wake 不受影响（config 读取点改造后全量重跑）
- client 侧：构建 smoke（vite build 成功 + lib/client.js 存在），交互走 M4 人工验收

## 5. 分期

P1（host 端到端）：ConfigService 热更 + settings namespace + panel contract/service/routes + SSE 广播 + 单测 —— 此时 curl 可验证全部 API。
P2（client 面板）：React 面板 + transport + slot 注册 + 构建链 —— 浏览器可见可操作。
P3（收尾）：README/文档（安装后 App 中出现设置项）、review、commit。
M4：装进 web profile（重启 dsh 会中断会话，交由用户）、validation 清单验收。

## 6. 明确不做（v2 边界）

- 独立侧边栏入口/中心列面板（task-board 风格 DOM mount）→ 列入 v3 候选（高级：需应用巡视 slot）
- 闹钟跨设备/多实例同步（保持 v1 单进程文件锁语义）
- 面板级的权限细分（沿用宿主信任围栏 + host 级归属检查，不做按会话细分）
- runs 分批分页（固定最近 N=200 窗口，与 v1 滚动一致）

## 7. 验收清单（草案，M4 时并入 validation.md）

1. web profile 重启后，设置面板出现 "Proactive" 入口并打开2. 通过面板新建"10 分钟后"闹钟 → 状态栏出现 scheduled + 倒计时正确3. 面板取消 → 回到空列表；到点不再触发（用短 delay 实测）4. 面板暂停 → 到期跳过且不进 runs 的 fired 计数5. 面板立即触发 → runs 出现一条 + decision 正确（配合 no_reply）6. 改 quietHours 为当前时段 → 下一个非 alarm 唤醒被延迟（面板写的配置即时生效）7. 模型调用 proactive_set 创建的闹钟在面板立即可见（双向一致）8. 面板新建的闹钟可用 proactive_list 查到（反向一致）9. 同时开着两个标签页，一边操作一边看另一边 SSE 实时刷新10. 非法输入（重复 every<300、坏时区、超长 prompt）被表单/API 拦截并给出闭式错误码
