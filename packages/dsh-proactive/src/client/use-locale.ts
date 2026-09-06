/**
 * Locale hook for the Proactive surfaces. Bound to the live locale service by
 * the client mount (index.ts); falls back to browser/zh whenever the service
 * is absent. Re-renders on locale switches via the snapshot revision.
 */

import { useSyncExternalStore } from "react";
import { zh, en, type ProactivePanelCopy } from "./locales.js";

interface LocaleFaceLike {
  getSnapshot(): { active: string };
  subscribe(fn: () => void): () => void;
}

let bound: LocaleFaceLike | null = null;
let boundLanguage = "zh";
let listeners = new Set<() => void>();

/** Called by the client mount to bind the live locale service (idempotent). */
export function bindProactiveLocale(face: LocaleFaceLike): void {
  bound = face;
  const update = (): void => {
    const active = bound?.getSnapshot().active ?? "zh";
    const next = active === "en" || active.startsWith("en") ? "en" : "zh";
    if (next !== boundLanguage) {
      boundLanguage = next;
      for (const fn of listeners) fn();
    }
  };
  update();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const unsubscribe = bound?.subscribe(() => {
    const active = bound?.getSnapshot().active ?? "zh";
    const next = active === "en" || active.startsWith("en") ? "en" : "zh";
    if (next !== boundLanguage) {
      boundLanguage = next;
      fn();
    }
  });
  return () => {
    listeners.delete(fn);
    unsubscribe?.();
  };
}

function getSnapshot(): ProactivePanelCopy {
  return boundLanguage === "en" ? en : zh;
}

/** Copy for the current UI language; re-renders when the language changes. */
export function useProactiveLocale(): ProactivePanelCopy {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}