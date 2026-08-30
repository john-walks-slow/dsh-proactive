# dsh-proactive GUI 管理面板 · 调研

日期：2026-08-29 · 阶段：Research（机制实证）

## 1. 背景与目标

dsh-proactive v1（M1–M3，已提交）是**纯后端插件**：4 个模型工具（proactive_set/list/cancel/no_reply）+ host 级闹钟调度，用户只能通过对话让模型操作闹钟；配置是文件级（$DSH_HOME/proactive/config.json + DSH_PROACTIVE_* 环境变量），无任何前端界面。

v2 目标：给 Web GUI 加一个**闹钟管理面板**——可视查看 alarms/runs、直接创建/修改/取消/启停闹钟、改配置，并且面板操作与模型工具走同一套领域逻辑（单一契约）。

## 2. 平台机制调研结论（全部带源码证据）

### 2.1 插件等于「双面」形态（host 半边 + 浏览器半边）

实证样板：web profile 已安装的第三方插件 @linxin666/dsh-client-ui-task-board（/root/.dsh/profiles/web/node_modules/）完整展示了第三方 UI 插件的官方形态：

- package.json 声明 dsh.client = { inject: [...], platform: "web" } + exports["./client"]；dsh.bundle.patch 一行 insert 挂进 profile bundles（与我们的 cordis.patch.yml 同款）
- node 半边（exports "."）跑在宿主进程；浏览器半边（exports "./client"，经 /plugins/<id>/client.js 提供）在 Web GUI 加载
- 浏览器半边按 cordis 插件契约：export const inject: string[]（fiber 注入等待）+ export function apply(ctx: ClientContext): void
- 前端可用 shell 已 seed 的 React（peerDependencies: react ^18.2.0）
- 构建链：第三方包用 tsc/vite 类流程产出 lib/client.js bundle + sourcemap（181 KB 实包），css-modules 等照常

### 2.2 UI 挂载 = slot 注册 + DOM 挂载

- ctx.slots.register({name, id, order, inject}, Component) 提交条目；ctx.slots.inject(name, cb) 声明依赖某个 slot（task-board 还给第三方群组 web-ui.plugin.item 做声明合并 interface SlotMap）
- 官方设置面板已有开放 slot：settings.section（kind list、scope root、owner 收 {close}）—— 声明见 @deepseek-ai/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts，类型已官方声明，第三方直接 register 即可（settings.trigger/header/action/close/onboarding/general.item 同源可用）
- 侧边栏/中心列等位置：task-board 用 DOM mount（React createRoot 或等价）自挂；外部插件 DOM 挂载问题记日志、绝不 throw（throw 会让整个 GUI boot 失败）

### 2.3 宿主 webserver 允许插件注册 HTTP 路由（含 SSE）

- @deepseek-ai/dsh-host-webserver：ctx.webserver.register({kind:'exact'|'prefix', path:'/api/xxx', handler})，handler 拥有完整响应生命周期（可保持 SSE 打开）；重复 (kind,path) 抛错（组合级契约）；另有 registerUpgrade / registerFallback / tapIndex
- 实证：task-board 用 /api/task-board/state（GET）、/api/task-board/action（POST）、/api/task-board/events（SSE EventSource）实现完整 host 传输层（HttpTaskBoardHostTransport：src/client/host-api.ts + src/host-routes.ts），并自带 loopback 校验 + 可选代理 token 头（x-dsh-task-board-proxy-token）
- 安全面：宿主信任围栏覆盖全部 /api 请求；task-board 的 loopback+token 防御可直接参考

### 2.4 配置 = 官方 settings namespace（开箱即用的配置界面）

