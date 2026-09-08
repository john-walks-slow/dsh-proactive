/**
 * Browser half of dsh-proactive. Two surfaces:
 *
 *   - settings.section "主动唤醒" — host-wide panel (all sessions' alarms,
 *     global run history, config summary).
 *   - conversation.view tab "主动唤醒" — the session view (this session's
 *     alarms, runs, and session preferences), alongside Chat / Trajectory.
 *
 * Mounting problems are logged, never thrown — an external plugin must not
 * take the GUI down.
 */

import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import { ProactivePanel } from "./panel.js";
import { ProactiveSessionPanel } from "./session-panel.js";
import { bindProactiveLocale } from "./use-locale.js";
import { injectProactiveStyles } from "./style.js";
import { zh, en } from "./locales.js";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** Panel + tab surface copy (v3 vocabulary: once/every/cron + resume/fork/new + defaultPrompt prefill). */
    "dsh-proactive": "tabLabel" | "globalTitle" | "sessionTitle" | "sessionSubtitle" | "refresh" | "newAlarm" | "create" | "save" | "cancel" | "pause" | "resume" | "fire" | "edit" | "history" | "hideHistory" | "copyId" | "copied" | "alarmsTitle" | "alarms" | "session" | "prompt" | "promptPlaceholder" | "state" | "nextDue" | "type" | "target" | "emptyAlarms" | "emptyRuns" | "filterAllStates" | "filterAllSessions" | "filterAllTypes" | "sortBy" | "sortNextDue" | "sortCreated" | "sortPrompt" | "stateScheduled" | "stateOverdue" | "stateInFlight" | "stateCompleted" | "stateCancelled" | "stateFailed" | "statePaused" | "typeOnce" | "typeEvery" | "typeCron" | "targetResume" | "targetFork" | "targetNew" | "quietLabel" | "runTime" | "runDecision" | "runBudget" | "runSummary" | "thinkingPrefix" | "replyPrefix" | "delaySeconds" | "atDateTime" | "everySeconds" | "cronExpression" | "cronPlaceholder" | "jitterSeconds" | "jitterPlaceholder" | "jitterEveryHint" | "respectQuietHours" | "quietHint" | "targetSessionId" | "forkSourceSessionId" | "targetSessionPlaceholder" | "invalidSessionId" | "unknownSession" | "decisionNoReply" | "decisionReply" | "decisionSkipped" | "decisionFailed" | "newSessionHint" | "budget" | "perDay" | "quietHours" | "quietHoursStart" | "quietHoursEnd" | "globalView" | "configSectionTitle" | "configSectionDesc" | "enabledToggle" | "defaultPromptLabel" | "defaultPromptHint" | "saveConfig" | "saved" | "loading" | "close" | "openSettings" | "error" | "confirmCancel" | "storageCorrupt" | "hostPanelLabel" | "dateTimeLocale";
  }
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ["slots", "settingsScope", "remote", "connection", "locale"];

const NS = "dsh-proactive" as const;

/**
 * Mount both surfaces. Runs once per page lifetime: a duplicated client
 * injection would otherwise register second section/tab entries.
 */
export function apply(ctx: ClientContext): void {
  injectProactiveStyles();

  // Register the locale dictionaries (the tab label and all copy follow the
  // active UI language), then subscribe the copy hook to the live service.
  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-proactive: dictionaries");
    bindProactiveLocale(ctx.locale);
  } catch (error) {
    console.error("[dsh-proactive] locale bind failed (falling back to zh)", error);
  }
  const t = ctx.locale.bind(NS);

  let anyApplied = false;
  try {
    ctx.slots.register(
      {
        name: "settings.section",
        id: "dsh-proactive",
        order: 120,
        locale: NS,
        label: () => t("tabLabel"),
        inject: () => ({}),
      },
      ProactivePanel
    );
    anyApplied = true;
  } catch (error) {
    console.error("[dsh-proactive] settings.section registration failed", error);
  }

  try {
    ctx.slots.inject("conversation.view", () =>
      ctx.slots.register({
        name: "conversation.view",
        id: "proactive",
        order: 20,
        locale: NS,
        label: () => t("tabLabel"),
        inject: () => ({}),
      }, ProactiveSessionPanel)
    );
    anyApplied = true;
  } catch (error) {
    console.error("[dsh-proactive] conversation.view registration failed", error);
  }

  if (anyApplied) console.info("[dsh-proactive] panel surfaces mounted (settings.section + conversation.view)");
}