# dsh-proactive AGENTS.md

## 目标

为 DeepSeek Harness（DSH）实现"模型主动跟进"：模型可给自己订 host 级闹钟，冷会话也能按时被唤醒；唤醒回合可用 `no_reply` 静默收尾（用户无感知）。同时沉淀 DSH 插件开发的最佳实践。

## 地图

- `packages/dsh-proactive/` — 插件源码（cordis 4 函数插件；TypeScript + node:test）
- `docs/features/260829-dsh-proactive/` — 特性文档（research/plan/summary/validation/review）
- 参考实现（只读）：`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 下的 dsh-schedule、dsh-tools、dsh-agent、dsh-llm、dsh-session 等

## 开发与调试

- 构建/检查/测试（在包目录）：`npm run check `/ `npm run build `/ `npm test`（tsc 编译到 dist 后 node --test）
- 产物在 `lib/`；运行时依赖声明为 peerDependencies，开发镜像装 devDependencies
- 安装到 web profile：bundles + `cordis.patch.yml` 一行 insert；重启 dsh 服务生效（重启会使本会话中断——安排验收时注意）
- 数据落盘：`$DSH_HOME/proactive/`（alarms.json / runs.jsonl / state.json / config.json）

## 规范

- 所有相对导入用 `.js` 后缀（NodeNext）；不要用 enum/namespace（坦白说 type 与接口均可）
- 写文本文件（含中文文档）用 write 工具；把 `` 与 `$` 放模板字面量时需要转义（用占位符后再替换，见历史会话）
- 平台 API 以 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 内 .d.ts 为准：defineTool(parameters 每属性 required:true)、exec.concludeTurn()、ctx.agents.resume({resumeSessionId})、agent.runMaintenance（忙时同步抛错）、agent.followup / whenIdle、notice 来源需 summary 字段
- 单测只测纯函数与调度逻辑；涉及真实 agent 的路径只能靠 E2E 验收（见 validation.md）
