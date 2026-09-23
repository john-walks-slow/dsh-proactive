# dsh-proactive 平台契约兼容性修复 用户验证要求

## 验证说明

- 验证对象：`dsh-proactive` 的静默唤醒上下文压缩与墓碑折叠（对齐 DSH 0.1.5-rc.3 平台契约 `startSeq` / `endSeq` 与单条 notice 替换）
- 环境/前置条件：DSH 运行时环境，Node.js >= 22.5

## 验证项

| 验证步骤 | 预期结果 | 实际结果 | 状态 | 备注/证据 |
| -------- | -------- | -------- | ---- | --------- |
| 1. 执行 TypeScript 类型检查 `npm run check` | 编译无任何类型报错 | | 待验证 | 针对 packages/dsh-proactive |
| 2. 运行完整单元测试 `npm test` | 310+ 项测试全部通过，包含 `compact.test.ts` 和 `wake.test.ts` | | 待验证 | |
| 3. 实机/隔离环境触发一次带 `proactive_reclaim` 的静默唤醒 | 唤醒回合成功折叠为单行 `[dsh-proactive silent wake ...]` 墓碑，不抛任何 `invalid replace surfaceOp` 异常 | | 待验证 | |

## 验证结论

待验证

## 待跟进

无
