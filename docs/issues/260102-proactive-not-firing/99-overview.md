# 260102 — dsh-proactive 唤醒全失效：总览与结论

> 撰写：主工程师，2026-10-02。
> 本文只写**总览、本机现场结论、以及主工程师独立查到的部分**。
> 两个子代理各自的完整根因分析见同目录：
> - `20-defect1-rootcause.md`（专家 A：resume/workspace 心跳 100% skipped）
> - `10-defect2-3-rootcause.md`（专家 B：new/fork 唤醒 100% failed + world-master 未注册）
> 背景与已核实事实见 `00-context.md`。

## 一、用户报告的现象

> 「本机现在 dsh-proactive 的情况，最近好像都没正常运行」

**属实，且比预想严重。**

## 二、核心事实

自 2026-09-28 声明式 `wake_schedule` 上线后，5 个 `decl_*` 闹钟**成功率 0/100**，
一次都没有成功唤醒过：

| 闹钟 | target | 结果 |
|---|---|---|
| luna-heartbeat | resume / workspace | skipped ×12 |
| rev-heartbeat | resume / workspace | skipped ×21 |
| yu-heartbeat | resume / workspace | skipped ×21 |
| luna-midnight-free | new | **failed ×9** |
| yu-diary-10pm | fork | **failed ×9** |

全量 run 决策分布（446 条）：`reply 87 / failed 174 / skipped 134 / no_reply 50 / push 1`。

## 三、缺陷清单与归属

| # | 缺陷 | 性质 | 负责人 | 状态 |
|---|---|---|---|---|
| 1 | `resume`+`workspace` 心跳 100% 被 skipped（`no eligible session`） | 插件解析逻辑 | 专家 A | 报告中 |
| 2 | `new` / `fork` 唤醒 100% failed（`wake failed`，**真实原因从未被记录**） | 插件 + 可观测性 | 专家 B | 报告中 |
| 3 | world-master 的 declared schedule 完全未注册（workspace 未注册 → 静默丢弃） | 插件设计 | 专家 B | 报告中 |
| 4 | `config.json` 里 `enabled: false` | 配置状态 | 主工程师 | 见 §四 |
| 5 | cpa 模型 `reasoningEffort` 档位不兼容，dsh-taskboard / dsh-mnemon 持续报错 | DSH 配置 + 插件透传 | 主工程师 | 见 §五 |

## 四、缺陷 4：全局开关被关掉了

`/root/.dsh/proactive/config.json:3` → `"enabled": false`（文件 mtime 2026-10-01 18:39）。

按 host 语义，这是**总闸**：`false` 会暂停所有**模型自主发起**的唤醒
（`respect_quiet_hours: true` 的那批，恰好就是三个心跳），只有用户手建的闹钟
（`respect_quiet_hours: false`）还能响。

这解释了「完全没动静」的观感，但**不是** skipped/failed 的原因——
被关掉的闹钟根本不会进 run 记录，而 runs.jsonl 里躺着的 54 次 skipped 是在开关打开时发生的。
所以缺陷 1/2 与它相互独立，都要修。

> 处置：待代码修复合入并验证唤醒可用后再打开总闸，避免打开即失败刷屏。
> 一条命令即可回退（`proactive_update_settings enabled:false`）。

## 五、缺陷 5：cpa 模型档位收窄引发的连锁失败（连带发现，非本次目标）

### 现象

`/var/log/dsh.log` **最后 3000 行内**仍在持续报错（说明是当前时态，不是历史遗留）：

```
[dsh-taskboard] turn error detail: {"message":"pi-ai provider \"cpa\" model \"medium\" does not support reasoning effort \"low\"","code":"UNSUPPORTED_REASONING_EFFORT"}
[dsh-taskboard] turn error detail: {"message":"provider \"cpa\" model \"medium\" does not support reasoning effort \"medium\"","code":"UNSUPPORTED_REASONING_EFFORT"}
[dsh-mnemon] idle review failed: memory subagent stopped with error: UNSUPPORTED_REASONING_EFFORT: provider "cpa" model "lite" does not support reasoning effort "medium"
```

