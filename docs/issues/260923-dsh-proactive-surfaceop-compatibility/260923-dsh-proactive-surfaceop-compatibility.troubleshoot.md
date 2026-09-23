# 排查诊断：DSH 升级对 dsh-proactive 的兼容性影响与静默失效分析

- 问题编号：`260923-dsh-proactive-surfaceop-compatibility`
- 日期：2026-09-23
- 状态：已确诊（置信度 100%）

---

## 1. 现象描述

随着宿主平台核心库 `@deepseek-ai/dsh-session` 升级（由 0.1.1/0.1.2 升级至 0.1.5-rc.3），`dsh-proactive` 的静默唤醒表层折叠（Silent Wake Compaction）机制发生静默失效：
- 闹钟按时触发冷会话唤醒；
- 模型判断无需回复用户，调用 `proactive_reclaim` 静默结束；
- 宿主日志抛出异常（被 `compactWake` 内部的 `try...catch` 降级为 warn 日志，未阻断调度器主流程）：
  `wake compaction skipped for alarm xxx: session event "user/message" carries an invalid replace surfaceOp`
- **实际后果**：本应被压缩收拢为单行 tombstone 的唤醒回合（包括 framing 提示词、assistant 思考流、工具调用与结果），全部未经压缩直接滞留在会话表层，导致会话上下文随着周期性唤醒不断膨胀。

---

## 2. 根因分析

经过对 DSH 0.1.5-rc.3 平台源码及 `dsh-proactive` 源码的深入比对，确认存在两个直接导致失败的根本原因：

### 2.1 原因一：`surfaceOp.replace` 字段名不契合
在 DSH 0.1.5-rc.3 中，平台对表层替换事件引入了严格的 `isReplaceOp` 结构校验（`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js`）：
```javascript
function isReplaceOp(value) {
    const op = value;
    return Object.keys(op).length === 3
        && Object.hasOwn(op, 'op')
        && Object.hasOwn(op, 'startSeq')
        && Object.hasOwn(op, 'endSeq')
        && op['op'] === 'replace'
        && isEventSeq(op['startSeq'])
        && isEventSeq(op['endSeq']);
}
```
必须且只能包含 `op: 'replace'`, `startSeq`, `endSeq`。
而 `packages/dsh-proactive/src/compact.ts`（第 156 行）构造 replacement 属性时传入：
```typescript
surfaceOp: { op: "replace", start: run.seqs[0], end: run.seqs[run.seqs.length - 1] }
```
字段名为旧版的 `start` 和 `end`，被平台校验器直接判定为非法并抛出 `session event "user/message" carries an invalid replace surfaceOp`。

### 2.2 原因二：`assistant/message` eraser 机制与平台契约互斥
在 `packages/dsh-proactive/src/compact.ts` 中，作者原本的设计是：
- 将 framing run 替换为 `user/message`（即 tombstone 墓碑）；
- 将后面的 assistant/tool exchange run 替换为一个内容为空的 `assistant/message`（eraser），企图利用空内容 assistant 消息被 `deriveEventMessage` 映射为 null 的特性，让助手回复和工具执行从模型上下文隐形。
- 为此，它向 `assistant/message` 传递了 `sourceEventSeqs: [...run.seqs]`。

但在 DSH 0.1.5-rc.3 中，存在两条硬性断言：
1. `validateSurfaceMetadata` 断言：
   `if (event.type === 'assistant/message' && raw !== undefined) throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs')`
   即：`assistant/message` **禁止携带 `sourceEventSeqs`**。
2. `replacementRange` 断言：
   `surface replace: sourceEventSeqs must include every shadowed surface node`
   即：任何表层替换操作（`surface replace`）**强制要求必须携带完整的 `sourceEventSeqs`**。

这两条断言互相矛盾，导致在 DSH 0.1.5-rc.3 下，**`assistant/message` 根本无法执行 surface replace 操作**！如果追加 eraser，必抛异常。

---

## 3. 修复方案

根据与平台官方压缩设计（参考 `dsh-compaction`、`dsh-clear-mind`）对齐的最佳实践：

### 3.1 方案演进与架构对齐
1. **统一单 run 折叠**：
   静默唤醒的整个回合（从 `framing` 开始到本回合结束的所有 owned surface 节点）本身就是一个连续的逻辑单元。
   无需拆分为「framing 变墓碑」+「后续 exchange 变空 assistant eraser」的复杂多 run 方案，直接将该 wake 回合从首个 owned 节点（framing）到末尾 owned 节点的连续区间，一次性替换为单条墓碑 `user/message`。
2. **规范 `surfaceOp` 格式**：
   使用 `{ op: "replace", startSeq: run.seqs[0], endSeq: run.seqs[run.seqs.length - 1] }`，严格对齐平台 0.1.5+ 契约。
3. **前置 `compaction/prune` 影子价格事件（可选但推荐）**：
   按照 `dsh-clear-mind` 与 `dsh-token-meter` 的 shadow-price 协议，在追加 replace 之前写入一条 `compaction/prune`，确保 `token-meter` 在计算会话 token 压力时能够精确扣减被折叠掉的节点 token。
4. **对齐依赖版本与更新单测**：
   - 将 `packages/dsh-proactive/package.json` 中的 `@deepseek-ai/*` 依赖升级至 `0.1.5-rc.3`；
   - 更新本地 `node_modules/@deepseek-ai/*`；
   - 修复与更新 `compact.test.ts` 及 `wake.test.ts` 中涉及 `surfaceOp` 的测试用例。

---

## 4. 置信度与影响评估

- **置信度**：100%（问题复现代码 100% 确认报错，根因清晰）。
- **影响范围**：
  - 仅限于静默唤醒的上下文折叠模块（`compact.ts`）；
  - 修复后将恢复静默唤醒的上下文回收能力，彻底避免长期运行后的会话 context 膨胀。
