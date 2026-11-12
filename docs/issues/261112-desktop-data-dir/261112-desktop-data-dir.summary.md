# 261112 — 桌面端闹钟从未落盘（data dir 解析到 /root/.dsh/proactive）

## 现象

- `proactive_list`（含 `all=true`）恒空，面板 `GET /api/dsh-proactive/state` 返回 `"dataDir": "/root/.dsh/proactive"`，`alarms` / `runs` 都是空的。
- `proactive_set` 无论参数如何都返回 `{"code":"persistence_uncertain","message":"The alarm was not durably stored; please retry."}`。
- 会话日志（zstd 解压后的 `session.v4.jsonl`）里可见同一分钟内连续 6 次 `proactive_set` 调用全部失败——用户当时以为「定时设置好了」，实际一条都没存下来。
- `$DSH_HOME/proactive/` 目录从未被创建。

## 根因

`src/config.ts` 的 `defaultDataDir()` 只认 `process.env.DSH_HOME`，兜底是硬编码的 `DEFAULT_CONFIG.dataDir = "/root/.dsh/proactive"`：

```ts
function defaultDataDir(): string {
  if (typeof process !== "undefined" && process.env["DSH_HOME"]) return process.env["DSH_HOME"] + "/proactive";
  return DEFAULT_CONFIG.dataDir;
}
```

桌面端宿主**不把 DSH_HOME 导出到自己的 process.env**：它在进程内用 `@deepseek-ai/dsh-home-paths` 解析 home，而插件与宿主同进程，读到的是宿主的 `process.env`。于是第一档落空、走 Linux 兜底 `/root/.dsh/proactive`；macOS 上没有 `/root` 也不允许创建 → `store.persist()`（`mkdir` + `writeFile` tmp + `rename`）抛错 → `tools.ts` 回滚 `addAlarm` 并返回 `persistence_uncertain`。

结果：**所有主动唤醒在最外层静默失效，且失败信息只在工具返回里闪一下**，用户侧看到的是「设了定时但没生效」。

## 修复

`defaultDataDir()` 增加用户主目录兜底，形成三档链（显式 `DSH_PROACTIVE_DATA_DIR` 仍然最优先）：

1. `$DSH_HOME/proactive` — 宿主导出了 DSH_HOME（工具子进程路径）
2. `$HOME/.dsh/proactive`（Windows 无 HOME 时用 `USERPROFILE`）— 宿主把 DSH home 留在内部、但目录布局不变的场景，桌面端即此类
3. `DEFAULT_CONFIG.dataDir` — 历史常量，最后兜底

## 验证

- 单测 `test/config.test.ts`：新增 4 个用例覆盖三档解析、Windows 的 `USERPROFILE` 分支、无任何 home 变量时的历史常量，以及 `DSH_PROACTIVE_DATA_DIR` 优先级不被改变。
- 手工：桌面端重启后 `GET /api/dsh-proactive/state` 的 `dataDir` 应为 `$HOME/.dsh/proactive`，`proactive_set` 返回闹钟对象并在该目录下生成 `alarms.json`。
- 已知与本修复无关的环境性失败：macOS 上 `test/schedule-file.test.ts` 的 `canonicalize` 用例因 `/var` → `/private/var` 的 realpath 前缀差异失败，HEAD 上同样失败。
