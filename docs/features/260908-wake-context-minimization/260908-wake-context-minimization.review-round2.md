# 260908-wake-context-minimization 评审（第二轮）

> 日期：2026-09-09 · 评审对象：首轮 P1/P2/P3 修复后的工作区 diff（相对 HEAD 未提交）· 评审方式：源码走读 + 平台参考实现核对（dsh-session `isSurfaceEvent`/`Session.append`/`turn()` 顺序 + `turn/end` finally 落地）+ 独立复验（tsc / build / 171 单测 + 真实 Session 驱动级 5 场景实证脚本，复现首轮 Case A/B 并补同回合竞态）

## 0. 结论摘要

| 级别 | 数量 | 摘要 |
|---|---|---|
| P0 阻断交付 | 0 | — |
| P1 必修 | 0 | 首轮 P1（observer/compact region 锚定在 raced turn 下分歧）**已修复并经真实 Session 端到端复验成立** |
| P2 建议修 | 0 | 首轮两条 P2（测试改真实顺序+raced、README/AGENTS.md 同步）**均已落实** |
| P3 可后置 | 0 新增 | 首轮 P3-②③④ 已顺带修复；P3-①⑤⑥ 仍为记录在案的接受项（本轮未改、无需改） |
| 亮点 | — | 锚定重写精准命中根因（`effective = slice.slice(framingAt)`，turn/start 跳前仅留给无 framing 回退）；observer 与 compact 的 region 规则现已**字面一致**，compact.ts 的「mirror」注释由「与事实不符」变为如实；isFramingNotice 双重锚定（plugin source + startsWith(FRAMING_MARKER)）防 tombstone 误锚；独立实证脚本 5/5 通过，含套件未端到端覆盖的「静默唤醒 + 同回合竞态带文本」组合 |

**总体判断：准入通过。** 首轮报告的 1 个 P1 与 2 个 P2 全部修复并经源码走读 + 真实 Session 端到端复验成立，未引入新阻断或新 P1/P2；3 个顺带修复的 P3 均核实到位。压缩核心机制（surface 折叠、snapshot 保留、并发 shadow 跳过、CompactSession 窄接口、restore 兼容、fork seed 继承）在首轮已走读+实证，本轮未改动，结论延续。3 个记录在案的接受项（双 framing 同 turn 不可达、UNTRUSTED envelope 降级、真实 agent-loop E2E 列入 validation）不变。遗留两条 P3 级 nit（见 §3），不阻断合入。

---

## 1. 复验记录（本次会话实测）

