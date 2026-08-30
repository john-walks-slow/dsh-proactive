# dsh-remote-unlock

DSH 远程配置面解锁补丁的**按需应用器**（校验和锚定、幂等）。

## 背景：为什么是文件补丁，而不是插件

DSH 0.1.x 把配置面（`settings.*` / `credentials.*` / `agentPreset` 创作 / `host` 对话框 / `llm.discoverModels`）钉死在 loopback，有两道闸：

1. **客户端** `dsh-client-connection/lib/client.js`：页面 origin 非 loopback 时设置镜像进入 `persistence="memory"` 永不读取 → 报「settings are unavailable in this browser」
2. **服务端** `dsh-client-connection/lib/index.js`：特权方法（`PRIVILEGED_METHODS`）对非 loopback Host 一律 `403`

做成插件做不到（已逐一验证，2026-08-30）：

| 尝试 | 结果 |
| --- | --- |
| 插件注册自己的 `/api` 前缀路由遮蔽原网关 | ❌ `webServer.register` 对重复 `(kind, path)` 直接抛错 |
| 请求中间件/拦截器 | ❌ webServer 只有 exact/prefix/upgrade/fallback/index-tap，无通用中间件 |
| 覆盖 `HostConnectionService` | ❌ 特权检查在 connection 插件自己的 fetch 闭包内，外部够不着 |
| 客户端插件改写 `isLoopback` | ❌ 服务重复 provide 冲突、应用顺序不可控、派生硬编码 location.hostname |
| cordis include/loader 的 `patches` | ❌ 只做插件条目级增删启停，非代码级 |

所以只能改 node_modules 原文；本目录负责把这次改动**可复现、可校验**地管理起来。

## 用法（按需，无任何自动接线）

```bash
cd /root/projects/dsh-proactive/packages/dsh-remote-unlock

node apply.mjs --status   # 看状态表（patched / pending / drifted）
node apply.mjs --check    # 校验：全部在位退出码 0，否则 1
node apply.mjs --apply    # 重打：把所有 pending 精确替换并逐字节校验
node apply.mjs --apply --silent   # 静默（成功无输出）
```

**什么时候用**：`npm update @deepseek-ai/dsh` 之后（node_modules 被覆盖）、补丁文件被人动过、或想确认补丁是否在位。每次重打幂等，可反复跑。

## 工作原理

`spec.mjs` 里每个补丁条目三要素：

- `baseSha` — 未打补丁原文件的 sha256（升级后新文件若等于它 = 待打）
- `patchedSha` — 打完后文件的 sha256（当前文件若等于它 = 已打）
- `old` / `new` — 精确文本替换（`old` 必须在 base 中恰好出现一次）

比对哈希决定状态，绝不盲打：

- 已打 → 跳过
- 待打 → 精确替换 → 替换结果 sha 必须等于 `patchedSha` 才写回（防 spec 内部不一致）
- **漂移**（升级改了上游代码，base 对不上）→ 大声警告 + 不动文件，退出码 0（`--strict` 下非零）。**绝不乱打**

当前打的两处补丁（详见 issue `docs/issues/260830-remote-settings-unavailable/`）：

1. `lib/index.js`：特权方法改走部署 `trustedHosts` 围栏（`isTrustedApiRequest(request, trustedHosts)`，原来硬编码 `[]`）
2. `lib/client.js`：`isLoopback: true`（远程全功能；所有者已知晓并接受安全代价：公网可读配置/凭据来源/discoverModels 主机侧探测，残余防线=仅放行已声明 trustedHost 的权威 + DNS-rebinding 校验）

## 漂移后的重锚定

上游代码段变了导致 drifted 时，两种做法：

1. **手工**：把 node_modules 文件恢复成未打补丁形态（或用 `lib/*.bak-remote-unlock-*` 备份），再跑 `node apply.mjs --apply`；若新旧差异已变，先手工编辑 `spec.mjs` 的 `old/new` 与两个 sha。
2. **交互**：`node apply.mjs --reanchor` — 以当前文件内容为新 base，自动求出补丁后 sha 并写回 spec（逐文件确认；`old` 找不到/多次时才需要手工）。

> 升级前建议：`cp lib/index.js* lib/client.js* 的新 .bak` 并按 1 更新 sha。若上游某天自带了认证层（trustedHosts 升级为真认证），此补丁即可退役——把 `spec.mjs` 整个删掉即可。

## 回滚

恢复原始文件 + 重启 dsh：

```bash
B=/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib
cp $B/index.js.bak-remote-unlock-20260830-230306 $B/index.js
cp $B/client.js.bak-remote-unlock-20260830-230306 $B/client.js
# 然后重启 dsh（会中断当前会话）
```

## 复现安装

本目录即"安装"（无需复制到系统路径）；若容器重建，`spec.mjs` 里的绝对路径可能变化，按上面「重锚定」调整即可。