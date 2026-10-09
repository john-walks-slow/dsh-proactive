# 检视报告

## 概要

检视范围涵盖 261009 文件表闹钟特性（第四种闹钟类型 `schedule_file` 句柄 → 子闹钟同步，取代旧的全局 glob 配置机制）。
整体实现高度严谨，架构职责划分清晰，边界条件与防御性设计完备。在幂等性、竞态防护、整层 target 选取、严格祖父目录工作区缺省、子闹钟折叠聚合及回滚保护等方面均达到了生产级高质量水准。发现若干建议修改项（主要是微小的一致性体验与安全防御），无阻塞问题。

## 需求对齐

完全满足 261009 需求与设计计划：
1. **第四种闹钟类型**：成功新增 `type: "file"`，作为唯一的订阅句柄，利用统一谓词 `firesAlarm(type)` 严格规避触发。
2. **生命周期与幂等同步**：实现了基于 SHA-256 hash 的差异比较，hash 未变严格 no-op（保住 `min_idle` defer 与 jitter 锚点）；暂停清空子闹钟、恢复重新派生；取消句柄级联删除子闹钟且支持原子回滚；ENOENT 撤销计划，解析损坏保留计划。
3. **配置与历史清理**：彻底清除了 `config.scheduleFiles` 与 `proactive_update_settings.schedule_files`，移除了旧的 glob 解析逻辑与 `declared.ts`。
4. **面板与工具一致性**：工具与面板统一前置处理（规范化、唯一性、严格祖父目录 target 缺省、carryover 保护）；列表默认隐藏子闹钟并展示子条数，唤醒历史归并折叠在句柄行。
5. **契约与国际化**：dsh-tools 的 output schema 严格遵循非必填字段不带 `required: true` 约定；Client DTO、Sections、Panel 与 LocaleNamespaceMap zh/en 完全同步。

## 阻塞问题

无

## 建议修改

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| S1 | `packages/dsh-proactive/src/client/sections.tsx:512` | 浏览器端表单校验 `canSubmit` 中，当 `kind === "file"` 时仅校验了 `(form.scheduleFile ?? "").trim() !== ""`，未校验是否为以 `/` 开头的绝对路径。若用户在面板输入相对路径或带 glob 的路径，点击提交会收到后端 400 报错，体验不够即时。 | 在 `canSubmit` 中加入绝对路径与非法字符校验（例如 `form.scheduleFile.startsWith("/") && !/[*?]/.test(form.scheduleFile)`），在前端提供即时禁用与校验提示。 |
| S2 | `packages/dsh-proactive/src/schedule-sync.ts:250` | `deps.store.getAlarm(sourceId)` 校验了 `handle.status === "scheduled" && handle.type === "file"`。如果 handle 处于非预期状态（如 `cancelled`/`completed`/`failed`），跳过了创建，但此时 summary 未作任何告警统计或记入 errors，在排查竞态时较难从 `lastSummary` 中发现。 | 在跳过创建的日志输出同时，建议在 `summary.errors` 中增加一条简要说明（例如 `summary.errors.push(...)`），便于在面板快照中查看同步跳过的原因。 |
| S3 | `packages/dsh-proactive/src/alarm-factory.ts:283` | `validateCreateArgs` 中当 `kind === "file"` 时，返回的对象展开了 `timeZone` 与 `minIdleSeconds`，但如果用户传入了无效或过去的 `at` 等遗留参数，因选择器互斥已由第 97 行保证，此处非常干净。不过当 `args["schedule_file"]` 为非字符串或过长时，直接返回了 `ToolError`，而 `alarm-factory.ts` 的顶部导出约定中其他选择器有的使用 `inputError` 封装。虽然 `validateCreateArgs` 统一返回 `ToolError`，建议保持错误返回语义完全统一。 | 保持现有模式即可，或在未来重构校验器时统一由 domain 抛出 `ProactiveInputError` 并经 `inputError` 统一转换。 |

## 非阻塞问题

| ID | 位置 | 问题 | 建议 |
| --- | ---- | ---- | ---- |
| N1 | `packages/dsh-proactive/src/schedule-sync.ts:166` | `stat(file)` 检查了 `info.size > MAX_FILE_BYTES`，但未显式捕获如果文件是 FIFO / socket 等特殊文件的情形（虽然 `info.isFile()` 已经阻断了目录和非常规文件，但对于损坏的软链接等可能会抛出 ENOENT 之外的错误并在日志打印 warn）。 | 当前的行为（捕获非 ENOENT 错误并记入 brokenHandleIds 保留已有闹钟）是安全且防御性的，符合预期，无需额外处理。 |
| N2 | `packages/dsh-proactive/src/schedule-file.ts:257` | `defaultHandleTargetArgs` 依赖 `dirname(dirname(file))`。对于根目录下的路径如 `/a.json` 或 `/.life/wake.json`，`dirname(dirname(file))` 将退化为 `/`。因为本机 `/root` 甚至 `/` 可能具有特殊目录语义，若有边界路径可能产生边缘提示。 | 当前逻辑对未命中 registry 的目录会闭式报错 `not_found`，并且提示信息中带上了具体的尝试路径，具备自解释性。可保持现状。 |

## 准入结论

**结论**：`准入`

**说明**：代码设计优雅，完全落实了专家审查提出的 6 项设计要点与规范，并发控制、事务回滚、错误隔离和边界防范均具备扎实的证据与完备的测试用例覆盖。建议修改项仅为体验增强与可观测性微调，不影响本次代码准入与上线。
