# dsh-proactive 模块 AGENTS.md

## 职责

注册到每个 root agent 的 `proactive_*` 工具 + host 级闹钟调度：到点 resume 冷会话（或复用 live agent）投递 framing 唤醒报文，回合结束后由 observer 依据会话日志判定决策与预算增量。

## 地图

- `src/domain.ts` — 领域模型、校验、DST 正确的时区/本地时间解析（移植 dsh-schedule）、闭式错误码
- `src/config.ts` — 默认配置 + config.json/环境变量覆盖 + 安静时段判定
- `src/store.ts` — alarms.json（原子写）/runs.jsonl/state.json 持久化；corrupt 降级
- `src/scheduler.ts` — 串行 drive 循环：门控（安静/budget/hourly/boot 策略）、重试、单定时器重臂
- `src/wake.ts` — WakeDriver：live/cold 双路径、runMaintenance+followup、whenIdle、dispose、inflight 守卫
- `src/framing.ts` — 唤醒报文（wake_reason/user_presence/budget/quiet_hours/alarm_prompt_json + 3 条回复规则）；notice-form 用户消息
- `src/observer.ts` — 从会话日志切片判定 no_reply/reply/push/failed 与预算增量；leaked 标记
- `src/tools.ts` — proactive_set/list/cancel/no_reply（no_reply 需 inflight 且【只调它不写文本】）
- `src/index.ts` — 装配；agent/created 时对 roots 注册工具（resume 出的会话同样覆盖）

## 核心设计

- 状态在 host 侧（store 单例），工具通过闭包访问；与 dsh-schedule 的会话内提醒互补
- 静默 = framing 规则引导 + `exec.concludeTurn()` 机械结束（agent-loop 不再请求下一次补全）+ 不产出文本；GUI 对无文本 assistant 消息不渲染。文本先行的泄漏由 observer 标记并按可见输出计费，不阻断
- 预算：任一可见输出（聊天文本/push_notify/send_wechat）1 单位/UTC 日，上限 `maxDeliveriesPerDay`；no_reply 免费；预算耗尽跳过主动唤醒、用户委托 alarm 仍触发
- 安静时段（IANA 时区、跨午夜）：非 alarm 唤醒每 5 分钟延迟重评估；重复闹钟错过不补跑，推进到下一个锚点
- 唤醒回合判定依据**已提交的会话日志**（startIndex 之后的事件切片），不信任运行期假设

## Pitfalls

- 字符串构造 RegExp 时 `\d` 会在一层转义后被吞掉（"d" === "d"）——一律用正则字面量
- 写 TS 源码/文档时，模板字面量内的反引号与 `$` 必须先占位后替换，否则程序级语法错误
- 用 read 工具回写文件时注意 totalLines：read(limit) 只返回前 N 行，直接按返回内容 write 会截断文件（曾把 package.json 截成非法 JSON 导致 tsc 按 CJS 报 TS1295）。改 JSON/长文件要么读全，要么用 edit 做定点替换
- 本地改完要跑 `tsc -p tsconfig.json`（src+test 一起查）再 `node --test 'dist/test/*.test.js'`；node --test dist/test/ 目录形式在 Node 22 会 MODULE_NOT_FOUND
- tools 的 output.schema 每个属性都要带 `required: true`（dsh-tools 的 per-property 约定，不是 JSON Schema 顶层 required 数组）
- notice 来源必须带 `summary`（≤120 字符），否则 MessageSource 类型不满足
- 本沙箱 /dev 是 rootfs f2fs bind 且无设备节点：git 2.43 的临时文件种子会硬性 open(/dev/urandom)（getrandom(2) 成功了也没用）→ git add/commit 报 unable to get random bytes for temporary file（exit 128）。铁律：不得往 /dev 里 mknod 或建文件（SELinux app_data_file 标签中毒，见 chroot-devfs-pitfall）。合规解法：LD_PRELOAD 垫片把 /dev/urandom|/dev/random 的 open 重定向到 getrandom 填充的 memfd（零落盘痕迹），用法 export LD_PRELOAD=/root/.git-rnd-shim.so 再跑 git 命令；永不删 /dev/null（普通文件，删了 spawn ENOENT）