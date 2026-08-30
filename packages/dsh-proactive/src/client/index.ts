/**
 * Browser half of dsh-proactive: registers the Proactive panel into the
 * official settings.section slot. Mounting problems are logged, never
 * thrown — an external plugin must not take the GUI down.
 */

import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { ProactivePanel } from "./panel.js";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** Panel surface copy. */
    "dsh-proactive": Record<string, string>;
  }
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ["slots", "settingsScope", "remote", "connection", "locale"];

/**
 * Mount the panel. Runs once per page lifetime: a duplicated client
 * injection would otherwise register a second section entry.
 */
export function apply(ctx: ClientContext): void {
  let applied = false;
  try {
    ctx.slots.register(
      {
        name: "settings.section",
        id: "dsh-proactive",
        order: 120,
        label: "Proactive 闹钟",
        inject: () => ({}),
      },
      ProactivePanel
    );
    applied = true;
  } catch (error) {
    console.error("[dsh-proactive] settings.section registration failed", error);
  }
  if (!applied) return;
  console.info("[dsh-proactive] panel registered into settings.section");
}