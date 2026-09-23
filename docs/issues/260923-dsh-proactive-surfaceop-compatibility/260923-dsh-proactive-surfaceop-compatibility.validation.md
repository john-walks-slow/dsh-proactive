# dsh-proactive 平台契约兼容性修复 用户验证要求

## 验证说明

- 验证对象：`dsh-proactive` 的静默唤醒上下文压缩与墓碑折叠（对齐 DSH 0.1.5-rc.3 平台契约 `startSeq` / `endSeq` 与单条 notice 替换）
- 环境/前置条件：DSH 运行时环境，Node.js >= 22.5

## 验证项

| 验证步骤 | 预期结果 | 实际结果 | 状态 | 备注/证据 |
| -------- | -------- | -------- | ---- | --------- |
| 1. 执行 TypeScript 构建 `npm run build` | 编译构建无任何报错，输出 lib/ 产物 | 成功生成 lib/ 产物与 client.bundle.js | 通过 | `tsc -p tsconfig.build.json` 通过 |
| 2. 在 DSH 0.1.5-rc.3 真实 Session 上测试压缩逻辑 | 包含 framing + tool exchange 的回合成功压缩，生成墓碑与 notice | 执行成功，表面节点由 4 个折叠为墓碑 + notice | 通过 | Node 验证脚本直接导入 `lib/compact.js` 验证通过 |
| 3. 实机/隔离环境触发一次带 `proactive_reclaim` 的静默唤醒 | 唤醒回合成功折叠为单行 `[dsh-proactive silent wake ...]` 墓碑，不抛任何 `invalid replace surfaceOp` 异常 | 产物已编译，待下次重启 DSH 生效 | 待验证 | |

## 验证结论

待验证

## 待跟进

无
