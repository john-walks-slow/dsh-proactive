# 260911 闹钟目标重构 + 功能演进 — 验收与总结

## 目标

把闹钟的"目标会话"从 v2 的单一 `target_mode = resume | fork | new | workspace` 升级为
**类型 × 来源** 的二维方言：

- **类型**：`new`（每次新建）/ `resume`（复用）/ `fork`（分支）
- **来源**（仅 resume/fork）：`session`（会话 id 直接指定）/ `workspace`（工作区最近活跃会话）/ `preset`（preset 最近活跃会话）
- **new 可选配置**：工作区（cwd + attach）、preset（composition stamp）、provider/model（唤醒选型覆盖）

规格不完善处按最佳判断实现（用户授权）。

## 设计要点

### 目标方言 v3

`AlarmTarget` 联合类型在 `domain.ts`：

- `new`：`{ mode: "new"; workspaceId?; presetId?; provider?; model? }`
- `resume` / `fork`：`{ mode; sourceType: "session" | "workspace" | "preset"; sessionId? | workspaceId? | presetId? }`
- **遗留 `workspace`**（pre-v3 存储记录）：create 时归一化为 `resume + sourceType: "workspace"`；`AlarmView.targetMode` 对遗留记录仍报 `"workspace"`；`formFromAlarm` 把遗留行折叠为 `resume + workspace` 来源，保存时存储数据收敛到 v3 拼写。

### 来源解析（fire 时）

- `session`：直接用 id
- `workspace`：`pickWorkspaceTarget`（可见会话优先 → 空白 New Session 槽 → create）
- `preset`：`resolvePresetWakeTarget`（live fold：`resolveSessionPresetOf` 合并 header stamp 与 `agent-preset/selected` 事件，最新事件胜出；cold：header.agentPreset；archived/subagent 排除；projectionCache 空白行排除；coldListFailed 且无 live 候选 → 闭错重试）

### 回退语义

- `resume + 来源`：无命中 → **create**（preset 携 `meta.agentPreset`；workspace 携 `meta.cwd` + attach）
- `fork + 来源`：无命中 → **闭错失败**（fork 必须有父历史）
- `fork` 父会话无已完成轮次 → 失败

### 选型覆盖（仅 new）

- `provider` + `model` 全给 → 固定 `ModelSelectionRef`（不经 base 回退）
- 部分给 → 合并到 base（`createWakeSelectionRef`）
- 覆盖线程进 `agentOptions`（创建参数）+ `setup`（`composeAgent` 安装固定/合并 ref）

### Preset 名册

- **host 侧**：`ctx.get("agentPresets").remoteExportList()` → `{presets:[{id,trust,isDefault,name?,description?,broken?}]}`，路径无关名册
- **panel 快照**：`PanelSnapshot.presets?: readonly PresetRosterRow[]`（contract.ts 新增 `PresetRosterRow`）
- 失败降级：try/catch → `presets: []` + warn 日志；客户端 picker 降级为自由文本输入

### 面板契约

- `createArgsFromForm`（contract.ts）：v3 全 arm + 旧字段裁剪（切换 mode/source 后残留 id 不泄漏给校验器）
- `formFromAlarm`（sections.tsx，已导出）：v3 往返 + 遗留折叠
- `tools.ts`：`proactive_set`/`proactive_update` v3 参数 + update 时 `workspaceCarriedOver` 标志位（workspace 来源在 update 时自动从 workspace → workspaceId 字段带过）

## 实施清单

| 层 | 文件 | 改动 |
|---|---|---|
| domain | `src/domain.ts` | `targetSourceOf`、`AlarmTarget` v3 联合、`AlarmView` v3 字段 |
| factory | `src/alarm-factory.ts` | `validateCreateArgs` v3 方言（new 可选配置 + 裁剪、resume/fork 拒绝 provider/model、来源推断、互斥、遗留归一化） |
| store | `src/store.ts` | `targetIsValid` v3 arm + `isValidPresetId` 校验 |
| workspace | `src/workspace.ts` | `resolvePresetWakeTarget`、`PresetWakePort`、`cwdOf`、`resolveSessionPresetOf` home |
| wake | `src/wake.ts` | `fire()` v3：遗留折叠、new/resume/fork × 来源全 arm、选型覆盖线程 |
| index | `src/index.ts` | `presetTargets` + `presetRoster` 接线 |
| tools | `src/tools.ts` | v3 参数 + update carryover |
| contract | `src/panel/contract.ts` | `PresetRosterRow`、`PanelSnapshot.presets`、`createArgsFromForm` v3 |
| panel service | `src/panel/service.ts` | `presetRoster` dep、快照注入 presets、失败降级 |
| host-api | `src/client/host-api.ts` | DTO v3 字段、`PresetInfo`、`presetLabel` |
| sections | `src/client/sections.tsx` | 表单 v3 全重排（mode/source 选择、per-source 控件、new-mode 可选行、guards） |
| panel/session-panel | `src/client/panel.tsx`、`session-panel.tsx` | `knownPresets` 注入、`ownerForCreate` v3 |
| locales | `src/client/locales.ts` + `index.ts` | 18 新键（zh + en）、`LocaleNamespaceMap` 同步 |

