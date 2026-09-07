/**
 * Locale dictionaries for the Proactive surfaces (settings section + the
 * conversation-page tab). Registered through ctx.locale.register so the tab
 * label and all copy follow the current UI language.
 *
 * v2 (260907-proactive-alarm-v2): wake_reason / mode / jitter-ratio /
 * heartbeatPrompt copy removed; the vocabulary is now the three alarm types
 * (once/every/cron), the three target modes (resume/fork/new), the
 * per-alarm respect-quiet-hours switch and the unified jitter seconds.
 */

export interface ProactivePanelCopy {
  /* conversation.view tab + panel titles */
  tabLabel: string;
  globalTitle: string;
  sessionTitle: string;
  sessionSubtitle: string;
  /* actions */
  refresh: string;
  newAlarm: string;
  create: string;
  save: string;
  cancel: string;
  pause: string;
  resume: string;
  fire: string;
  edit: string;
  history: string;
  hideHistory: string;
  copyId: string;
  copied: string;
  /* table */
  alarms: string;
  session: string;
  prompt: string;
  state: string;
  nextDue: string;
  type: string;
  target: string;
  emptyAlarms: string;
  emptyRuns: string;
  filterAllStates: string;
  filterAllSessions: string;
  filterAllTypes: string;
  sortBy: string;
  sortNextDue: string;
  sortCreated: string;
  sortPrompt: string;
  /* create/edit form */
  delaySeconds: string;
  atDateTime: string;
  everySeconds: string;
  cronExpression: string;
  cronPlaceholder: string;
  jitterSeconds: string;
  jitterPlaceholder: string;
  jitterEveryHint: string;
  respectQuietHours: string;
  quietHint: string;
  targetSession: string;
  forkSourceSession: string;
  selectSession: string;
  selectSessionFail: string;
  newSessionHint: string;
  /* global config */
  budget: string;
  quietHours: string;
  globalView: string;
  configSectionTitle: string;
  configSectionDesc: string;
  enabledToggle: string;
  saveConfig: string;
  saved: string;
  loadFailure: string;
  close: string;
  openSettings: string;
  /* misc */
  error: string;
  confirmCancel: string;
}

export const zh: ProactivePanelCopy = {
  tabLabel: "主动唤醒",
  globalTitle: "主动唤醒 · 全局",
  sessionTitle: "主动唤醒",
  sessionSubtitle: "本会话的闹钟与唤醒历史。",
  refresh: "刷新",
  newAlarm: "新建闹钟",
  create: "创建",
  save: "保存",
  cancel: "取消",
  pause: "暂停",
  resume: "恢复",
  fire: "立即触发",
  edit: "编辑",
  history: "历史",
  hideHistory: "收起",
  copyId: "复制会话 ID",
  copied: "已复制",
  alarms: "闹钟",
  session: "所属会话",
  prompt: "唤醒指令",
  state: "状态",
  nextDue: "下次触发",
  type: "类型",
  target: "目标",
  emptyAlarms: "暂无闹钟。创建一个，模型到点会主动跟进。",
  emptyRuns: "还没有唤醒记录。",
  filterAllStates: "全部状态",
  filterAllSessions: "全部会话",
  filterAllTypes: "全部类型",
  sortBy: "排序",
  sortNextDue: "下次触发",
  sortCreated: "创建时间",
  sortPrompt: "指令",
  delaySeconds: "延迟秒数（从现在起）",
  atDateTime: "指定日期时间",
  everySeconds: "固定间隔秒数",
  cronExpression: "Cron 表达式",
  cronPlaceholder: "5 段，如 0 9 * * 1-5（分 时 日 月 周）",
  jitterSeconds: "随机抖动（秒）",
  jitterPlaceholder: "0 = 准时触发",
  jitterEveryHint: "建议 ≤ 间隔秒数",
  respectQuietHours: "遵从免打扰时段",
  quietHint: "不勾选 = 你明确要求：免打扰时段也照常触发，且不受每日预算限制",
  targetSession: "目标会话",
  forkSourceSession: "分支源会话",
  selectSession: "请选择会话…",
  selectSessionFail: "无法获取会话列表",
  newSessionHint: "唤醒时新建一个空会话，不依赖任何既有会话",
  budget: "每日预算",
  quietHours: "安静时段",
  globalView: "全局视图",
  configSectionTitle: "全局配置",
  configSectionDesc: "",
  enabledToggle: "启用主动唤醒",
  saveConfig: "保存配置",
  saved: "已保存",
  loadFailure: "加载失败",
  close: "关闭",
  openSettings: "打开设置",
  error: "出错了",
  confirmCancel: "确认取消这个闹钟？"
};

export const en: ProactivePanelCopy = {
  tabLabel: "Proactive",
  globalTitle: "Proactive · Global",
  sessionTitle: "Proactive",
  sessionSubtitle: "Alarms and wake history for this session.",
  refresh: "Refresh",
  newAlarm: "New alarm",
  create: "Create",
  save: "Save",
  cancel: "Cancel",
  pause: "Pause",
  resume: "Resume",
  fire: "Fire now",
  edit: "Edit",
  history: "History",
  hideHistory: "Hide",
  copyId: "Copy session ID",
  copied: "Copied",
  alarms: "Alarms",
  session: "Owner session",
  prompt: "Wake-up instruction",
  state: "State",
  nextDue: "Next due",
  type: "Type",
  target: "Target",
  emptyAlarms: "No alarms yet. Create one and the model will proactively follow up on schedule.",
  emptyRuns: "No wake runs yet.",
  filterAllStates: "All states",
  filterAllSessions: "All sessions",
  filterAllTypes: "All types",
  sortBy: "Sort by",
  sortNextDue: "Next due",
  sortCreated: "Created",
  sortPrompt: "Prompt",
  delaySeconds: "Delay seconds (from now)",
  atDateTime: "Pick date & time",
  everySeconds: "Fixed interval seconds",
  cronExpression: "Cron expression",
  cronPlaceholder: "5 fields, e.g. 0 9 * * 1-5 (min hour dom month dow)",
  jitterSeconds: "Jitter seconds",
  jitterPlaceholder: "0 = exact",
  jitterEveryHint: "should be ≤ interval",
  respectQuietHours: "Respect quiet hours",
  quietHint: "Unchecked = your explicit request: fires even in quiet hours, exempt from the daily budget",
  targetSession: "Target session",
  forkSourceSession: "Fork source session",
  selectSession: "Select a session…",
  selectSessionFail: "session list unavailable",
  newSessionHint: "The wake runs in a fresh empty session.",
  budget: "Daily budget",
  quietHours: "Quiet hours",
  globalView: "Global view",
  configSectionTitle: "Global config",
  configSectionDesc: "",
  enabledToggle: "Enable proactive wakes",
  saveConfig: "Save config",
  saved: "Saved",
  loadFailure: "Load failed",
  close: "Close",
  openSettings: "Open settings",
  error: "Error",
  confirmCancel: "Cancel this alarm?"
};