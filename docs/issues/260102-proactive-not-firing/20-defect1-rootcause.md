# 缺陷 1 根因报告：resume/workspace 心跳 100% skipped

> 排障人：expert 子代理，2026-10-02 01:20 (Asia/Shanghai)。
> 背景见同目录 `00-context.md`。缺陷 2（new/fork failed）与缺陷 3（world-master 未注册）不在本报告范围。

## TL;DR（根因）

**`ctx.sessionPersistence.list()` 的返回形状在 dsh ≥0.1.5 已从「裸 SessionHeader[]」变为「SessionPersistenceSnapshot[]」（`{header, revision, sizeBytes}`），而 dsh-proactive 的 devDependency 钉在 0.1.1-rc.2 的旧类型上，装配层（`src/index.ts`）把 snapshot 行直接当 header 喂给 resolver。resolver 里 `coldById.set(header.id, header)` 读到的是 `snapshot.id === undefined`，于是整张冷会话表塌缩成一个 `undefined` 键；workspace 里所有冷会话在 `workspace.ts` 的剪枝行被丢弃，候选为空 → `{kind:"none"}` → 100% skipped。**

这不是会话格式（v0/v3/v4）问题，也不是「工作区没有会话」——是**插件对运行时 API 的形状误读**，且完全静默（不抛错、不置 `coldListFailed`、cordis warn 不落盘）。

## 证据链（全部实证，非推断）

### E1. 运行时 `list()` 的真实返回形状（决定性实验）

用线上同一份后端包（`/usr/lib/node_modules/@deepseek-ai/dsh-session-persistence-jsonl`，0.1.7-rc.2，即线上进程实际 resolve 的那份）以 stub ctx 直接实例化，对真实 root `/root/.dsh/sessions` 调 `list()`（只读探针 `/tmp/probe-backend-list.mjs`）：

```
list() returned 2171 entries in 12.9s
first element keys: header, revision, sizeBytes
first.element.id (what the plugin reads): undefined
plugin coldById size after fold: 1 (distinct keys: undefined)
yu workspace ids found via plugin fold: 0/4
corrected fold size: 2171 ; yu hits: 4/4
corrected header sample: {"version":4,"id":"session-032ac2fe-…","createdAt":…,"cwd":"/root/agents/yu","isSeeded":false,…}
```

即：**插件的折叠方式只能命中 `undefined` 一个键；改成 `snapshot.header` 后 yu 的会话全部命中，且 header 已被 catalog 迁移成 v4 逻辑形态（cwd/isSeeded/agentPreset 齐全）**。

### E2. 双侧类型/实现对照

| 侧 | 版本 | `list()` 契约 |
|---|---|---|
| 插件 devDependency（编译依据） | `@deepseek-ai/dsh-session-persistence` **0.1.1-rc.2** | `list(signal?): Promise<SessionHeader[]>`（"one header per materialized session"） |
| 线上运行时 | **0.1.7-rc.2**（`/usr/bin/dsh` → dsh-base → dsh-session-persistence-jsonl） | `list(options?): Promise<readonly SessionPersistenceSnapshot[]>`，`SessionPersistenceSnapshot = {header, revision, eventCount?, sizeBytes?}` |

运行时实现（`dsh-session-persistence-jsonl/lib/index.js` `list()`）push 的就是 `{header, revision, sizeBytes}`。宿主自己的消费方 **dsh-workspace** 是正确范式（`listStoredHeaders()`：`(await ctx.sessionPersistence.list()).map((snapshot) => snapshot.header)`），api-session-controller 的 `projectionsFor` 同样先取 `.header`——只有 dsh-proactive 拿错。

### E3. 会话格式不是原因（排除头号嫌疑）

对 luna/rev/yu 三个 workspace 全部 54 个注册 session，用运行时同版 `sessionFormatCatalog.readHeader` 逐个解码磁盘日志首行（探针 `/tmp/probe-catalog.mjs`）：**全部返回 `migration-required`（v0/v3）或 `current`（v4），id 与目录一致，无 unsupported/malformed**。`listArtifacts` 的静默丢弃路径（`SessionFormatUnsupportedError` → `continue`）不会被这些会话触发。目录三种形态（`session-<uuid>/`、裸 `<uuid>/`、`session.v4…`）在 `listSessionDirs`（枚举全部子目录）+ `resolveGenerationInDirectory`（取目录内最高代次文件）下全覆盖——裸 `<uuid>` 目录实测全是 subagent 会话（origin=subagent，本就该被剔除）。

### E4. 时间线吻合

