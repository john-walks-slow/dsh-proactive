# proactive 唤醒上下文注入审计 + 改法决策

## 执行结果（2026-09-16 12:40 更新）

**已完成：MCP 瘦身（live 生效，未重启）**

- firecrawl（68KB/26 工具）、camoufox_mcp（18KB/42 工具）、fetch（4KB/6 工具）已从运行实例禁用（`mcpPanel/status` API 实测 enabled=false, toolCount=0）
- degoog（4.4KB/2 工具）按用户要求保留注册
- tool catalog 从 ~150KB 降到 ~60KB，**每次 request header（含所有冷唤醒）省 ~90KB**
- 根因：09-11 dsh-mcp-panel 写的 `- set: {...}` 不是 cordis patch 引擎语法（applyEntryPatches 只读顶层 id/insert/name，`set:` 包一层 = id 未定义被 skip）——所以当时"禁用"从未生效。正确写法是 `- id: X` + `disabled: true`
- web profile `patchReload: "live"` 热重载实测有效，两次编辑均即时生效

**待办（未做）**
- B：proactive 工具描述精简（15KB→~5KB），本插件内改，需重启 host 侧
- D：最小化唤醒评估器（架构演进方向）

## 审计明细（yu roleplay 会话实测）

单次**冷**唤醒 ≈ 160KB(header 重建) + 33KB(逐 turn 注入) + 种子历史。

| 注入物 | 大小 | 来源 | 能否减 |
|---|---|---|---|
| tool catalog | 150KB (119 工具) | 平台 host-plane + preset | **能，大头** |
| └ firecrawl MCP | 68KB (26 工具) | mcp cordis.patch.yml host-plane | **能，最大** |
| └ camoufox MCP | 18KB (42 工具) | 同上 | **能** |
| └ proactive 工具 | 15KB (5 工具) | 本插件 | 能，删冗余描述 |
| └ mnemon 工具 | 13KB (15 工具) | mnemon 系统 | 难 |
| └ degoog/fetch/exa MCP | ~10KB | host-plane | 能 |
| system prompt | 10KB | preset persona + host | 有限 |
| runtime context 快照 | 1.7KB | 平台 | 不能 |
| workspace 指令 | 3.5KB | AGENTS.md | 能，可精简 |
| mnemon runtime memory | 28KB | mnemon | 能，但跨系统 |
| framing（本插件注入） | 0.4KB | 本插件 | 已极简 |

## 根因

冷 resume 时 system prompt + tool catalog **不存 session 日志**，每次都要重装。proactive 目标是冷会话（进程被 evict 省内存），所以每次全量重建。live 会话走 followup 不重注入。

## 改法选项（按 leverage 排序）

### A. MCP 从 host-plane 下架，收进「tooling 预设」（最大头，~86-96KB）
- firecrawl + camoufox（+exa/degoog/fetch）现在全局注入，所有会话都背。
- 改 cordis.patch.yml，把 MCP 从全局移到 dev/omni 预设，让 roleplay/general 人设会话不背 web 抓取工具。
- 风险：需要 dsh 重启（用户有"先不要重启"指示，需书面同意）；影响所有会话的工具可用性；E2E 隔离实例可先验证。

### B. 精简 proactive 工具描述（本插件内，~15KB→~5KB，省 10KB）
- proactive_set/list/update/cancel/no_reply 的 description 冗余度高（同字段重复解释）。
- 纯本插件代码，host 侧改完需重启才生效；风险低。

### C. 精简 roleplay 的 workspace 指令 + mnemon 注入（~30KB）
- yu 的 AGENTS.md/IDENTITY.md/SOUL.md 3.5KB 偏大；MEMORY.md 7KB 逐 turn 投影成 28KB。
- 跨 mnemon 系统，改动面广。

### D. 架构：最小化唤醒评估器（最省，但工作量最大）
- 心跳/要不要说话的二元决策，不该背 119 个工具 + 全量 persona。
- 方案：不 resume 全量会话，用「persona 摘要 + 近期上下文 + 仅 no_reply/send_im」的轻量评估器；只有要回复才 escalate 到全量会话。
- 需平台支持「带工具子集 resume」或本插件自建评估器。长期正确方向，短期工作量最大。

## 建议

- 立即做：**A（firecrawl+camoufox 下架 host-plane）**，收益最大且是纯配置；
- 顺手做：**B**，本插件自己的卫生；
- 中期：**D** 作为架构演进方向。

## 待决策

1. A 需要 dsh 重启（违背当前"先不要重启"指示），是否现在推进？
2. 优先级：A+B 先做，还是先做 D 的架构验证？