| 项目 | 结果 |
|---|---|
| `npx tsc -p tsconfig.json`（src+test） | ✅ 退出码 0 |
| `npm run build` | ✅ 退出码 0 |
| `node --test 'dist/test/*.test.js'` | ✅ **171 passed / 0 failed**（首轮 168 → 171，+3 对应 observer +2 raced、wake +1 驱动级 raced） |
| 实证：framing v3 开销（alarm_abc123/once/提醒我喝水） | ✅ overhead 384B、quiet total 451B（<600B 测试断言通过） |
| 实证：tombstone 字节数 | ✅ 65B（<90B 断言通过） |
| 实证：**首轮 P1 Case A 复现**（可见回复唤醒 + raced 无文本回合，真实 Session + 真实 drain 顺序） | ✅ **已修复**：判 `reply`/budgetDelta 1，不压缩；surface 留 framing + 可见回复「到点了，该喝水了！」+ 竞态用户消息，无 tombstone |
| 实证：**首轮 P1 Case B 复现**（静默唤醒 + raced 带文本回合） | ✅ **已修复**：判 `no_reply`/budgetDelta 0，压缩；surface 留 tombstone + snapshot + 竞态用户消息 + 竞态可见回复「竞态回复」（全保留） |
| 实证：同回合竞态（竞态用户消息与 framing 在同一 turn drain，最常见的 raced 形状） | ✅ 判 `no_reply`，压缩；surface 留竞态用户消息 + tombstone + snapshot（竞态用户消息在 framing 之前、region 之外，原样保留） |
| 实证：压缩后的下一唤醒（tombstone 不误锚） | ✅ 第一次静默压缩后，第二次 framing 仍被判 `reply`/budgetDelta 1，tombstone 不被 `isFramingNotice` 识别为 framing |
| 平台核对：`isSurfaceEvent` 真实实现（P3-③ 导入） | ✅ `lib/types/surface.js` L29：`SURFACE_EVENT_TYPES.has(type) && surfaceOp !== undefined`，`SURFACE_EVENT_TYPES = {user/message, assistant/message, tool/result}`——与旧手写「三类型 + surfaceOp 存在」**语义完全一致**，导入替换无行为变化 |
| 平台核对：agent-loop 事件顺序 | ✅ `dsh-agent-loop lib/index.js` `turn()`：`session.append("turn/start")`（L523）先于 `for (const message of decision.messages) session.append("user/message",...)` drain（同循环内）；preStep 的 `decision.messages = [...claimed, context]` 使 runtime-context snapshot 紧跟 framing 之后——首轮 P1 前提与 AGENTS.md pitfall 均属实 |
| 平台核对：`turn/end` 必定落地 | ✅ `turn()` 的 `finally` 在 error/aborted 路径也 append `turn/end`（kind=aborted/error）——「无 turn/end」回退分支在真实 whenIdle 返回路径下不可达，为纯防御（与首轮判定一致） |

实证脚本构造真实 Session + WakeDriver + fake agent（followup 按真实 drain 顺序 append turn/start→framing→snapshot→assistant→tool/call→turn/end→raced turn），5 场景全 PASS。脚本已从工作区删除，未污染仓库。

## 2. 逐项修复核对

### 2.1 P1 — observer 锚定重写 ✅ 成立

`src/observer.ts` L121-128（diff 核对）：

```ts
const framingAt = slice.findIndex(isFramingNotice);
let effective = slice;
if (framingAt >= 0) {
  effective = slice.slice(framingAt);          // ← 有 framing：直接以 framing 为锚
} else {
  const firstTurnStart = slice.findIndex((event) => event.type === "turn/start");
  if (firstTurnStart >= 0) effective = slice.slice(firstTurnStart);  // ← 无 framing 回退才用 turn/start 跳前
}
```

- **根因命中**：首轮的分歧源于「framing 之后再找第一个 turn/start 作为 region 起点」。真实顺序 turn/start 先于 framing，故该分支要么不触发（退回 afterFraming 撞对），要么选中竞态的后续 turn/start（判错回合）。新代码在 framing 存在时**不再跳前**，直接 `slice.slice(framingAt)`，turnSegment 取其后第一个 turn/end——与 compact 的 region 规则（`planWakeCompaction`：framingAt → 其后第一个 turn/end）**字面一致**。
- **compact.ts L90-96 注释修正**：旧注释「Region bounds mirror the observer's anchoring exactly」与事实不符（首轮 P1）；新注释如实陈述「the turn that claimed the framing starts BEFORE it ... the wake turn ends at the FIRST turn/end after the framing」，现已为真。
- **isFramingNotice 双重锚定**（L98-105）：`plugin source + first text block startsWith(FRAMING_MARKER)`。TOMBSTONE_MARKER（`[dsh-proactive silent wake `）与 FRAMING_MARKER（`[dsh-proactive wake `）前缀互斥，tombstone 不会误锚（实证场景 D 佐证）。首轮已确认，本轮未改，结论延续。
- **端到端复验**：首轮 Case A（误判 failed → 压缩可见回复）与 Case B（误判 reply → 误扣预算且不压缩）在真实 Session 驱动级均已不复现（实证 5/5）。套件内 observer.test.ts 两个 raced 单测 + wake.test.ts 一个驱动级 raced 用例锁定。

