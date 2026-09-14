/**
 * Locale dictionaries for the Proactive surfaces (settings section + the
 * conversation-page tab). Registered through ctx.locale.register so the tab
 * label and all copy follow the current UI language.
 *
 * v3 (260909 release polish): every user-visible label — including the
 * state/type/target pills and the runs-table headers that used to be
 * hardcoded zh — now flows through this dictionary, so the en surface is no
 * longer mixed-language. New keys cover the default-prompt prefill editor,
 * the target-session-id input, and the loading state.
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
  alarmsTitle: string;
  alarms: string;
  session: string;
  prompt: string;
  promptPlaceholder: string;
  state: string;
  nextDue: string;
  type: string;
  target: string;
  emptyAlarms: string;
  emptyRuns: string;
  filterActive: string;
  filterAllStates: string;
  filterAllSessions: string;
  filterAllTypes: string;
  sortBy: string;
  sortNextDue: string;
  sortCreated: string;
  sortPrompt: string;
  /* state / type / target pill labels (localized, keyed by domain value) */
  stateScheduled: string;
  stateOverdue: string;
  stateInFlight: string;
  stateCompleted: string;
  stateCancelled: string;
  stateFailed: string;
  statePaused: string;
  typeOnce: string;
  typeEvery: string;
  typeCron: string;
  targetResume: string;
  targetFork: string;
  targetNew: string;
  targetWorkspace: string;
  targetSourceLabel: string;
  sourceSession: string;
  sourceWorkspace: string;
  sourcePreset: string;
  presetSourceHint: string;
  targetWorkspaceLabel: string;
  workspaceHint: string;
  workspacePickPlaceholder: string;
  noWorkspaces: string;
  targetPresetLabel: string;
  presetPickPlaceholder: string;
  presetIdPlaceholder: string;
  noPresets: string;
  newWorkspaceLabel: string;
  newPresetLabel: string;
  newModelLabel: string;
  newConfigHint: string;
  providerPlaceholder: string;
  modelPlaceholder: string;
  quietLabel: string;
  /* runs table */
  runTime: string;
  runDecision: string;
  runBudget: string;
  runSummary: string;
  thinkingPrefix: string;
  replyPrefix: string;
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
  targetSessionId: string;
  forkSourceSessionId: string;
  targetSessionPlaceholder: string;
  invalidSessionId: string;
  unknownSession: string;
  decisionNoReply: string;
  decisionReply: string;
  decisionSkipped: string;
  decisionFailed: string;
  newSessionHint: string;
  /* global config */
  budget: string;
  perDay: string;
  quietHours: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  globalView: string;
  configSectionTitle: string;
  configSectionDesc: string;
  enabledToggle: string;
  defaultPromptLabel: string;
  defaultPromptHint: string;
  saveConfig: string;
  saved: string;
  loading: string;
  close: string;
  openSettings: string;
  /* misc */
  error: string;
  confirmCancel: string;
  storageCorrupt: string;
  hostPanelLabel: string;
  /** Intl locale tag used to render instants (zh-CN / en-US). */
  dateTimeLocale: string;
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
  alarmsTitle: "闹钟",
  alarms: "闹钟",
  session: "所属会话",
  prompt: "唤醒指令",
  promptPlaceholder: "例如：确认今天的待办进度",
  state: "状态",
  nextDue: "下次触发",
  type: "类型",
  target: "目标",
  emptyAlarms: "暂无闹钟。创建一个，模型到点会主动跟进。",
  emptyRuns: "还没有唤醒记录。",
  filterActive: "活跃中",
  filterAllStates: "全部状态",
  filterAllSessions: "全部会话",
  filterAllTypes: "全部类型",
  sortBy: "排序",
  sortNextDue: "下次触发",
  sortCreated: "创建时间",
  sortPrompt: "指令",
  stateScheduled: "待触发",
  stateOverdue: "已到期",
  stateInFlight: "执行中",
  stateCompleted: "已完成",
  stateCancelled: "已取消",
  stateFailed: "失败",
  statePaused: "已暂停",
  typeOnce: "单次",
  typeEvery: "循环",
  typeCron: "Cron",
  targetResume: "会话",
  targetFork: "分支",
  targetNew: "新建",
  targetWorkspace: "工作区",
  targetSourceLabel: "来源",
  sourceSession: "会话 ID",
  sourceWorkspace: "工作区最近活跃",
  sourcePreset: "Preset 最近活跃",
  presetSourceHint: "唤醒投递到运行该 preset 的最近活跃会话；没有时复用会新建一个、分支会失败。",
  targetWorkspaceLabel: "目标工作区",
  workspaceHint: "唤醒会投递到该工作区最近更新的会话；无可用会话时在其内新建。",
  workspacePickPlaceholder: "选择工作区…",
  noWorkspaces: "暂无已注册工作区（先把目录注册为工作区，见侧边栏）",
  targetPresetLabel: "目标 preset",
  presetPickPlaceholder: "选择 preset…",
  presetIdPlaceholder: "preset id",
  noPresets: "主机未提供 preset 列表，可手动输入 preset id",
  newWorkspaceLabel: "工作区（可选）",
  newPresetLabel: "Preset（可选）",
  newModelLabel: "模型（可选）",
  newConfigHint: "可选配置：工作区决定会话目录，preset 决定组合，模型决定唤醒回合所用的 LLM（全部留空 = 主机默认）。",
  providerPlaceholder: "provider，如 deepseek",
  modelPlaceholder: "model id",
  quietLabel: "免打扰",
  runTime: "时间",
  runDecision: "决策",
  runBudget: "预算",
  runSummary: "摘要（思考 / 回复）",
  thinkingPrefix: "思考：",
  replyPrefix: "回复：",
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
  targetSessionId: "目标会话 ID",
  forkSourceSessionId: "分支源会话 ID",
  targetSessionPlaceholder: "如 session-…（默认当前会话）",
  invalidSessionId: "会话 ID 格式不对：只能包含字母、数字与 . _ -",
  unknownSession: "此 ID 不在当前会话列表中——若是笔误请更正；确认无误可继续",
  decisionNoReply: "静默",
  decisionReply: "已回复",
  decisionSkipped: "跳过",
  decisionFailed: "失败",
  newSessionHint: "唤醒时新建一个空会话，不依赖任何既有会话",
  budget: "每日预算",
  perDay: "/日",
  quietHours: "安静时段",
  quietHoursStart: "安静时段开始",
  quietHoursEnd: "安静时段结束",
  globalView: "全局视图",
  configSectionTitle: "全局配置",
  configSectionDesc: "",
  enabledToggle: "启用主动唤醒",
  defaultPromptLabel: "默认唤醒指令",
  defaultPromptHint: "新建闹钟时预填这段文字；每个闹钟仍保存自己的指令",
  saveConfig: "保存配置",
  saved: "已保存",
  loading: "加载中…",
  close: "关闭",
  openSettings: "打开设置",
  error: "出错了",
  confirmCancel: "确认取消这个闹钟？",
  storageCorrupt: "（存储损坏，只读）",
  hostPanelLabel: "全局（设置页）",
  dateTimeLocale: "zh-CN"
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
  alarmsTitle: "Alarms",
  alarms: "alarms",
  session: "Owner session",
  prompt: "Wake-up instruction",
  promptPlaceholder: "e.g. check on today's todo progress",
  state: "State",
  nextDue: "Next due",
  type: "Type",
  target: "Target",
  emptyAlarms: "No alarms yet. Create one and the model will proactively follow up on schedule.",
  emptyRuns: "No wake runs yet.",
  filterActive: "Active",
  filterAllStates: "All states",
  filterAllSessions: "All sessions",
  filterAllTypes: "All types",
  sortBy: "Sort by",
  sortNextDue: "Next due",
  sortCreated: "Created",
  sortPrompt: "Prompt",
  stateScheduled: "Scheduled",
  stateOverdue: "Overdue",
  stateInFlight: "In-flight",
  stateCompleted: "Completed",
  stateCancelled: "Cancelled",
  stateFailed: "Failed",
  statePaused: "Paused",
  typeOnce: "Once",
  typeEvery: "Repeat",
  typeCron: "Cron",
  targetResume: "Session",
  targetFork: "Fork",
  targetNew: "New",
  targetWorkspace: "Workspace",
  targetSourceLabel: "Source",
  sourceSession: "Session id",
  sourceWorkspace: "Workspace recent",
  sourcePreset: "Preset recent",
  presetSourceHint: "The wake lands in the most recently active session running this preset; resume creates one when none exists, fork fails.",
  targetWorkspaceLabel: "Target workspace",
  workspaceHint: "The wake lands in the workspace's most recently updated session; a fresh one is created when it has none.",
  workspacePickPlaceholder: "Pick a workspace…",
  noWorkspaces: "No registered workspaces yet (register a directory as one in the sidebar first)",
  targetPresetLabel: "Target preset",
  presetPickPlaceholder: "Pick a preset…",
  presetIdPlaceholder: "preset id",
  noPresets: "No preset roster from the host; type a preset id manually",
  newWorkspaceLabel: "Workspace (optional)",
  newPresetLabel: "Preset (optional)",
  newModelLabel: "Model (optional)",
  newConfigHint: "Optional: the workspace sets the session directory, the preset its composition, the model its LLM (all empty = host defaults).",
  providerPlaceholder: "provider, e.g. deepseek",
  modelPlaceholder: "model id",
  quietLabel: "Quiet",
  runTime: "Time",
  runDecision: "Decision",
  runBudget: "Budget",
  runSummary: "Summary (thinking / reply)",
  thinkingPrefix: "Thinking: ",
  replyPrefix: "Reply: ",
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
  targetSessionId: "Target session ID",
  forkSourceSessionId: "Fork source session ID",
  targetSessionPlaceholder: "e.g. session-… (defaults to the current session)",
  invalidSessionId: "Invalid session ID: only letters, digits, and . _ - are allowed",
  unknownSession: "This id is not in the session list — fix a typo or continue if intentional",
  decisionNoReply: "silent",
  decisionReply: "replied",
  decisionSkipped: "skipped",
  decisionFailed: "failed",
  newSessionHint: "The wake runs in a fresh empty session.",
  budget: "Daily budget",
  perDay: "/day",
  quietHours: "Quiet hours",
  quietHoursStart: "Quiet hours start",
  quietHoursEnd: "Quiet hours end",
  globalView: "Global view",
  configSectionTitle: "Global config",
  configSectionDesc: "",
  enabledToggle: "Enable proactive wakes",
  defaultPromptLabel: "Default wake-up instruction",
  defaultPromptHint: "Pre-filled into the new-alarm form; each alarm still stores its own prompt",
  saveConfig: "Save config",
  saved: "Saved",
  loading: "Loading…",
  close: "Close",
  openSettings: "Open settings",
  error: "Error",
  confirmCancel: "Cancel this alarm?",
  storageCorrupt: "(storage corrupt, read-only)",
  hostPanelLabel: "Global (settings page)",
  dateTimeLocale: "en-US"
};