- 最早的 `session.v4.jsonl.zstd`（= 0.1.7-rc.2 写入格式）出现在 **2026-09-28 20:46**（`/root/.dsh/sessions` 全盘扫描，380 个 v4 文件中最老者）——与「decl_* 闹钟 2026-09-28 起 0/100」、`cordis.patch.yml.bak-fix3plugins-20260928212633`、git 提交 `80bf0d9 fix(proactive): restore load on dsh 0.1.7 core` 全部对上。
- 0.1.5 时代 list() 已是 snapshot 形状（本机 live2d-voice/node_modules 的 0.1.5-rc.3 副本为证），但 workspace 目标功能的验证记录（260916）跑在更早的运行时上；9-28 升级 0.1.7 后 ESM link 崩溃被修复、插件恢复加载，冷列表形状断裂则无声存续。

### E5. 隔离实例 red→green（resolver 层）

在 worktree e2e 实例（同 0.1.7-rc.2 运行时）：

- **生产 red**（线上 runs.jsonl 本身）：luna/rev/yu 注册表 sessionIds 分别 28/12/14、archived 空（00-context §4 已核实），却逐次 skip——排除「注册表为空」解释。
- **green（修复后）**：同一实例、同一 cold v4 会话（`session-cf005fdd-…`，经 `session/create` RPC 创建并 attach，重启实例使其冷化），workspace-resume 闹钟到点后 run 记录从 `skipped` 变为 **`failed` 且 `reasoningSummary` 携带该冷会话 id**——即 resolver 成功选中了冷会话并进入 resume 执行段（残余 failed 见「边界与遗留」，属缺陷 2 族，与本修复无关）。
- 附带单元回归：`test/workspace.test.ts` 新增「cold ranking survives the runtime list() snapshot shape」——以真实 snapshot 行形状（含 revision/sizeBytes 冗余字段）过 `coldSessionHeaders` 适配后再过 resolver，断言选中冷会话。61/61（workspace + target-v3）通过。

> 注：隔离环境曾两次被「父子代理共用同一 e2e home」的 bundle 不匹配重建清掉 workspace 注册表与导入过的 settings（`dsh-e2e start` 检测 bundles 变化会 `rm -rf profiles` 并重播种空注册表），期间一条 red 与一条 green 数据无效，已用「重启前后注册表快照」法排除。生产 red + E1 探针构成完整证据链，不依赖这两条。

## 产出 `none` 的全路径清单（读码结论，供回归参照）

`resolveWorkspaceWakeTarget` 产出 `{kind:"none"}` 需要候选为空，候选为空的全部途径：

1. `requireWorkspace` 失败 → 是 closed `{error}`（failed，非 skip），排除。
2. 逐 sessionId 剪枝：archived / `createdSessionKind` 不豁免 / **既不在 live store 也不在 coldById**（本缺陷）/ subagent。
3. `coldHeaders === undefined`（`ctx.get("sessionPersistence", false)` 为 undefined）——inject 数组含该服务，缺失时插件整树加载失败，与「闹钟在跑」矛盾，排除。
4. `list()` 抛异常 → `coldListFailed` → 返回 `{error}`（failed+retry），与 skip 现象矛盾，排除。
5. `list()` 正常返回但形状误读（**本案**）：不抛错、不置位、候选恒空 → skip。

## 修复内容

三处改动，`packages/dsh-proactive/`：

| 文件 | 改动 | 目的 |
|---|---|---|
| `src/workspace.ts` | 新增 `SessionPersistenceListRow` 接口 + `coldSessionHeaders(rows)` 纯适配函数（注释记录 0.1.1→≥0.1.5 契约漂移与本 issue 编号） | 契约显式化 + 可单测 |
| `src/index.ts` | `persistenceService` 的本地 cast 改为 `list(): Promise<readonly SessionPersistenceListRow[]>`；两处 `coldHeaders` 装配改为 `async () => coldSessionHeaders(await persistenceService.list())`（workspace port + preset port） | 修正装配层形状误读 |
| `src/workspace.ts`（第二处） | `ProjectionCacheLike.cachedSnapshot(meta, inheritedEventCount: 0)` → `cachedSnapshot(meta)`；两处调用点去掉 `0` 实参 | 修顺带发现的同族问题（见下） |

**顺带修复（同一根因族）**：`cachedSnapshot` 的运行时签名是 `(meta, keys?)`，第二参是投影键白名单；插件按旧 0.1.1 契约传的 `inheritedEventCount: 0` 落在 `keys` 位上，`new Set(0)` 为空集 → `viewCheckpoint` 永远返回空 → **即使 header 形状修好，冷会话的 blank/lastPromptAt 缓存行也永远读不到**（排序退化为 createdAt、blank 保守可见）。宿主正确用法就是单参 `cachedSnapshot(header)`（api-session-controller `projectionsFor` 同款）。

