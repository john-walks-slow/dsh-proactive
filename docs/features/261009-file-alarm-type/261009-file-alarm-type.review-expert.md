# 261009 文件表闹钟（第四种闹钟类型）— 专家设计审查

审查对象：`261009-file-alarm-type.plan.md`
证据基准：本仓库 src/ 实现（当前工作树）、线上数据（`/root/.dsh/proactive/`、`/root/.dsh/storages/workspace.json`、`/root/agents/*/.life/wake_schedule.json`）、`docs/issues/260928-proactive-alarms-wiped/`。

---

## 结论

**有条件准入**。方向正确：把"读哪个文件"从宿主隐式配置变成闹钟列表里的一件东西，是本次重构唯一真正的收益，而且句柄（订阅记录）比"条目即闹钟、不设句柄"更 canonical——只有句柄能在文件缺失/为空/条目全不合法时仍保留订阅的存在性，这正是 260928 事故（声明式通道数日静默失效无人察觉）暴露的缺口。但计划本身有 5 个必须先改的阻塞问题：同步重入会产生**重复 id 的子闹钟（双触发）**、apply 阶段与 cancel/pause 竞态可**复活孤儿子闹钟并真实触发一次唤醒**、target 缺省上溯规则在本机注册表下**必然静默指错**、target 分层合并**复现 260928 的残留键 bug 类**、迁移方案**事实不全且回滚会清空整个 store**。修掉这些后可以开工，其余为精细度问题。

---

## 阻塞问题

### B1. 同步重入：`syncOnce` 未串行化 → 重复 id 的子闹钟（同一次唤醒触发两遍）

- **问题**：内部 tick 用 `chain` 串行（declared.ts:503-513），但对外暴露的 `syncOnce` **绕过了这条链**（declared.ts:520 直接 `syncDeclaredSchedules(deps)`）。计划要求 tools/panel 在创建/编辑句柄后调 `syncOnce` 做即时同步（plan:80-81、106-108），于是"面板编辑触发的一次 pass"与"轮询 tick 的一次 pass"可以并发。两趟 pass 各自算出同一个 `desired`，各自 `getAlarm(id)` 都得到 undefined → 各自 `addAlarm` → store 里出现**两条同 id 记录**；此后删除循环又因 `desired.has(alarm.id)` 为真而永不清理它们。store 无 id 去重（store.ts:261-264），scheduler 的 `dueAlarms` 会同时拿到两条同 id 闹钟 → 同一 occurrence 触发两次、写两条 run。
- **证据**：declared.ts:500-521（tick 有 chain、syncOnce 无）；declared.ts:444-461（`getAlarm` 判空后 `addAlarm`）；store.ts:261-264（`addAlarm` 无唯一性约束）；scheduler.ts:119-124（按列表逐条 fire）。
- **建议**：把"发起一次 pass"统一成 `enqueueSync(): Promise<DeclaredSyncSummary>`，内部仍走同一条 `chain`，`syncOnce` 即 `enqueueSync`（await 本次 pass 的结果，而不是插队）；tick 也用同一入口。另加一道廉价护栏：`addAlarm` 前若 `getAlarm(id) !== undefined` 则视为已存在走 replace 分支；单测覆盖"两个并发 syncOnce 只产生一条子闹钟"。

### B2. apply 阶段不复检句柄 → 与 `proactive_cancel` / 面板 pause 竞态可复活孤儿子闹钟并触发

- **问题**：`desired` 的计算循环里含 `await prepareEntry(...)`（内部 await 工作区解析，declared.ts:310-339），因此"算 desired"和"写 store"之间存在真实异步窗口。若这期间用户 cancel 了句柄（连带删子闹钟，plan:87）或面板 pause 了句柄，apply 循环仍会按陈旧快照把子闹钟 `addAlarm` 回去（它只检查 alarm 是否存在，不检查父句柄还在不在、还是不是 scheduled）。复活出来的子闹钟没有父句柄，要等下一轮（≤60s 轮询）才被孤儿清扫掉——而它在 `status: "scheduled"` 且 `nextDueAt` 已过期时**会被 scheduler 真实唤醒一次**。
- **证据**：declared.ts:393-441（desired 计算含 await）；declared.ts:444-461（apply 只查 `deps.store.getAlarm(alarmId)`）；scheduler.ts:119-124 + 154-155（due 集合只认 store 内容）；plan:87-90（cancel/pause 语义）。
- **建议**：`desired` 的 value 上带 `sourceId`（计划本来就有 `declared.sourceId`），apply 每条之前复检 `deps.store.getAlarm(handleId)`：不存在或 `status !== "scheduled"` 就跳过；删除循环同理（它已经天然安全，但要显式写出这条不变式）。更强的做法是把 sync 与工具/面板的 store 变更也纳入同一条串行链，但这会改动多处，复检已是低成本高收益。

