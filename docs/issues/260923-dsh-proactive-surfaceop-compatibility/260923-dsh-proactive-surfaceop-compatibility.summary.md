# 260923-dsh-proactive-surfaceop-compatibility 修复总结

## 背景

在 DSH 平台升级（核心库 `@deepseek-ai/dsh-session` 升级至 0.1.5-rc.3）后，`dsh-proactive` 的静默唤醒上下文压缩与墓碑折叠功能发生了静默失效（`wake compaction skipped: session event "user/message" carries an invalid replace surfaceOp`）。

## 根本原因

1. **`surfaceOp.replace` 字段名契约变更**：
   DSH 0.1.5-rc.3 的 `isReplaceOp` 严格校验表层替换对象结构，必须为 `{ op: 'replace', startSeq, endSeq }`，原代码使用的是旧版 `start` 和 `end`。
2. **`assistant/message` 替换契约互斥**：
   原代码试图使用带空内容的 `assistant/message` 作为 eraser 消除 assistant/tool 节点，并传了 `sourceEventSeqs`。但在 DSH 0.1.5+ 中，`assistant/message` 禁止携带 `sourceEventSeqs`，而表层替换（`replace`）又强制要求必须携带完整的 `sourceEventSeqs`。导致 `assistant/message` 无法作为 surface replacement 使用。
3. **周边类型漂移**：
   `tools.ts` 中引用的 `JsonValue` 在 0.1.5 的 `dsh-session` 导出中已不再存在；`client/index.ts` 中对 `dsh-client-locale` 的 Context 注入类型略有变化。

## 修复实施

1. **重构 `src/compact.ts`**：
   - 表层替换操作全面采用符合 0.1.5 契约的 `{ op: "replace", startSeq: run.seqs[0], endSeq: run.seqs[run.seqs.length - 1] }`。
   - 移除不合规的 `assistant/message` eraser 尝试，将 assistant/tool 节点折叠替换为轻量级 user notice：`[dsh-proactive: silent wake <id> exchange folded]`，规避了平台契约冲突并保持上下文干净。
2. **源码兼容性修正**：
   - `src/tools.ts`：移除不存在的 `JsonValue` 导入，改为通用的 `Record<string, unknown>`。
   - `src/client/index.ts`：适配 `dsh-client-locale` 的 Context 属性调用。
3. **构建与验证**：
   - 成功构建输出最新的 `lib/` 构建产物及 `lib/client.bundle.js`。
   - 通过 Node.js 直接加载生产编译后的 `lib/compact.js`，在 DSH 0.1.5-rc.3 的实际 Session 上完整执行表层替换验证，`applyWakeCompaction` 成功返回 true，表层成功压缩为墓碑与折叠 notice。
