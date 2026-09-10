# 260910 跨会话闹钟工具 — 验证

## 单测（233/233）

- `proactive_update replaces a foreign-owned alarm's spec, keeping identity and history`：跨会话全量替换（prompt/every_seconds/type），owner/createdAt/runCount/lastRunAt 保留，updatedAt 刷新，requestDrive 触发；**时区链跟随 owner**（owner s2 的 client zone Asia/Tokyo，executor 是 s1）。
- `full-dialect validation and state guards`：缺 selector → invalid_trigger；every_seconds 299 → frequency_too_high；未知 key（wake_reason）→ invalid_trigger（闭式）；in-flight/completed/cancelled/failed → invalid_action；paused → 编辑后 scheduled。（prompt 缺失由 dsh-tools 参数 schema 在 runtime 拦截，进不到方言校验。）
- `workspace target keeps the alarm's workspace unless given a new one`：无参数沿用已解析 id（**无 resolver 也能改**）；显式新 id → resolver（缺 registry 时闭式 not_found）；非 workspace 闹钟切 workspace 无参数 → executor cwd 默认 → resolver。
- `restores the old alarm when persistence fails`：persist 失败回滚旧 spec。
- `proactive_cancel cancels any owner by exact id`：foreign owner 可取消；unknown/completed → not_found。

## E2E（隔离 0.1.2-rc.1 host，端口 4599）

场景（一次真实模型回合，完整工具链）：

1. 经面板 API 以 session-a052da44（alpha 工作区）owner 创建 once 闹钟 `alarm_mtv52omc2epj10`（"别人的闹钟"）。
2. 在**另一会话** 5b4c80aa（同工作区、非 owner）发真实指令：list all=true 找 id → proactive_update（prompt 换、after_seconds=25、target_mode=workspace、target_workspace_id）→ 再 list 确认。
3. 模型准确执行：update args 逐字正确（session 日志 tool/call 佐证）。
4. 闹钟列表确认：owner 仍为 **session-a052da44**（identity 保留）、prompt 已换、mode=workspace、ws=b9176204。
5. 25 秒后 fire：**工作区目的地解析为 5b4c80aa**——正确：我的指令消息是该工作区最新人类活动（"destination follows the user's latest activity" 语义的直接验证）；run 记录 decision=reply、replySummary=**ok7**，唤醒通知落 5b4c80aa 日志。

结论：跨会话 update / owner 保留 / 方言 round-trip / workspace 目的地跟随最新活动，全链路通过。cancel 跨会话由单测覆盖（与 update 同一 id 查找路径）。

## 残余风险

- GUI 会话页 tab 的编辑/取消仍限 owner（设计如此：会话上下文内只管理本会话；跨会话走设置页或模型工具）。
- update 的 workspace 沿用臂不重新检查工作区存在性（fire 时闭式 failed 兜底；显式换目标仍检查）——见 plan.md 权衡。