### B3. target 缺省"逐级上溯最近已注册 workspace"在本机是**静默指错**，且闭环报错分支实际不可达

- **问题**：本机 workspace registry 里 **`/root` 本身就是注册工作区**，`/root/projects`、`/usr/bin` 亦然。因此对任何未注册的 agent 目录（实测 `/root/agents/` 下 7 个目录中 `vif` 未注册，其余 ami/luna/publisher/rev/world-master/yu 均已注册）文件 `/root/agents/vif/.life/wake_schedule.json` 上溯会命中 `/root`（或 `/root/agents` 若未来注册）→ 解析"成功"、拿到一个**无关工作区**的 id → 子闹钟被投递到该工作区"最近活跃会话"。计划设想的"反查不到 → 闭式 `not_found`"在本机几乎永远不触发，取而代之的是无声的错误目的地。而这正是 260928 事故同一根因的变体：`world-master` 目录当时**从未注册为 workspace**，整条声明式通道因此静默失效（事故报告第 2.2 节）。另外本机真实文件只有 4 个（luna / rev / world-master / yu），world master bootstrap 要一次性为多个目录建句柄，任何一个指错都会静默污染别的会话。
- **证据**：`/root/.dsh/storages/workspace.json`（`797b64af…=/root`、`b473971f…=/root/projects`、`d8d32658…=/usr/bin`、`e047a43b…=/root/agents/yu`、`f68c0fcb…=/root/agents/luna`、`41d29733…=/root/agents/rev`、`b278e2aa…=/root/agents/world-master`；列表中**无** `/root/agents/vif`）；plan:53-56；`docs/issues/260928-proactive-alarms-wiped/260928-proactive-alarms-wiped.troubleshoot.md` §2.2。
- **建议**：(a) 把匹配条件收紧为"最近已注册祖先**必须恰好是 `dirname(dirname(file))`**"（即只接受 `<workspace>/.life/<file>` 这一约定，相对深度 ≤1），否则闭式 `not_found` 并提示显式传 target——这样 vif 那种情况会得到可操作的错误而不是错误的目的地；(b) 匹配成功也在创建结果的 `targetWorkspaceId` 上回显 + 一条 warn 日志（反直觉的目的地必须留痕）；(c) bootstrap 路径（`create-simulated-events` skill）**必须显式传 target**（见 B5）；(d) 若认为上溯本身不值得，更简单可靠的替代是：句柄 target 缺省 = 创建者会话（方言默认），并在 README 明确"文件表属于别的 agent 时必须显式给 target"——代价是 bootstrap 漏传时唤醒落进 world master 自己的会话，属显式可观察的错误，比静默指错好。

### B4. target 分层的 key-wise 合并会复现 260928 的残留键 bug 类

- **问题**：计划给出的优先级是"条目字段 > 文件顶层默认 > **句柄闹钟字段** > 方言默认"（plan:69-71），实现上最自然的写法是把各层的扁平 `target_*` 键 `Object.assign` 拼起来。但 target 各键**不是正交的**：句柄是 `target_mode: "new"`，条目只写 `target: {session_id: X}`，拼出来就是 `new + target_session_id` → 白名单校验直接拒绝；反过来句柄 `target_workspace_id` + 条目 `{mode: "new"}` 又会意外合法。这类"只增键不删键"的扁平拼接正是 260928 的根因 bug（`target_workspace_path` 残留在 args 里 → 6 条 entry 全部失败、通道静默失效）。新增的"句柄层"把这个坑从单层扩到了三层。
- **证据**：declared.ts:193-211（`flattenTarget`，每层产出扁平键）；declared.ts:326-337（该 bug 的修复注释仍在代码里）；`260928-…troubleshoot.md` §2.2。
- **建议**：target 分层改成**整对象替换**：按优先级选出唯一一层 target（entry.target → file.target → handle.target），其余层完全丢弃，再在该层内部投影成扁平 args；禁止跨层 key-wise 合并。同理 `prompt` 与 5 个标量默认键可以 key-wise（它们正交），但 target 必须整体选层。单测覆盖 5 个臂（session / workspace / preset / new / legacy workspace）× "条目只写部分 target" 的情形。

