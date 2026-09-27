# dsh-proactive AGENTS.md

## 目标

为 DeepSeek Harness（DSH）实现"模型主动跟进"：模型可给自己订 host 级闹钟，冷会话也能按时被唤醒；唤醒回合可用 `no_reply` 静默收尾（用户无感知）。同时沉淀 DSH 插件开发的最佳实践。

## 地图

- `packages/dsh-proactive/` — 插件源码（cordis 4 函数插件；TypeScript + node:test）
- `docs/features/260829-dsh-proactive/` — 特性文档（research/plan/summary/validation/review）
- `docs/features/260918-declared-schedules/` — 声明式闹钟文件（scheduleFiles glob → 条目幂等同步；world master `.life/wake_schedule.json` 对接，见 plan.md）
- `docs/features/260918-quiet-drop-min-idle/` — 安静时段直跳 + `min_idle_seconds` 静默门（respect=true 窗内 occurrence 丢弃快进；defer-until-idle，见 plan.md）
- 参考实现（只读）：`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 下的 dsh-schedule、dsh-tools、dsh-agent、dsh-llm、dsh-session 等

## 开发与调试

- 构建/检查/测试（在包目录）：`npm run check `/ `npm run build `/ `npm test`（tsc 编译到 dist 后 node --test）
- 产物在 `lib/`；运行时依赖声明为 peerDependencies，开发镜像装 devDependencies
- 安装到 web profile：bundles + `cordis.patch.yml` 一行 insert；重启 dsh 服务生效（重启会使本会话中断——安排验收时注意）
- 数据落盘：`$DSH_HOME/proactive/`（alarms.json / runs.jsonl / state.json / config.json）

## E2E（涉及真实 agent 路径的验证）

在包目录（`packages/dsh-proactive`）用 dsh-e2e 起最小实例（dsh-base + dsh-web-app + 本插件，worktree 自动推断）：

```bash
cd packages/dsh-proactive
dsh-e2e start --wait-ready     # 启动并等就绪（~20s，~300MB）
dsh-e2e run <脚本.mjs>         # 跑 e2e（本 worktree 内自动串行）
dsh-e2e stop                   # 停止并释放槽位
```

- 脚本内读 `DSH_E2E_PORT`（连接 URL）、`DSH_E2E_HOME`（本 home，数据落盘断言用：`$DSH_E2E_HOME/proactive/`）
- 禁止硬编码端口与 `/root/.dsh-e2e` 旧路径（已废弃）
- 闹钟/唤醒回合类验证天然要等真实时间：优先用短间隔闹钟 + turn/end 轮询会话日志的写法（参考 dsh-cd 的 cd-tool.mjs 模式：marker 唯一性定位会话 + zstd 解日志断言）
- 线上整树回归（多插件交互）另走 restart-dsh skill 的临时实例，与本流程分开

## 规范

- 所有相对导入用 `.js` 后缀（NodeNext）；不要用 enum/namespace（坦白说 type 与接口均可）
- 写文本文件（含中文文档）用 write 工具；把 `` 与 `$` 放模板字面量时需要转义（用占位符后再替换，见历史会话）
- 平台 API 以 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 内 .d.ts 为准：defineTool(parameters 每属性 required:true)、exec.concludeTurn()、ctx.agents.resume({resumeSessionId})、agent.runMaintenance（忙时同步抛错）、agent.followup / whenIdle、notice 来源需 summary 字段
- 单测只测纯函数与调度逻辑；涉及真实 agent 的路径只能靠 E2E 验收（见 validation.md）
