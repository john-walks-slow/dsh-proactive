# remove-push-coupling 问题修复总结

## 背景

用户（代码所有者）判定 dsh-proactive 与 push 通道（`push_notify`/`send_wechat`）的耦合是**完全不必要的过度设计**：proactive 不注册也不控制这些推送工具，却在自己内部假设它们存在——observer 把它们当"可见输出"计费、framing 建议模型用它们、`proactive_set` 接受只写不读的 `delivery` 参数。用户明确要求**彻底删除这段耦合**；预算系统保留（语义简化为"可见聊天文本"），整体简化。

## 变更内容

删除了四类 push 耦合，全部在 `packages/dsh-proactive/`：

1. **`delivery` 参数（只写不读的死数据）——全链路删除**
   - `src/domain.ts`：删 `DeliveryHint` 接口、`Alarm.deliveryHint` 字段
   - `src/alarm-factory.ts`：删 `normalizeDelivery`、`CreateSpec.delivery`、`validateCreateArgs` 的 delivery 校验与 allowed key、`newAlarm` 传递
   - `src/tools.ts`：`proactive_set` 参数 schema 删 `delivery`
   - `src/panel/contract.ts`：`PanelCreateForm.delivery` 与 `createArgsFromForm` 的服务端默认注入 `{chat,push:false,wechat:false}` 一并删除
2. **observer 的 push 判定**（`src/observer.ts`）：删 `VISIBLE_TOOLS`、push 分支、`"no_reply raced a push tool"` note；`budgetDelta` 只按 `reply` 计；header 注释同步
3. **framing 的 push 规则**（`src/framing.ts`）：删回复规则 3（冷会话且有时效走 push_notify）；budget 行删 push_notify/send_wechat 提及
4. **措辞清理**：`config.ts`/`store.ts`/`tools.ts` 注释与工具描述、`README.md`、模块 `AGENTS.md`

**保留**：`AlarmView.deliveryMode: "host"`（投递模式常量，与 push 通道无关）；预算系统全部机制（`maxDeliveriesPerDay`、store budget/spendBudget、scheduler 门控、framing 曝光、update_settings 参数）。

**RunDecision 从 5 值收敛为 4 值**：`no_reply | reply | skipped | failed`（删 `push`）。

## 行为变化

- `proactive_set` 传 `delivery` → 返回 `invalid_trigger`（回归测试锁定）
- push-only 唤醒回合（调工具无文本）从 `push/计1` 归入 `failed/计0`——与"预算只计可见聊天文本"新语义精确一致
- 旧数据兼容：旧 alarms.json 的 `deliveryHint` 字段被 store 宽容忽略；旧 runs 的 `decision="push"` 作为历史字符串由 GUI 直显

## 验证

- `npm run check`（tsc --noEmit）exit 0
- `npm test` 121/121 全绿（含新增回归断言：delivery 参数被拒绝）
- reviewer 审查：**通过（无阻塞问题）**，删除彻底性零残留、无误删、observer 闭环正确

## 部署

web profile 的 `node_modules/dsh-proactive` 与开发目录为硬链接同一份，`npm run build` 产物（lib/ 含 client bundle）已直接进入部署位置；生效需用户重启 dsh 服务（会中断会话，由用户安排验收）。

## 待跟进

用户验收（validation.md）：重启后验证 delivery 参数被拒、framing 两条规则、no_reply/reply 决策与预算、面板表单无通道选项、旧闹钟兼容。