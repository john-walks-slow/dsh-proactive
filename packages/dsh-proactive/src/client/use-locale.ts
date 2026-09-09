/**
 * Locale hook for the Proactive surfaces. Bound to the live locale service by
 * the client mount (index.ts); falls back to zh whenever the service is
 * absent. Re-renders on locale switches.
 *
 * The active language is derived from the live service on EVERY snapshot
 * read — never cached at bind time. The page can boot in the fallback locale
 * (en) before the persisted preference (zh) arrives; a bind-time cache would
 * strand a panel mounted in that window in the wrong language until the next
 * switch. Deriving per read keeps the tab label (framework projection) and
 * the panel content (this hook) permanently in agreement.
 */

import { useSyncExternalStore } from "react";
import { zh, en, type ProactivePanelCopy } from "./locales.js";

interface LocaleFaceLike {
  getSnapshot(): { active: string };
  subscribe(fn: () => void): () => void;
}

let bound: LocaleFaceLike | null = null;
let listeners = new Set<() => void>();

/** Resolve the active UI language through the live service (zh default). */
function resolveLanguage(): "zh" | "en" {
  const active = bound?.getSnapshot().active;
  return typeof active === "string" && (active === "en" || active.startsWith("en")) ? "en" : "zh";
}

/** Called by the client mount to bind the live locale service (idempotent). */
export function bindProactiveLocale(face: LocaleFaceLike): void {
  bound = face;
  // A panel may already be mounted (or the face may re-resolve its active
  // locale right after this) — wake every listener so it re-reads.
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  // Always notify and let getSnapshot decide: React bails out of the
  // re-render when the resolved dictionary object is unchanged.
  const unsubscribe = bound?.subscribe(fn);
  return () => {
    listeners.delete(fn);
    unsubscribe?.();
  };
}

function getSnapshot(): ProactivePanelCopy {
  return resolveLanguage() === "en" ? en : zh;
}

/** Copy for the current UI language; re-renders when the language changes. */
export function useProactiveLocale(): ProactivePanelCopy {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