- @deepseek-ai/dsh-settings：ctx.settings.register(ns, schema, {base?, applies?}) 完全开放；resolved = schema 默认 → 组合 base → 用户文档三层；乐观锁 revision；settings/updated（值变化）+ settings/document-updated（原始段变化）事件
- wire 全自动：settings.describe/update/replace/mutate 已由 dsh-host-apiproxy 暴露；settings/document-updated 在 host到client 转发白名单（API_REMOTE_FORWARDED_EVENTS）内 → 前端设置 UI 自动出现并刷新该 namespace，**无需自建前端也能有配置表单**（通用设置面板渲染 schemastery schema）
- host 侧还有 installSettingsSection(ctx, ns, schema, entry, hooks) 助手（task-board 用它接线：scope.watch → hooks.onChange 热更新）
- 环境实证：/root/.dsh/settings.yaml 已存在（llm-pi-ai 等 namespace）—— web profile 已装配 file provider

### 2.5 走不通的路（防走弯路）

| 通道 | 限制 | 证据 |
| --- | --- | --- |
| 自定义 RPC 方法（session.list 那种） | RpcMethodMap 静态注册，client 方法面由其机械派生 | dsh-host-apiproxy/lib/types/api/rpc-map.d.ts + fetch/client.d.ts |
| 自定义 host 事件转发给 client | API_REMOTE_FORWARDED_EVENTS 是常量数组，注释明言 Forwarding one more event is an entry here and nothing else，包在 node_modules 只读 | dsh-api-remotes/lib/index.js L18-30 |
| sessionProjections（会话投影） | 只按**会话事件**驱动折叠；alarms 是 host 级状态变更，不经会话事件 | dsh-session-projection/README（同步 fold + whole-value 纪律；token-meter 等先例都挂在会话日志上） |
| 迁移闹钟存储进 settings 文档 | 可行但重：settings 是用户配置文档语义，alarms 是运行时状态（高频写/revision 冲突/双写）——**不选** | dsh-settings README 的 provider/文档语义 |

## 3. 通道选型结论

1. **配置**：注册 proactive settings namespace（ctx.settings.register + installSettingsSection 助手），applies=live 监听 settings/updated 热更新（quietHours/预算等即时生效）；v1 config.json 作兼容导入。配置界面 = 通用设置表单（零前端开发）或自定义 section 精装修。
2. **alarms/runs 视图 + 命令 + 推送**：自建 ctx.webserver.register 路由 /api/dsh-proactive/*（state GET / action POST / events SSE），复用 v1 领域层（validateCreateArgs/buildAlarm/cancel 归属检查等）保证与模型工具契约一致；scheduler 每次变更后广播 SSE → 面板实时。
3. **面板入口**：settings.section 官方 slot（稳定、现成容器）；侧边栏独立入口（DOM mount，task-board 风格）作可选增强。
4. **前端**：React + css-modules，client.js bundle 自建构建链；inject = ['slots','settingsScope','remote',...]。

## 4. 参考文件索引

- 样板：/root/.dsh/profiles/web/node_modules/@linxin666/dsh-client-ui-task-board/{package.json,cordis.patch.yml,src/client/index.ts,src/client/host-api.ts,src/host-routes.ts,src/http.ts}
- slots 契约：@deepseek-ai/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts
- webserver：@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts
- settings：@deepseek-ai/dsh-settings/README.md + lib/types/index.d.ts（register/installSettingsSection）
- 限制证据：dsh-host-apiproxy/lib/types/api/rpc-map.d.ts、dsh-api-remotes/lib/index.js、dsh-session-projection/README.md

## 5. 待定设计点（进 Plan 决策）

- 面板交互：表格列表 + 新建/编辑表单（复用模型工具同款校验与错误码）；启用/停用开关语义（停用 = 新 status 字段还是归档？）
- runs 审计：面板展示最近 runs（decision/budgetDelta/note），容量上限与 v1 runs.jsonl 一致（滚动保留）
- 配置热更新边界：quietHours/maxDeliveriesPerDay/打盹时长可 live；生效失败如何回显
- 入口形态：settings section（推荐）vs 侧边栏独立项
- 安全：同源 + loopback 校验 + sessionId 归属检查沿用 v1（防跨会话越权）
- 构建链：client bundle 加入本包 build（tsc + esbuild/vite 二选一，参照 mcp-panel 的 prepare.mjs 风格）
