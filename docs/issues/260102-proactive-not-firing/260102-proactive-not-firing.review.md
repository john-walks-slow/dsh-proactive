# 检视报告

> 检视对象：260102「compaction 表层替换契约漂移」处置（工作区未提交）
> 检视范围：`packages/dsh-proactive/src/compact.ts`、`src/wake.ts`、`test/compact.test.ts`、`package.json`、新增 `e2e/wake-smoke.mjs`
> 检视日期：2026-10-09

## 概要

本次改动把 `test/compact.test.ts` 三条断言对齐到平台真实契约（`assistant/message` 不可做表层替换 → 非 framing 的 owned run 折成一行 user notice），并删除随之变死的 eraser 辅助函数与 `events` 形参，另补一个走真实 agent 路径的 e2e 脚本。改动方向正确、范围收敛、无越界实现；经与线上运行时（dsh-session 0.2.0-rc.2）实现比对与真实会话日志核对，**未发现阻塞问题**。剩余问题集中在「实现已改、周边文档/日志文案/测试写法未同步」一类的一致性债务。

## 需求对齐

**满足。** 逐项核对：

- 平台契约主张成立（实证，非引用 devDependency 的 .d.ts）：
  - `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js:236-268` — replace 后 `missing = shadowedSeqs.filter(seq => !sources.has(seq))`，即使完全不传 `sourceEventSeqs` 也会因「未列全被遮蔽节点」抛错；
  - 同文件 `:238-239` — `assistant/message` 只要携带 `sourceEventSeqs` 即抛 `assistant/message embeds its source stream and cannot carry sourceEventSeqs`；
  - 两条规则互斥 → 空 content assistant「eraser」逻辑上不可表达，删除是正确的，不是降级。
- 「行为早已是 fold notice，本次只对齐测试」的叙述成立：`git diff` 中 `applyWakeCompaction` 只变签名，`createExchangeNoticeMessage` 调用与文案均为上下文行；`docs/issues/260923-dsh-proactive-surfaceop-compatibility.summary.md` 已记录 b19a33b 的实现改动。
- 真实链路旁证：`.dsh-e2e-home/sessions/--root-projects-dsh-proactive-packages-dsh-proactive--/session-9dac382f-…/session.v4.jsonl.zstd` 中可见 seq19 `user/message {op:"replace",startSeq:8,endSeq:8}`（tombstone）+ seq20 `user/message {op:"replace",startSeq:14,endSeq:16} srcs=[14,16]`（`… exchange folded`）—— 即线上形态与测试断言一致（15 为 tool/call，非 surface 节点，故不进 `sourceEventSeqs`）。
- 产物新鲜度（线上 dsh 直接跑 `lib/` symlink）：`lib/compact.js` 已无 `eraserMessage/eraserProvenance`、`applyWakeCompaction` 为 7 参；`lib/wake.js:149` 亦为 7 参调用。**无产物滞后风险**，无需额外动作。
- 无过度设计、无无关改动；`package.json` 的 `e2e:wake` 与模块 AGENTS.md 约定的 `e2e:<module>` 包装一致；`e2e/wake-smoke.mjs` 依赖的 `e2e-workspace-00000000` 由 `dsh-e2e` 自动播种（`/usr/local/bin/dsh-e2e:261-283`），非硬编码缺陷。

## 阻塞问题

无。

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| — | — | — | — |