### 2.2 P2-① — 测试改真实顺序 + raced 回归 ✅ 成立

- `test/observer.test.ts`：所有 framing 用例已改为真实顺序（`turnStart()` 先于 `framing`，见 L55-59、L161-165、L188-195 等）；首轮指出「全部用 framing 在 turn/start 之前的不可能形状」已消除。
- 新增两 raced 回归用例：L183「raced user turn after a visible wake reply is NOT judged」断言 `reply`/budgetDelta 1（防 Case A）；L202「raced user turn with text after a SILENT wake is NOT judged」断言 `no_reply`/budgetDelta 0（防 Case B）。
- `test/wake.test.ts` 新增驱动级 L553「raced user turn cannot make a visible wake reply compactable (P1 regression)」：真实 Session + raced turn，断言判 `reply`、可见回复留 surface、无 tombstone。
- 无 framing 回退仍由 L146「analysis skips earlier unrelated events」覆盖（fallback 锚定不退化）。

### 2.3 P2-② — README / 模块 AGENTS.md 同步 ✅ 成立

- `README.md` L78 改为 v3 描述（极简：身份头/now/非用户标记/alarm prompt 原文/一条 no_reply 规则），删除 v2 的 budget 用量/respect_quiet_hours/两条回复规则；新增「静默唤醒的上下文压缩」一节（~70B tombstone + 空 content 擦除器 + snapshot/用户消息保留 + reply 不压缩 + GUI transcript 不受影响 + 净效果 ~2.6KB→~70B）。
- 模块 `AGENTS.md`：地图补 `src/compact.ts`；核心设计补压缩不变量（reply 绝不压缩、非 owned surface 节点打断 run 保留、shadow snapshot 会使 RuntimeContextProjection.retained 置空）；pitfalls 末尾补「agent-loop 事件顺序：turn/start 先于 framing ... 在 framing 后找 turn/start 会选中竞态用户回合（曾致误扣预算 + 误压缩可见回复，见 .../260908-... P1）」。按 update-module-instruction 规范在本需求收尾同步，到位。

### 2.4 P3-② — eraserProvenance continue ✅ 成立

`src/compact.ts` L204-217：缺 provider/model 的 assistant 现为 `continue`（遍历后续 assistant），不再 `return undefined` 提前放弃。真实 assistant 必带 provider/model（reload 校验归纳），不可达，但 `continue` 更稳；有「eraserless runs fall back to a tombstone」用例锁定回退语义。

### 2.5 P3-③ — 复用平台 isSurfaceEvent ✅ 成立

`src/compact.ts` L33 导入 `isSurfaceEvent`，调用点 L114 `isSurfaceEvent(event as never)`。平台实现（§1 复验表）= `SURFACE_EVENT_TYPES.has(type) && surfaceOp !== undefined`，与旧手写「三类型 + surfaceOp 存在」**完全同义**——平台若扩展 surface 类型集不再静默分歧。`as never` 断言：CompactEvent 含 type/surfaceOp，`isSurfaceEvent` 运行期只读这两字段，安全；tsc 0 错确认（never 既是所有类型子类型，`event as never` 合法）。`@deepseek-ai/dsh-session` 已在 peerDependencies（package.json L62），运行期导入无新依赖引入。

### 2.6 P3-④ — applyWakeCompaction 返回值已消费 ✅ 成立

`src/wake.ts` L159-161：`if (applyWakeCompaction(...)) { this.deps.log("info", "wake exchange compacted for alarm ... (silent, ...)") }`。返回值（`framingCollapsed`）现被生产调用方消费：压缩成功记一条 info 日志；失败已有 per-run warn（L161 catch）。不再是无主返回值。

## 3. 新问题检查

本轮改动未引入新 P0/P1/P2。两点 P3 级 nit，不阻断：