共 142 条 `UNSUPPORTED_REASONING_EFFORT` + 57 条 `UNKNOWN_MODEL`。

### 根因

DSH 0.1.7 把 `settings.yaml` 迁进了 profile 配置（`/root/.dsh/profiles/web/cordis.patch.yml`）。
迁移时 cpa provider 的模型 `reasoningEfforts` 档位被 `@hytime/dsh-thinking-effort` 重建为
**`{off, high, max}`**（`cordis.patch.yml:167-224`），插件注释写明「上游实测 minimal 会 400」。

`list_models` 实测确认：cpa 除 `live` 外全部只支持 `[off, high, max]`。

但仍有地方在给子 agent 注入 `low` / `medium` 档位，于是 turn 一发出就被 pi-ai 拒绝。

### 两个未解疑点（已交给专家 B 顺带确认）

1. `cordis.patch.yml:120-135` 里 thinking-effort 的 `legacyMigration` 长期停在
   `pending: true` / `decision: ""` / `lastResult: ""`，候选正是
   `subagentEffort: medium`（来源 `settings.yaml.imported`，签名 `0a0e43ea…`，扫描于 2026-10-01T16:01:30Z）。
   **这批迁移从未落地。** 且全量 grep 显示 `subagentEffort` 这个键在 DSH 核心里**根本不存在**——
   落地了也未必有人读。这需要单独定夺，不能顺手 apply。
2. dsh-proactive 的 `selectionFromHeader()`（`src/wake.ts:786-794`）把会话
   **已提交 request header 的 `reasoningEffort` 原样透传**，不做任何有效性校验。
   实测 luna 最近的会话最后一条 `request/header` 是
   `{"config":{"provider":"cpa","model":"medium","maxTokens":65536}}`（**没有** reasoningEffort 字段），
   所以这条路径当前未直接引爆；但只要某个会话的 header 里存着 `low`/`medium`，
   唤醒就必然失败。这是**设计缺陷**：用户没改过会话，插件不该把会话固化的旧档位当真理。

### 处置

缺陷 5 影响 dsh-taskboard 与 dsh-mnemon，不在本次 dsh-proactive 修复范围内，
但与缺陷 2 高度相关。**不单独改动线上配置**，等专家 B 拿到真实错误后一并定夺。

## 六、已排除的假设

- ❌ 「工作区没有会话」——luna/rev/yu 三个 workspace 在注册表里分别有 28/12/14 个 sessionId。
- ❌ 「会话被 archived」——`archivedSessionIds` 为空。
- ❌ 「DSH 进程没起」——`dsh` RUNNING，uptime 7h+，面板 `/api/dsh-proactive/state` 正常返回。
- ❌ 「插件没加载」——`proactive_list` / `proactive_update_settings` 等工具在本会话可用，
  面板也能取到 5 个闹钟。（历史上确实发生过 `failed to import` 整树失败 204 次，
  已由 `818d3e1 fix(proactive): add missing cordis-plugin-loader devDependency` + 工作区重建自愈，
  最后一例在日志 49030 行，当前 50704 行的启动已无此错。）

## 七、验收标准（三条都必须满足才算修好）

1. 三个 `resume`/`workspace` 心跳各至少成功唤醒 1 次（`runs.jsonl` 出现 `reply` 或 `no_reply`，**不是** `skipped`）。
2. `new` 与 `fork` 各至少成功唤醒 1 次，且 `runs.jsonl` 的 `note` **带上真实失败原因**（可观测性本身就是缺陷 2 的一部分）。
3. world-master 的 `world-evolution-5am` 出现在 `alarms.json` 中。
4. 打开 `enabled` 总闸后，系统在安静时段外不产生刷屏投递。