## 建议修改

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| S1 | `packages/dsh-proactive/AGENTS.md:16` | 模块地图仍写 `applyWakeCompaction（… + 空 content assistant/message 擦除器）`。该辅助函数本次已删除，且平台自 0.1.5 起根本不允许该形态——模块指引与实际能力不符。 | 改为「非 framing 的 owned run 折成一行 user notice（`[dsh-proactive: silent wake <id> exchange folded]`）；`assistant/message` 不可做 replace」。 |
| S2 | `packages/dsh-proactive/AGENTS.md:33` | 核心设计「静默唤醒压缩（260917 定案）」段仍写「两者都用空 content assistant/message 擦除器（deriveEventMessage→null）」，与同一文件 Pitfalls 段（「折叠 assistant/tool exchange 须采用 user notice 形式」）自相矛盾，新人读到的两处结论相反。 | 同步该段的折叠机制描述与体积量级（tombstone ~70B + 每 run 一行 notice ~56B），并标注 eraser 因 0.1.5+ 契约不可表达。 |
| S3 | `packages/dsh-proactive/src/compact.ts:5-7` | 模块头首段仍说整轮交换「collapses to a ~70-byte tombstone」，而本次重写的 13-26 行已改为「framing run → tombstone，其他 run → notice」。首段与同文件下文不一致，读者易以为仍是单节点折叠。 | 首段改为「framing run 折成 ~70B tombstone，assistant/tool run 折成一行 notice」，保留原有「模型表层塌缩、GUI transcript 保留」的语义。 |
| S4 | `packages/dsh-proactive/src/wake.ts:261` | info 日志 `"model surface collapsed to a tombstone"` 只提 tombstone；同一函数的文档已改为 tombstone + fold notice（`lib/wake.js:150` 同步带上该文案，改后需重建）。日志是排障时唯一的正向信号，措辞应覆盖两类替换。 | 改为 `"… collapsed to a tombstone + fold notices"` 之类；如需精确统计可附 notice 条数（`applyWakeCompaction` 目前只返回 framing 是否折叠，若要计数需扩返回值，非必须）。 |
| S5 | `packages/dsh-proactive/test/compact.test.ts:172` | notice 期望值硬编码字面量，而 tombstone 期望值走 `tombstoneText(...)` 从实现取值。同一用例里两种取值方式不一致，文案改动时 notice 断言需人工同步（且语义上它同时在验证 wire 文案，硬编码反而是双份真源）。 | 导出 notice 文案常量（或复用 `createExchangeNoticeMessage(alarm, firedAt).content[0].text`）作为期望值；若刻意锁定 wire 文案，请在注释中说明这是有意为之的 golden 断言。 |
| S6 | `packages/dsh-proactive/e2e/wake-smoke.mjs`（tombstone 检查循环，约 L120-140） | 只断言「落了 tombstone 的 `surfaceOp.replace`」。tombstone 只能证明压缩被触发，不能证明 assistant/tool run 也按新契约折叠——而后者正是本次对齐的契约点。当前实现若只折叠 framing run（notice 回归缺失），e2e 依旧全绿。 | 增加一条断言：日志中存在 `text.startsWith("[dsh-proactive: silent wake ")` 结尾为 `exchange folded]` 的 `surfaceOp.replace`，且其 `sourceEventSeqs` 覆盖 assistant/tool 的 seq。 |

## 非阻塞问题

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| N1 | `packages/dsh-proactive/test/compact.test.ts:73-76` | `seq(value: number): never` 用 `never` 冒充品牌类型，可读性差。平台已导出真实品牌：`dsh-session/lib/types/types.d.ts:13` `export type SessionSeq = BrandedNumber<'SessionSeq'>`。 | 若 `@deepseek-ai/dsh-session` 包根再导出了 `SessionSeq` 则直接用（测试已从该包 import 类型）；否则从 `…/types` 子路径取，把 `never` 换成真实品牌。 |
| N2 | `packages/dsh-proactive/test/compact.test.ts:68-71` | `logs()` 名字暗示「取日志」，实际只是新建空数组，调用点再往里 push（`const warnings = logs()`）。命名与行为不符，易误读。 | 改名 `warnings()` 或直接 `const warnings: string[] = []`，删掉该辅助函数。 |
| N3 | `packages/dsh-proactive/test/compact.test.ts:179-182` | 残留占位代码：`const framingBytes = Buffer.byteLength("x"); // placeholder replaced below`（下方并无替换），其后 `tombstoneBytes < framingBytes + 80` 被 `tombstoneBytes < 90` 完全覆盖，属冗余断言。 | 删掉 `framingBytes` 与其后第一条断言，只留带消息的 `< 90`。 |
| N4 | `packages/dsh-proactive/test/compact.test.ts:137` | `flattened.every((seq) => seq <= 5)` 的形参 `seq` 遮蔽同文件新增的模块级 `seq()` 辅助函数。当前无 bug，但同名遮蔽易在后续编辑中误用。 | 形参改名为 `s`/`value`。 |
| N5 | `README.md:39`、`packages/dsh-proactive/README.md:39` | 用户文档称「持久占用从 ~2.6KB 骤降至 ~70B」。fold notice 设计下每轮还多留一行 ~56B 的 user notice（`sourceEventSeqs` 元数据另计）。数量级结论仍成立，措辞偏乐观；系 b19a33b 遗留，非本次引入。 | 补一句「另有每轮一行 exchange notice」，避免用户按字节数做容量估算时对不上。 |
| N6 | `test/scheduler.test.ts` | 与其他测试文件并发全量跑时偶发 1 例「安静时段边界」失败（单跑 2/2 通过，时间敏感）。已在 `30-compaction-contract-drift.md` §五 记录为遗留。 | 单开 issue 跟踪（或给该用例注入可控时钟）；否则下次全量跑红时容易误判为本次 compaction 改动的回归。 |

## 准入结论

**结论**：`条件准入`

**说明**：无阻塞问题——测试已与平台契约一致、死代码与死形参清理干净、无残留引用、`lib/` 产物与源码同步，可进入下一阶段；但存在 6 项建议修改（重点为模块 AGENTS.md 两处仍描述已删除的 eraser、compact/wake 内文与日志文案未同步、e2e 未断言 fold notice），建议合并前顺手处理 S1–S4，S5–S6 可随下次迭代。
