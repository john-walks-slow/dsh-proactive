# 260102 补记 — compaction 表层替换契约漂移（3 条红了 16 天的单测）

> 撰写：2026-10-09。承接 `99-overview.md`（缺陷 1/2/3 的根因）。
> 本文只记录本次「准备重新开闸」时发现的一个独立问题及其处置。

## 一、怎么发现的

2026-10-09 排查「模型主动消息全失效」时，结论是总闸 `enabled:false`（见 `99-overview.md` §四）。
准备开闸前按规范先跑单测，`test/compact.test.ts` 报 **3 条确定性失败**（全量 309/312）。
这些失败与 `enabled` 无关，是长期存在的红测试。

## 二、根因：实现改了，测试没改

失败断言编码的是**「eraser」设计**：静默唤醒回合里，assistant/tool 交换用一个
**空 content 的 `assistant/message`** 做表层替换，`deriveEventMessage` 得到 `null`，
即「对模型不可见的节点」。

但平台在 0.1.5 起就**禁止 `assistant/message` 做 surface replacement**：

- `surfaceOp.replace` 强制要求 `sourceEventSeqs` 列全被遮蔽的 surface 节点
  （`surface replace: sourceEventSeqs must include every shadowed surface node; missing …`）
- 而 `assistant/message` **禁止携带** `sourceEventSeqs`
  （`assistant/message embeds its source stream and cannot carry sourceEventSeqs`）

两条规则互斥 → eraser 不可表达。`src/AGENTS.md` 的 Pitfalls 早已写明：
「折叠 assistant/tool exchange 须采用 user notice 形式」。

代码确实照做了：**b19a33b（2026-09-23）** 提交信息里就写着
「replace assistant/tool exchange with user notice instead of invalid assistant eraser」，
把实现改成一行 `user/message` notice，**但没同步改测试** → 3 条断言从那天起一直红。

## 三、处置（2026-10-09）

| 文件 | 改动 |
|---|---|
| `src/compact.ts` | 模块文档改为「非 framing run 折成一行 user notice」并写明平台为何不允许 eraser；删除死代码 `eraserMessage`/`eraserProvenance`（自 b19a33b 起无调用方）；`applyWakeCompaction` 去掉随之变死的 `events` 形参；`CompactSession` 去掉 `assistant/message` 重载；清理未用 import |
| `src/wake.ts` | 调用点同步；`compactWake` 文档改为 tombstone + fold notice |
| `test/compact.test.ts` | 「折叠后模型可见 2 条」→ 3 条（tombstone + snapshot + notice）并精确断言 notice 文案；「并发 shadow」用例改用手工构造合法的 0.2.0 replace 形态（`user/message` + 全量 `sourceEventSeqs`）——原用例自身用一个非法 replace 来模拟外部 /compact，抛错发生在 setup 而非被测代码；「eraser 回退」用例改为「含 framing 的单 run 整体折成 tombstone」 |

## 四、证据

- 单测：`test/compact.test.ts` 13/13（改前 10/13）；全量 **312/312**，tsc 0 错，build 通过。
- E2E（隔离实例，dsh 0.2.0-rc.2 真实 agent 路径，`e2e/wake-smoke.mjs`）：8/8 通过。
  关键两条：`new` 模式静默唤醒回合结束后，会话日志里**确实落下了 tombstone 的
  `surfaceOp.replace` 事件**（说明压缩在真实链路上成功而非静默 warn 跳过）；
  冷 `resume` 唤醒被正确判定为可见 reply。

## 五、遗留

- `scheduler.test.ts` 单跑 2/2 通过，但与其它测试文件**并发全量跑时偶发 1 例**
  「安静时段边界」失败（时间敏感，约 36ms 的用例）。属测试脆弱性，未处理。
- 本机 dsh 的 0.2.0-rc.2 peerDependencies 兼容问题（9ec11e6 已适配）与本次无关。