### nit-①（P3）compactWake 的 info 日志对 failed 决策也写 "silent"

`wake.ts` L251 `if (decision === "no_reply" || decision === "failed")` 触发压缩；`compactWake` 的 info 文案固定写「(silent, model surface collapsed to a tombstone)」——failed 唤醒（error/aborted/无产出）也压缩并打同一条「silent」日志，措辞略失真（failed ≠ silent）。纯日志可读性问题，无行为影响。建议：文案改为「(no visible output, ... collapsed ...)」或按 decision 分流两文案。

### nit-②（P3）静默唤醒 + 同回合竞态带文本的组合无驱动级单测

套件覆盖为：observer.test.ts 有「raced silent + 带文本 → no_reply」决策单测（L202）；compact.test.ts 有「region 止于 wake turn 的 turn/end、后继 turn 不受扰」单测（L118）。两者**分别**覆盖决策与区域边界，但「静默唤醒 + 同回合/跨回合竞态带文本 → 决策 no_reply 且压缩、竞态用户消息与可见回复原样保留」这一**组合行为**无驱动级单测（wake.test.ts 只有可见回复 + raced 的驱动级用例 L553）。我已用真实 Session 实证脚本复现该组合（场景 B/E）通过，建议补一条同形态驱动级用例锁定。非阻断：决策与区域两半均已单测覆盖，组合经验上成立。

### 记录在案的接受项（首轮已确认，本轮未改，结论延续）

- P3-① 双 framing 同 turn：inflight 守卫下不可达，第二个 framing 断裂保留为无应答 notice，低危害。
- P3-⑤ v2 UNTRUSTED envelope 降级为单行 gloss：alarm prompt 来源可信（模型自设 / 面板表单），可接受；若未来 prompt 增加外部来源需恢复 envelope。
- P3-⑥ 真实 agent-loop 路径零 E2E：已列入 `validation.md` 五项（静默压缩 / GUI transcript / 可见回复不压缩 / raced turn / 重启 restore），待实机验收。

## 4. 亮点（本轮新增/延续）

- **锚定重写精准、改动面小**：仅 observer.ts 一处分支条件（framing 存在时不跳前）+ 注释，即同时消除「误扣预算」（Case B）与「误压缩可见回复」（Case A）两条后果；turn/start 跳前逻辑保留给无 framing 的测试/重放回退，未误伤既有 fallback 测试。
- **observer 与 compact 的 region 规则现已字面一致**：两者均为「framing → 其后第一个 turn/end」。compact.ts 的「mirror」注释从首轮的「与事实不符」变为如实——这是 P1 修复带来的连带正确性收益，不止于消除 bug。
- **isFramingNotice 双重锚定**（plugin source + FRAMING_MARKER 前缀）使压缩后下一唤醒的 tombstone 不会误锚为新 framing（实证场景 D 佐证），与 P1 修复正交且必要。
- **独立实证脚本覆盖了套件的组合盲区**：5 场景含「静默 + 同回合竞态带文本」（最常见 raced 形状）与「压缩后下一唤醒」——前者套件无驱动级单测，后者套件无端到端断言，实证补全后结论更扎实。

## 5. 结论

**准入通过。** 首轮 1 个 P1 + 2 个 P2 全部修复并经源码走读 + 真实 Session 端到端复验（5/5 场景，含首轮 Case A/B 复现与最常见同回合竞态）成立；3 个顺带修复的 P3（eraserProvenance continue、复用平台 isSurfaceEvent、消费压缩返回值）均核实到位；未引入新阻断或新 P1/P2。遗留两条 P3 级 nit（failed 压缩日志文案失真、组合行为缺驱动级单测）不阻断合入，可随或后置。3 个记录在案的接受项不变。复验：tsc 0 错、build 成功、171/171、framing 384B、tombstone 65B、isSurfaceEvent 语义一致、agent-loop 顺序与 turn/end 必落地属实。