### B5. 迁移方案事实不全，且**回滚会清空整个 store**

- **问题**：三点。(1) 计划迁移章节只写了 yu 一个文件（plan:124-129），但线上 glob 覆盖的是 `/root/agents/*/.life/wake_schedule.json`，实测有 **4 个文件、6 条 entry**（luna-heartbeat、luna-midnight-free、rev-heartbeat、yu-heartbeat、yu-diary-10pm、world-evolution-5am），其中线上 alarms.json 现存 **3 条 declared**（luna-midnight-free / yu-diary-10pm / world-evolution-5am，owner=`declared-schedule`）。首轮 sync 会按"无 sourceId → 孤儿"把这些旧 declared 全部清掉，因此在句柄补齐之前，**6 条定时唤醒整条断供**（`0 5 * * *` 等 cron 一旦错过就是错过）。谁在什么时候补句柄，计划没有把它写成不可跳过的步骤。(2) 回滚不安全：新记录的 `type: "file"` 不在旧 lib 的 `ALARM_TYPES` 白名单里，旧 lib 载入时会把这条记录判非法 → `corrupt = true` → **整店空 store**，而 260928 已经证明"corrupt 后启动即 persist 覆盖现场"会把数据真正销毁。(3) 计划把旧 declared 的 runCount/lastRunAt 视为可丢弃（id 相同 → runs.jsonl 历史连续），这点成立，但面板上的 runCount 会从 0 重来，需在文档里说明。
- **证据**：`/root/.dsh/proactive/config.json`（`scheduleFiles: ["/root/agents/*/.life/wake_schedule.json"]`）；`/root/.dsh/proactive/alarms.json`（3 条 declared，owner=`declared-schedule`）；`ls /root/agents/*/.life/wake_schedule.json` = 4 个文件；plan:124-129；store.ts:50/104（`ALARM_TYPES` 白名单）+ store.ts:210-251（单条非法/版本不符 → 整店 corrupt，空 store）；`260928-…troubleshoot.md` §2.1（放大器 2、3）。
- **建议**：把迁移写成有序清单：① `cp alarms.json alarms.json.bak-261009`；② 部署 + 重启；③ **立即**为 4 个（而非 1 个）文件建句柄并各自显式传 target；④ 校验 alarms.json 子闹钟数 = 6、`GET /api/dsh-proactive/state` 无 corrupt；⑤ 再改 skill 与文档。并在计划里明确写"本次变更**不可回滚到旧 lib**（未知 type → store 判 corrupt → 清空）"，把备份与"不降级"写进部署注意。

---

## 建议问题

### S1. 同文件唯一性：应为**单一共享函数 + 路径规范化**，否则两个句柄指向同一物理文件会产生重复子闹钟

计划把唯一性检查放在"store 感知的调用层（tools / panel）"，两处各写一份必漂移。更关键的是：子闹钟 id 由**原始 file 字符串**决定（`declaredAlarmId(file, entryId)`，declared.ts:189-191），而唯一性若按字符串相等判定，则 `/root/agents/yu/.life/wake_schedule.json`、`.../.life/../.life/wake_schedule.json`、符号链接路径会被当成不同文件 → 两个句柄、两套 id、同一批唤醒触发两遍。
**建议**：创建/更新时先规范化（`path.resolve` + 去尾斜杠；目录存在时 `realpath(dirname)` 以折叠符号链接），规范形式**同时**进 store 与 id 计算；唯一性检查抽成 `findScheduleHandle(alarms, canonicalFile, excludeId)` 一个函数（放 declared.ts 或 domain），tools 与 panel 共用；`validateCreateArgs` 保持纯函数不变（这点计划是对的）。

### S2. 句柄 `nextDueAt` 的派生与回退值会造成无谓写回与误导性显示

