# dsh-proactive

让 DeepSeek Harness 的模型**主动跟进**：给自己定 host 级闹钟，即使会话已冷却也会按时被唤醒；唤醒回合可以选择 `proactive_silence` 或 `no_reply` 静默收尾——用户完全无感知。

闹钟模型：

- **三种触发类型**：`once`（单次）/ `every`（循环间隔）/ `cron`（五字段表达式），统一支持 `jitter_seconds` 随机延迟。
- **安静时段与预算**：`respect_quiet_hours`——`false`（默认）表示用户委托提醒：安静时段照常触发、不占日预算；`true` 表示模型自主跟进：遵从安静时段与日预算。
- **多种目标会话模式**：`resume`（既有会话，默认）/ `fork`（从源会话 fork 出新会话）/ `new`（新建独立会话）。
- **会话表面折叠（Compaction）**：静默唤醒回合支持在模型会话表面自动压缩/墓碑化，彻底避免唤醒历史污染后续长上下文。

## 目录结构

本仓库核心插件源码位于 `packages/dsh-proactive`：
- `packages/dsh-proactive/`：DSH Proactive 插件主体代码与测试。

## 安装

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-proactive#path:/packages/dsh-proactive
```

详情与完整配置请见 [packages/dsh-proactive/README.md](packages/dsh-proactive/README.md)。

## License

MIT
