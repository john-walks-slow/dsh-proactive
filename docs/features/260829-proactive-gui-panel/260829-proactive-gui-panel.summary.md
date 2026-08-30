# dsh-proactive GUI 管理面板 · 总结

日期：2026-08-29 · 阶段：Summary

## 成果

v2 给 dsh-proactive 插件增加 Web GUI 管理面板，三块能力全部落地：

1. **配置界面 + 热更**：注册官方 proactive settings namespace（ctx.settings.register），Web 设置面板自动渲染表单；settings watch → 原地 mutate 单一 config 快照对象（scheduler/wake/tools 共持引用），quietHours/预算/重试等改即生效，无需重启。v1 的 config.json/env 作为 composition base 层继续生效。
2. **闹钟管理面板**（设置 → Proactive 页签，官方 settings.section slot）：列表展示全部闹钟（状态/模式/下次触发/唤醒原因），支持新建、暂停/恢复（新增 AlarmStatus "paused"）、立即触发、取消；runs 审计最近 200 条。
3. **数据通道自建**：ctx.webserver.register 三条路由 /api/dsh-proactive/{state,action,events}（GET 快照 / POST 闭式命令 / SSE 推送），webserver 缺失时优雅降级；面板与模型工具共用 alarm-factory 的同一套校验与错误码，契约零漂移。

## 关键决策（已与用户对齐）

- 入口 = 设置面板内「Proactive」页签（非侧边栏）
- 面板 = host 级管理台，显示/操作全部闹钟（归属会话作展示）
- v2 边界：不做跨设备同步/按会话细分权限/runs 分页
- wake_reason 收敛为 `heartbeat`/`alarm` 两个值（原 check_in/interval/companion 合并并改名为 heartbeat；旧存储值兼容：输出 schema 不设 enum、framing 回退显示原始值）
- 心跳预设：设置面板新增 `heartbeatPrompt`（默认心跳提示词）与 `heartbeatEverySeconds`（默认 60 分钟），面板「心跳预设」一键预填（wake_reason=heartbeat）
- `proactive_no_reply` 对**任何唤醒原因**可用（含用户委托 alarm）：角色扮演等场景允许"静默不理更真实"的收尾，不需要只限 heartbeat
- 唤醒历史摘要：「最近唤醒」runs 表新增思考（reasoning）与回复（text）摘要列——observer 从会话日志切片提取两类块，各截断 200 字符存入 RunRecord（旧记录无字段兼容，显示"—"），面板悬浮看全文；帮助理解模型唤醒决策（尤其静默 no_reply 的理由）

## 技术要点

- 双面插件形态：host 半边 += panel/{contract,service,routes}.ts + settings.ts + alarm-factory.ts；浏览器半边 = src/client/*（React 18 + esbuild 构建为 window.__ModuleLoader__.load lazy-CJS bundle，react/@deepseek-ai/* 外部化）
- package.json 新字段：exports["./client"]、dsh.client = { inject, platform: "web" }
- store 增加 onChange 订阅（SSE 事件源）+ listRecentRuns
- scheduler 回归修复一处 flaky 条件等待

## 状态

- P1（host）+ P2（client）完成；tsc 全绿；单测 86/86（含 wake_reason 收敛回归：输出 schema 兼容旧值、闭式拒绝旧值、framing 回退、heartbeat 默认配置、唤醒摘要提取/截断、摘要落盘链路、config 超长钳制、emoji 安全截断）三连稳定
- 构建：npm run build（tsc build + esbuild client bundle → lib/client.js）
- M4 安装与验收（需重启 dsh web）留待用户，见 validation.md v2 区

## 风险与遗留

- 面板交互（表单/刷新/报错）未经真实浏览器 E2E，待 M4 人工验收
- settings 热更覆盖范围：dataDir 不可热更（构造时固化），其余字段可 live
- 配置出错回退：schemastery schema 保证类型/枚举合法，暂不支持面板内回滚历史