- 计划回退到 `createdAt`（plan:39），于是"唯一子闹钟 in-flight"（in-flight 子闹钟若无子闹钟在跑就不计入）、"文件为空"、"条目全部准备失败"这三种情形都会把句柄 `nextDueAt` 写成一个**古代时刻** → 每轮 sync `mutated=true`（多余的 persist + requestDrive），面板"下次触发"栏显示很久以前。in-flight 子闹钟本身已有 `nextDueAt`，没有理由排除在 min 之外。
- **建议**：无候选子闹钟时**保持原值不写**（不要在 createdAt 与派生值之间来回跳）；in-flight 子闹钟计入 min；面板在 `declaredEntries === 0` 时显示占位符而非日期。
- 另外一条相关时序要写进计划：pause = 子闹钟被移除，但**面板 toggle 没有触发即时同步**（plan:106-109 只对 create/edit 说了 `requestSync`），暂停后最长 60s 内子闹钟仍可能触发一次；建议 toggle 也走同一 `enqueueSync()`。

### S3. "句柄闹钟字段"作为继承层过于含糊，且缺一个 `AlarmTarget → 扁平 args` 投影函数（会导致条目**静默丢弃**）

- 句柄存的是 `AlarmTarget` 对象，子条目吃的是扁平 `target_*` args；计划清单里**没有**这个投影函数。而 sync 调用的是 `validateCreateArgs(args, "")`（declared.ts:423）——空默认会话 id 意味着"session 臂没有显式 id 就必失败"。于是：句柄为 session 源（面板默认目标就是本会话）或条目/文件层未给 target 时，投影一旦漏掉 `target_session_id`/`target_source`，条目会走 `keptIds`（坏编辑降级为"无变化"）→ **条目无声不生效**，而日志在 cordis 里不落盘、面板也不显示（见 S4）——又一个"看门狗瞎了"的场景。
- **建议**：显式定义继承集合（我建议只继承 `prompt` + `target` + `time_zone`，其余触发旋钮要么明确继承要么拒收，避免语义模糊），把投影写成单一函数 `flattenTarget(handleTarget)`，并对 5 个臂各写一条单测（断言 `validateCreateArgs(projected, "")` 能通过）。

### S4. "同步错误只进日志"= 同步失败**无处可查**，建议补一个内存态同步摘要

计划的非目标写着"不新增文件同步健康度落盘字段（同步错误仍只进日志）"（plan:134）。但包级 AGENTS.md 明确记载 cordis 的 info/warn **不落盘**（"没日志不能证伪任何事"），而 260928 的事故正是"声明式通道从未生效、数日无人察觉"。也就是说这条非目标等于保持"静默失效"这一已知风险模式。
**建议**：不落盘、不改 store schema，只把最近一次 sync 的摘要放进面板快照（`snapshot.server.sync = { lastAt, created, updated, removed, errors: string[] }`，host 内存），并在 `AlarmView` 增加 `declaredEntries`（工具侧也能看到条目数），让模型/用户能自证"文件确实物化了 N 条"。成本约 20-30 行，收益是解除本重构最想解决的盲区。

### S5. 装配顺序依赖是新的 landmine，建议用迟到绑定替代"调整顺序"

计划要求 `startDeclaredScheduleSync` 在工具注册前创建（plan:80-81）。但 `registerProactiveTools` 在 `agent/created` 与启动扫描时就**立即**构造工具定义并读取 `services`（index.ts:185-201），因此 `services.syncOnce` 必须在那一刻存在——这是隐式的初始化顺序耦合，且 260928 的根因之一正是 inject/装配类问题（事故报告 §3.1）。
**建议**：给工具/面板注入一个 holder（如 `{ sync: () => declaredSyncRef?.syncOnce() }`）或让 `ToolServices` 暴露惰性 getter，使注册顺序与 sync 创建顺序解耦；单测断言"先注册工具后创建 sync 也能即时同步"。

### S6. 实施清单的遗漏改动点（不改会在 build 期或运行期直接暴露）

