/** Minimal copy for the panel; zh is the default surface language. */

export interface ProactivePanelCopy {
  title: string;
  refresh: string;
  alarms: string;
  runs: string;
  emptyAlarms: string;
  newAlarm: string;
  prompt: string;
  triggerKind: string;
  afterSeconds: string;
  everySeconds: string;
  wakeReason: string;
  heartbeatPreset: string;
  create: string;
  cancel: string;
  pause: string;
  resume: string;
  fire: string;
  state: string;
  nextDue: string;
  mode: string;
  budget: string;
  quietHours: string;
  todayDelivered: string;
  error: string;
  confirmCancel: string;
}

export const zh: ProactivePanelCopy = {
  title: "Proactive 闹钟",
  refresh: "刷新",
  alarms: "闹钟",
  runs: "最近唤醒",
  emptyAlarms: "暂无闹钟。创建一个，模型到点会主动跟进。",
  newAlarm: "新建闹钟",
  prompt: "唤醒指令",
  triggerKind: "触发方式",
  afterSeconds: "延迟秒数",
  everySeconds: "固定间隔秒数",
  wakeReason: "唤醒原因",
  heartbeatPreset: "心跳预设",
  create: "创建",
  cancel: "取消",
  pause: "暂停",
  resume: "恢复",
  fire: "立即触发",
  state: "状态",
  nextDue: "下次触发",
  mode: "模式",
  budget: "每日预算",
  quietHours: "安静时段",
  todayDelivered: "今日已投递",
  error: "出错了",
  confirmCancel: "确认取消这个闹钟？"
}

export const en: ProactivePanelCopy = {
  title: "Proactive Alarms",
  refresh: "Refresh",
  alarms: "Alarms",
  runs: "Recent runs",
  emptyAlarms: "No alarms yet. Create one and the model will proactively follow up on schedule.",
  newAlarm: "New alarm",
  prompt: "Wake-up instruction",
  triggerKind: "Trigger",
  afterSeconds: "Delay seconds",
  everySeconds: "Fixed interval seconds",
  wakeReason: "Wake reason",
  heartbeatPreset: "Heartbeat preset",
  create: "Create",
  cancel: "Cancel",
  pause: "Pause",
  resume: "Resume",
  fire: "Fire now",
  state: "State",
  nextDue: "Next due",
  mode: "Mode",
  budget: "Daily budget",
  quietHours: "Quiet hours",
  todayDelivered: "Delivered today",
  error: "Error",
  confirmCancel: "Cancel this alarm?"
}