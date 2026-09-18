# dsh-proactive

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

让 DeepSeek Harness（DSH）的模型**主动跟进**：模型给自己设定 host 级闹钟，到点由宿主唤醒目标会话执行一轮——即使会话早已冷却、页面早已关闭也会按时触发；无事可做的唤醒回合可以静默收尾并自动折叠，用户完全无感知。


![dsh-proactive in the DSH settings: new-alarm creation form with schedule types, jitter and quiet-hours, plus global wake config](assets/screenshot-1.png)

## 你会看到什么

- **定时提醒**：到点唤醒会话，模型按闹钟指令产出一条正常的聊天回复，按 DSH 既有投递规则送达（接了 IM 私聊的会话自动送达私聊，Web 会话内正常出现）。
- **静默心跳**：没有值得打扰用户的事时，模型调用 `proactive_reclaim` 静默收尾——不产生任何可见消息，整次唤醒交换被折叠成模型侧一枚小墓碑（`[dsh-proactive silent wake <id> <时间>]`），不污染长上下文。
- **Web 管理面板**：设置页出现「主动唤醒」节（全局配置 + 所有会话的闹钟表格），每个会话页多一个「主动唤醒」tab（本会话闹钟与唤醒历史），SSE 实时刷新。

## 闹钟模型

- **三种类型**：`once`（单次）/ `every`（循环间隔）/ `cron`（五字段表达式），统一支持 `jitter_seconds` 随机延迟。
- **一个开关**：`respect_quiet_hours`——`false`（默认）为用户委托提醒：安静时段照常触发、不占日预算；`true` 为模型自主跟进：安静时段内的触发直接跳过不补发，并遵从每日投递预算。
- **一个静默门**：`min_idle_seconds`——resume 目标可要求"目标会话静默满 N 秒才唤醒"，活跃时顺延不打扰（冷会话视为已静默）。
- **三种目标**：`resume`（既有会话，默认）/ `fork`（从源会话分支）/ `new`（新建空会话）。

## 安装

npm（预构建，推荐）：

```bash
dsh plugin --profile web add dsh-proactive
```

GitHub 源码安装（monorepo 子目录；pnpm ≥10 需允许构建脚本）：

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-proactive#path:/packages/dsh-proactive
# 建议钉住 commit：github:john-walks-slow/dsh-proactive#<sha>&path:/packages/dsh-proactive
# 首次 add 会被 pnpm 拦截：把 pnpm 提示的包名加入
# ~/.dsh/profiles/web/pnpm-workspace.yaml 的 allowBuilds 后重跑
```

完整配置、GUI 面板、工具清单与行为细节见 [packages/dsh-proactive/README.md](packages/dsh-proactive/README.md)。

## 权限与兼容

- **定时唤醒**：插件在宿主侧持有调度器（单定时器重臂），到点会唤醒目标会话执行一轮；服务重启后闹钟从 `$DSH_HOME/proactive/` 恢复。
- **通知渠道**：无推送服务、无外部集成——唤醒回合的可见回复走 DSH 正常消息投递；`proactive_reclaim` 回合零投递。
- **网络请求**：插件自身不发起任何外部网络请求；管理面板的 HTTP/SSE 路由（`/api/dsh-proactive/*`）只挂在本地 dsh webserver 上；唤醒回合由 dsh 按用户已配置的 LLM 网关正常调用。
- **文件写入**：仅 `$DSH_HOME/proactive/`（alarms.json / runs.jsonl / state.json / config.json）。

## 目录结构

- `packages/dsh-proactive/` — 插件源码、测试与构建产物（`lib/`），npm 包 `dsh-proactive`
- `docs/` — 特性与问题记录

## License

MIT