- `tools.ts:86` `ALARM_VIEW_SCHEMA.type` 的 enum 仍是 `["once","every","cron"]`，且缺 `scheduleFile`。计划只在 domain.ts 一节提了 `AlarmView` 加 file——**运行时输出门禁会拒绝 file 闹钟的 view**（dsh-tools 的 per-property/closed-schema 约定）。同理 `proactive_list` 要"透出 scheduleFile"就必须同时改这里。
- `client/host-api.ts:23` 的 `AlarmRowDto.type` 是客户端**独立 DTO**（不是从 host 类型派生），需同步加 `"file"` / `scheduleFile` / `declaredEntries`。
- `client/index.ts:28` 的 `LocaleNamespaceMap` union 必须补 `typeFile` / `scheduleFile` / `scheduleFilePlaceholder` / `scheduleFileHint` / `declaredEntries`（包级 AGENTS.md 明确警告过这一点）。
- `client/sections.tsx`：`:71` typeLabel switch、`:246` 类型下拉、`:516` 三按钮数组（→ 4）、`:748-758` `formFromAlarm`（file → kind "file"，否则会退化成 "once"）、`:499` submit guard（kind=file 时的必填校验）。
- 测试面：`test/declared.test.ts` 里 glob 相关用例（`globToRegExp` / `expandPattern` / `MAX_MATCHED_FILES`）要删；`test/config.test.ts` 的 `parseScheduleFiles` 用例要删——计划只写了"重写"，没写"删哪些"。
- `declared.sourceId`：计划让**类型必填、校验可选**（plan:36-37 + store.ts:118-127 的写法）。迁移期旧记录在首个 sync 之前仍会被 list/panel 读到，此时类型说谎（读到的可能是 undefined）。建议类型也写成 `sourceId?: string`，读取处显式判空。
- E2E 可行性：计划第 4 条 e2e 假设"句柄指向临时 workspace 内的时间表文件"，但 target 缺省依赖 workspace registry，e2e 实例未必注册了临时目录（而本机"最近祖先"可能是 `/root`，见 B3）。**建议**：e2e 用 panel action HTTP 直接建句柄（`POST /api/dsh-proactive/action`，args 走工具方言）并**显式传 `target_session_id`**，避开 registry 与"最近祖先"两个不确定量；断言用 `$DSH_E2E_HOME/proactive/alarms.json` + `GET /api/dsh-proactive/state`（注意 token→cookie 换取与端口/路径全部走环境变量，见包级 AGENTS.md E2E 节）。这样也避免为一个 e2e 引入真实 agent 回合（本机 8GB 内存是 260928 事故的诱因之一）。

### S7. `proactive_cancel` 连带删除的持久化/回滚语义未定义

计划只写"返回值增加 `removedChildren`"（plan:87）。现有 set/cancel 都是"改内存 → persist 失败则回滚单个对象"（tools.ts:251-257、307-313）。连带删除需要一次 persist 内同时移除句柄 + N 条子闹钟，失败时要把它们**全部**恢复（否则 store 只丢一半）。
另外：若某子闹钟正在 in-flight，连带删除是安全的（`replaceAlarm` 对已删 id 是 no-op，store.ts:266-272），但那个已在飞行中的唤醒回合结束后仍会写一条 run，`alarmId` 已不存在 → 面板里成为孤儿 run（不渲染，见 S8 的同一机制）。建议在计划里显式写明这两点。

### S8. 面板/工具的可观测性：子闹钟的唤醒历史会从面板**消失**

计划说"滤掉子闹钟行（`owned` 集合仍含子闹钟，保证 runs 过滤不受影响）"（plan:106-108）——但 runs 的**渲染**是挂在 alarm row 下的（`sections.tsx:279` `runsByAlarm.get(alarm.id)`，设置页同构 `panel.tsx:234-242/345`）。子行被滤掉后，runs 数组里虽然还有子闹钟的 run，却没有任何行去渲染它们：文件驱动的唤醒从此在面板里不可见（只有一个 `declaredEntries` 计数）。这与"文件表闹钟"的可诊断性目标相悖。
**建议**：把子闹钟的 runs 归并到句柄行（构建 `runsByAlarm` 时按 `sourceId` 折叠），或把子行以折叠态嵌在句柄行下。另外"滤掉子行"必须对**两个视图**生效（设置页 sessionId=undefined 时 `alarmRows` 是全量，别只在会话页过滤）。

---

## 非阻塞观察