**未改动**（避免狗皮膏药）：resolver 纯函数、排序语义、`createdSessionEligible`、wake 驱动、scheduler——缺陷全部在装配边界。

构建：`npm run build` 通过（lib/index.js、lib/workspace.js 均含 `coldSessionHeaders`）；`npm run check` 通过；受影响模块单测 61/61 通过。

## 设计问题评估：IM 场景下「挑最新可见会话 resume」是否选错目标

结论：**语义本身成立，不是缺陷 1 的根因，但有一个已知的次优边界，不建议现在改**。

- IM 驱动（dsh-im-humanize）把消息灌进「当前绑定的会话」；persona 会话轮换时，新会话的 lastPromptAt 最新 → 「最新可见会话」恰好跟随轮换，这是该启发式的设计意图（260916：follow the user's latest activity）。
- 边界：用户在同一 workspace 里用 GUI 打开另一个旧会话看历史（产生新的 lastPromptAt）后，心跳会落进那个 GUI 会话而不是 IM 绑定会话。后果是「目的地次优」（persona 上下文缺失），不是「唤醒失败」。
- 若未来要收紧，方向是给 declared/工具方言加一个 `target_session_binding`（IM 通道绑定锚点）或在排序键上做时间衰减，而不是在 resolver 里探测其他插件（违反零耦合纪律）。现阶段 heartbeat 场景（yu/luna/rev 的日常会话就是 IM 会话）收益不明确，先不动。

## 置信度

**根因：>98%**（运行时实现 + 双侧类型 + 决定性探针 + 宿主同款适配代码四处互证；唯一残余不确定性只剩「线上进程加载的包与本机 /usr/lib 副本不一致」，但 `/usr/bin/dsh` 的 resolve 链与 4180 进程 cmdline 已核实一致）。
**修复正确性：>95%**（单测 + 隔离实例 resolver 级 green；完整回合级 green 被无关的缺陷 2 族失败挡住，见下）。

## 验收标准（线上重启后，归用户/父代理执行）

1. `supervisorctl restart dsh` 前先确认 `/root/.dsh/proactive/config.json` 的 `enabled`（当前为 **false**，2026-10-01 18:39 被改——不恢复的话任何闹钟都不会 fire）。
2. 重启后等 luna-heartbeat / rev-heartbeat / yu-heartbeat 任一到点：`runs.jsonl` 新记录的 decision 应不再是 skipped；note 不再出现 "has no eligible session to wake"。
3. `GET /api/dsh-proactive/state`：三个 decl 心跳闹钟的 run 历史里出现 skipped 之后的首条非 skipped 记录。
4. 回归：session-sourced resume 闹钟行为不变；面板工作区下拉正常。

## 边界与遗留（给父代理 / 缺陷 2 排查的输入）

1. **缺陷 2 在隔离实例可复现且与 LLM 无关**：e2e home 修好 provider（见下）后，`session/prompt` RPC 能完整走通回合（cpa/omni 回了 "ok"），但同一实例上 workspace-resume 与 new 模式的 wake 仍 `wake failed (attempt N)`，失败点在 framing 写入之前（会话日志无 framing user/message）——即 `acquireForResume`/`composeAgent`/`agents.resume` 段。真实错误仍只在 cordis warn（不落盘）。**建议缺陷 2 排查直接在 e2e 实例上给 wake.ts 的 catch 加临时 console.error 取证。**
2. **scheduler 丢真实错误**：`scheduler.ts:236` 记 run 时只写 `"wake failed (attempt N)"`，`result.error` 被丢弃（wake.ts 的 `{outcome:"failed", error}` 白算了）。建议缺陷 2 修复时顺带把 error 并进 note——这是可观测性缺口，不是新 bug。
3. **e2e 环境修复记录**（同一 home 供缺陷 2 复用）：`CPA_API_KEY=sk-1234 dsh-e2e start`；settings 需从 `settings.yaml.imported` 恢复（bundle 重建会清掉已导入的 profile settings）；`llm-pi-ai` 段不能走 settings import（骨架里 models 条目缺必填字段，import 静默失败），已直接写进 `profiles/web/cordis.patch.yml`。**父子代理共用一个 e2e home 时，`--extra` 与裸 start 交替会互相 `rm -rf profiles`**——建议约定独占或固定 bundle 集。
4. **pre-existing 测试失败**：`compact.test.js` ×3、`scheduler.test.js` ×1、`wake.test.js` ×1 在 HEAD 基线（`git archive` 干净副本）上同样失败（68/73），与本次改动无关，未处理。
5. 生产进程（PID 8448，10-01 启动）仍在内存里跑旧代码；`lib/` 已是新产物，**下次重启自动生效**。client bundle 亦已重建（client 源未变，无实质差异）。