## 测试

- **单测**：`test/target-v3.test.ts`（新增，23 测试）覆盖
  - domain `targetSourceOf` + `toAlarmView` v3 字段
  - factory v3 方言（new 可选配置 + 裁剪、拒绝 session-side 字段、resume/fork 来源推断 + 互斥、拒绝 provider/model、遗留归一化）
  - store `load` 各存储 shape（v3 + v2 + 遗留 + malformed 丢弃）
  - `resolvePresetWakeTarget`（live fold 胜过 header、cold header 匹配、排除项、coldListFailed 闭错、空白 live 行让位可见 cold 行、none）
  - wake `fire()` v3（preset resume → 已解析会话；preset resume 无 → create 携 `meta.agentPreset`；preset fork 无 → 闭错失败；preset 无 port → 闭错；new + workspace → cwdOf + create `meta.cwd` + attach 先于 deliver；new + provider/model → agentOptions + 固定选型 waterfall；new + 缺失 workspace → 闭错不创建）
  - panel 契约 `createArgsFromForm` 旧字段裁剪 + `formFromAlarm` v3 往返 + 遗留折叠
- **既有单测**：`test/wake.test.ts`、`test/panel.test.ts`、`test/tools.test.ts` 更新为 v3 语义
- **全套**：`npm test` → **258/258 通过**（235 既有 + 23 新增）

## E2E 验收（隔离实例）

`DSH_HOME=/tmp/e2e-dsh-home dsh --profile e2e --no-open --port 4599`

1. **preset 名册**：`GET /api/dsh-proactive/state` 快照含 `presets: [{id:standard,...},{id:ptc},{id:minimal},{id:cordis}]` — host 侧 `remoteExportList()` 接线生效
2. **new-mode 创建**：`POST .../action` create `target_mode:new, target_preset_id:minimal, target_provider:cpa, target_model:medium` → 存储 `targetMode:new, targetPresetId:minimal, targetProvider:cpa, targetModel:medium`
3. **preset-source resume 创建**：`target_mode:resume, target_source:preset, target_preset_id:minimal` → 存储 `targetMode:resume, targetSource:preset, targetPresetId:minimal`
4. **遗留 workspace 拼写**：`target_mode:workspace, target_workspace_id:e2e-ws-0001` → 闭错 `not_found`（id 在注册表中不存在，wireWorkspace 闸门正确拒绝）
5. **preset-source resume 唤醒**（无运行 minimal 的会话）→ fire 创建 `session-f2d59433-…`，header `agentPreset: minimal` ✓；唤醒跑真实 LLM（cpa 网关可达），decision `no_reply`（测试 prompt + 安静时段）✓
6. **new-mode 唤醒**（preset+provider+model 覆盖）→ fire 创建 `session-fa234b2d-…`，header `agentPreset: minimal` ✓；run 记录 decision `no_reply` ✓

## 已知约束

- 遗留 `target_mode:"workspace"` 在 create/edit 入口端到端接受，归一化为 `resume + workspace` 来源存储；仅 pre-v3 **已存储**记录保留 mode 拼写
- resume/fork 拒绝 `target_provider`/`target_model`（factory 强制）— 覆盖仅 new 模式
- `presetLabel` 导出（host-api.ts）可能未使用 — 后续清理
- 客户端 bundle `npm run build` 自动同步到 `/root/.dsh/profiles/web`（硬链接）；页面刷新即加载新客户端 bundle，host 侧改动需重启 dsh（线上重启需用户书面同意）
