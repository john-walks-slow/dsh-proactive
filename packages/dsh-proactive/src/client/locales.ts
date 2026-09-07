/**
 * Locale dictionaries for the Proactive surfaces (settings section + the
 * conversation-page tab). Registered through ctx.locale.register so the tab
 * label and all copy follow the current UI language.
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
  wakeReason: string;
  state: string;
  nextDue: string;
  mode: string;
  emptyAlarms: string;
  emptyRuns: string;
  filterAllStates: string;
  filterAllSessions: string;
  filterAllModes: string;
  sortBy: string;
  sortNextDue: string;
  sortCreated: string;
  sortPrompt: string;
  /* create/edit form */
  triggerKind: string;
  afterSeconds: string;
  everySeconds: string;
  jitter: string;
  targetSession: string;
  selectSession: string;
  selectSessionFail: string;
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
  wakeReason: "唤醒原因",
  state: "状态",
  nextDue: "下次触发",
  mode: "模式",
  emptyAlarms: "暂无闹钟。创建一个，模型到点会主动跟进。",
  emptyRuns: "还没有唤醒记录。",
  filterAllStates: "全部状态",
  filterAllSessions: "全部会话",
  filterAllModes: "全部模式",
  sortBy: "排序",
  sortNextDue: "下次触发",
  sortCreated: "创建时间",
  sortPrompt: "指令",
  triggerKind: "触发方式",
  afterSeconds: "延迟秒数",
  everySeconds: "固定间隔秒数",
  jitter: "随机抖动 (±比例 0-1)",
  targetSession: "目标会话",
  selectSession: "请选择会话…",
  selectSessionFail: "无法获取会话列表",
  budget: "每日预算",
  quietHours: "安静时段",
  globalView: "全局视图",
  configSectionTitle: "全局配置",
  configSectionDesc: "全局开关与限额；心跳间隔/抖动请在每个闹钟上单独配置。",
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
  session: "Session",
  prompt: "Wake-up instruction",
  wakeReason: "Wake reason",
  state: "State",
  nextDue: "Next due",
  mode: "Mode",
  emptyAlarms: "No alarms yet. Create one and the model will proactively follow up on schedule.",
  emptyRuns: "No wake runs yet.",
  filterAllStates: "All states",
  filterAllSessions: "All sessions",
  filterAllModes: "All modes",
  sortBy: "Sort by",
  sortNextDue: "Next due",
  sortCreated: "Created",
  sortPrompt: "Prompt",
  triggerKind: "Trigger",
  afterSeconds: "Delay seconds",
  everySeconds: "Fixed interval seconds",
  jitter: "Random jitter (±ratio 0-1)",
  targetSession: "Target session",
  selectSession: "Select a session…",
  selectSessionFail: "session list unavailable",
  budget: "Daily budget",
  quietHours: "Quiet hours",
  globalView: "Global view",
  configSectionTitle: "Global config",
  configSectionDesc: "Global switch and limits; pick interval/jitter per alarm.",
  enabledToggle: "Enable proactive wakes",
  saveConfig: "Save config",
  saved: "Saved",
  loadFailure: "Load failed",
  close: "Close",
  openSettings: "Open settings",
  error: "Error",
  confirmCancel: "Cancel this alarm?"
};