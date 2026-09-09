# 260908-wake-context-minimization 总结

## 背景与问题

用户场景：长会话 + 每小时 proactive reminder，多数以 no_reply 静默结束。要求量化并最小化每次唤醒的上下文消耗，避免唤醒污染长对话。

改动前实测（jk 会话真实日志 + v2 framing 渲染）：**一次静默唤醒在模型可见 surface 留下 ~2.6KB**——

| 组成 | 字节 |
|---|---|
| framing user/message（v2 报文） | 2184 |
| assistant/message（no_reply 工具调用 + reason） | ~250 |
| tool/result（`{"accepted":true,"silent":true}`） | ~150 |
| （常见）回合内新落的 runtime-context snapshot | 1–7KB（非唤醒特有，不计入） |

每小时一次、一周即 ~437KB（约 12 万 token）纯噪音。日志侧另有 ~3KB/次的 inbox splice 复写（仅磁盘，非模型上下文）。

## 方案

### 1. framing v3（`src/framing.ts`）

报文从 2184B 开销压到 ~430B（典型 prompt 下总 642B，其中 prompt 原文 178B 不可压）。保留：闹钟身份头（id/type/cold）、now、「非用户发送」标记、alarm prompt 原文、一条 no_reply 回复规则。删除：budget 机制解释、quiet hours 窗口说明、wake_type 注释、JSON+UNTRUSTED envelope、多线程回复规则——门控全在 host 侧执行，模型无需知晓。新增 `FRAMING_MARKER` 导出。

### 2. 静默唤醒 surface 压缩（新 `src/compact.ts` + `src/wake.ts` 接线）

回合结束、observer 判 `no_reply`/`failed` 后，用平台 surfaceOp `{op:"replace"}` 把唤醒交换从模型 surface 折叠：

- **region**：framing 至其后第一个 turn/end（与 observer 判策区间严格一致）；
- **owned run 划分**：framing + assistant/message + tool/result 为 owned；非本插件注入的 surface 节点（runtime-context snapshot、mnemon 指令、用户消息）打断 run 并**原样保留**——shadow snapshot 会使 `RuntimeContextProjection.retained` 置空、下回合强制重发全量快照（1–7KB），得不偿失；
- **tombstone**：含 framing 的 run → ~70B `[dsh-proactive silent wake <id> <time>]` notice user/message；
- **擦除器**：其余 owned run → 空 content 的 assistant/message（平台 `deriveEventMessage` 规则：派生 null，模型不可见），provider/model 从被抹的 assistant 继承，缺失则回退 tombstone；
- **reply/leaked 回合绝不压缩**（可见回复是真实对话）；
- 所有 append 经 `SurfaceManager.validateNext` 验证，失败（并发 /compact 已 shadow）warn + 跳过，不 fatal；
- 原始日志不动，GUI 人类 transcript（append-origin）完整保留唤醒过程。

### 3. observer 修复（审查发现的 P1，既有缺陷升级）

`analyzeWakeTurn` 原在 framing 之后找 turn/start 作为回合起点——但真实 agent-loop 顺序是 turn/start **先于** framing（turn 开始后才 drain inbox）。无竞态时靠 fallback 撞对；有竞态用户回合时会判错回合：静默唤醒 + 竞态回合带文本 → 误扣预算且不压缩；可见回复唤醒 + 竞态回合无文本 → 误判 failed → 压缩掉用户已看见的回复。修复：有 framing 时直接以 framing 为锚、其后第一个 turn/end 为界（与 compact 一致）；turn/start 跳前仅保留给无 framing 的测试/重放回退。`isFramingNotice` 同时加 FRAMING_MARKER 判定，防 tombstone 误锚。

## 效果

| 指标 | 改动前 | 改动后 |
|---|---|---|
| 静默唤醒持久残留（模型 surface） | ~2.6KB（~700–900 token） | **~70B（~20 token）** |
| 唤醒回合请求中的报文开销 | 2184B | ~430B |
| 每小时 × 一周的累积污染 | ~437KB | **~12KB** |

## 验证

- 单测 171/171（新增 compact.test.ts：真实 Session 端到端 surface 折叠、snapshot 保留、区间边界、并发 shadow 跳过、eraser 回退；observer 真实顺序 + raced 回归；wake 驱动级集成：静默只剩墓碑 / 可见回复与 raced 不压缩）；tsc 0 错；build 通过；lib 已硬链接同步到 web profile。
- 审查（reviewer 子代理）：首轮发现 P1（raced 锚定分歧）+ P2×2，已全部修复（P1：observer 锚定重写 + 3 个回归测试；P2：测试改真实事件顺序、README/AGENTS.md 同步；P3 顺带修了 eraserProvenance continue、复用平台 isSurfaceEvent、消费压缩返回值）。P3-①（双 framing 同 turn，inflight 守卫下不可达）、P3-⑤（UNTRUSTED envelope 降级为单行 gloss，prompt 来源可信）、P3-⑥（真实 agent-loop E2E）记录在案，E2E 见 validation 文档。
- 用户实机验收：见同目录 validation.md（5 项：静默压缩生效 / GUI transcript 完整 / 可见回复不压缩 / raced turn / 重启 restore）。

## 部署注意

host 侧改动需**重启 dsh** 生效（会中断当前会话）。client 侧无改动。