- **N1 元模型自洽性（对问题 1 的结论）**：句柄 = 第四种 AlarmType 是**可接受的**建模，胜于"独立 sources 集合"（要造第二套领域实体、第二套 CRUD/面板/视图 schema，违背本仓库"不做平行实现"的取向）和"条目即闹钟、不设句柄"（无法表达"文件缺失/为空/条目全非法时订阅仍存在"，会退回 260928 的静默失效）。代价是 `type` 一词兼具"触发计划"与"订阅"两义，并泄漏到 4-5 处（`dueAlarms`、`arm`、`toAlarmView` 的 overdue、面板 `fire`、`ALARM_VIEW_SCHEMA`）。建议把 `type === "file"` 收敛成 domain 里唯一谓词 `firesAlarm(type): boolean`，各消费点只调它，并加一条守护测试："file 闹钟永不进入 runWake"。
- **N2 暂停期间的生命周期（对问题 2 的结论）**：pause = 子闹钟移除、resume = 重新派生、id 稳定 → runs 连续，这个取舍我认为是**对的**，而且顺带解决了"暂停期间 world master 仍是每日重写文件"的问题：resume 时按**当前**文件重新派生，不会拿旧计划补发。已核对的三个相互作用都不构成死循环：① hash 未变则完全 no-op（declared.ts:446-452），min_idle `defer` 写在子闹钟的 `nextDueAt` 上不会被同步打回（AGENTS.md 的前置条件被保住）；② 派生值只写句柄、不触碰子闹钟，因此不会造成"句柄↔子闹钟"互相打回；③ `mutated → requestDrive` 对已 defer 到未来的子闹钟无影响（scheduler.ts:119-124 只取 due 集合）。剩下的边角：in-flight 子闹钟在 pause 后不立即移除（等它跑完，`every` 类型甚至可能再触发一次）；in-flight 的唤醒回合无法被取消（framing 已投递）。这两点建议写进文档而非改设计。
- **N3 一次 `at` 条目在瞬时 ENOENT 下会永久丢失**：文件消失 = 撤销计划（plan:65），而 `at` 已过的条目走 `skippedPast` 永不补发（declared.ts:410-421）。因此文件写入方**必须原子写（tmp+rename）**，否则 truncate 中间态虽被 JSON 损坏兜住，delete+create 之间却会真丢一条一次唤醒。建议把"原子写"写成 README/skill 里的硬契约，并让 e2e 覆盖"rename 重写文件不产生子闹钟抖动"。
- **N4 句柄编辑会重置 recurring 子条目的锚点**：改句柄 prompt/target → 所有子条目 hash 变化 → `every`/`after` 子闹钟以 `now` 重建（`buildAlarm` 用 nowStart 作 anchor，alarm-factory.ts:322-333），已计划的那一次唤醒会被顺延。可接受，但应写进文档（"编辑句柄=重排子条目"）。
- **N5 owner 变化带来两处隐性语义变化**：子闹钟 owner 从合成 id `declared-schedule` 变为句柄 owner（真实会话），于是 ① `new` 模式子闹钟会经 `parentLog(ownerSessionId)` 继承 owner 会话的 cwd（wake.ts:523-526；旧行为是"owner 不可读 → 无 cwd"）；② 更新时区默认链跟随 owner（tools.ts:355）。实测现有 6 条 entry 都显式带 `workspace_path`，故当前无实际影响，但语义变化应在计划里写明并加一条单测（owner 有 cwd 的 new 子闹钟）。
- **N6 工作量（对问题 6 的结论）**：`~800-1000 loc` 只勉强够 **src 侧**（glob 删除约 −90 行会被重写抵回）。实际估算：src ≈ 1000-1200（declared.ts 约 550 重写 + tools/panel/client 各处），测试 ≈ 600-800（declared.test 438 行重写，外加 tools/panel/store/config/domain/settings 的用例更新），文档 ≈ 200 → 合计 **1800-2400 行改动**。建议切成两个可独立验收的切片：(a) domain/store/factory/sync/tools（无 UI，单测可验）；(b) 面板 + client + 文档 + e2e。另外 glob 死后 `declared.ts` 变成"解析 + 同步 + 轮询"三合一，建议顺手拆成 `schedule-file.ts`（format/parse）与 `schedule-sync.ts`（期望集合 diff + 定时器），符合包级 AGENTS.md 的单一职责取向——这也正好是"该补上"的部分。
- **N7 文档面缺口**：清单里缺 `docs/features/261009-file-alarm-type/261009-file-alarm-type.validation.md` 这份验证要求文档（本需求含"需用户同意的线上重启 + world master 次日重写的实机验收"，按 `/update-validation-requirements` 应有该文档）；根 `AGENTS.md` 的"地图"中 260918 declared 一节需要改指 261009；`260918-declared-schedules.plan.md` 保留为历史的处理方式已正确（该目录现在只有 plan.md）。
- **N8 旧 `scheduleFiles` 键会永久留在 config.json**：`writeConfigFile` 是"读旧文件 + merge 覆盖"（config.ts:116-124），settings 工具删字段后这个键不会再被写、也不会被读，但会一直在文件里（线上 `/root/.dsh/proactive/config.json` 确实有）。计划说"发布后手动删除"——建议直接写进迁移清单第 ①步一起做掉。
