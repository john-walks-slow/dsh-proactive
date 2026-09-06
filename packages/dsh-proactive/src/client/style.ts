/**
 * Shared stylesheet for the Proactive surfaces (settings section + the
 * conversation-page tab). One <style> element injected once per page, driven
 * by the shell's --dsw-alias-* design tokens so the plugin matches the host
 * theme (light/dark) automatically. Class names are prefixed `dshp-` to stay
 * out of the host's naming space. No CSS module build step: esbuild bundles
 * plain JS only, so the stylesheet lives as a string here.
 */

let injected = false;
let cachedStyle: HTMLStyleElement | null = null;

/** Idempotent: injects the stylesheet at most once per page lifetime. */
export function injectProactiveStyles(): void {
  if (injected) return;
  injected = true;
  const style = document.createElement("style");
  style.textContent = STYLESHEET;
  cachedStyle = style;
  (document.head ?? document.documentElement).appendChild(style);
}

/** Removes the stylesheet (used by tests / hot reload contexts). */
export function removeProactiveStyles(): void {
  if (cachedStyle !== null) {
    cachedStyle.remove();
    cachedStyle = null;
  }
  injected = false;
}

const STYLESHEET = String.raw`
.dshp-panel {
  --dshp-radius: 10px;
  --dshp-gap: 14px;
  --dshp-border: var(--dsw-alias-border-l1, #e4e4e7);
  --dshp-border-strong: var(--dsw-alias-border-l2, #d4d4d8);
  --dshp-bg: var(--dsw-alias-bg-layer-1, #ffffff);
  --dshp-bg-alt: var(--dsw-alias-bg-layer-2, #fafafa);
  --dshp-text: var(--dsw-alias-label-primary, #18181b);
  --dshp-text-secondary: var(--dsw-alias-label-secondary, #3f3f46);
  --dshp-text-tertiary: var(--dsw-alias-label-tertiary, #71717a);
  --dshp-text-dimmed: var(--dsw-alias-label-dimmed, #a1a1aa);
  --dshp-accent: var(--dsw-alias-brand-primary, #4f46e5);
  --dshp-success: var(--dsw-alias-state-success-primary, #16a34a);
  --dshp-error: var(--dsw-alias-state-error-primary, #dc2626);
  --dshp-warn: var(--dsw-alias-state-warn-label, #d97706);
  --dshp-font: var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", sans-serif);
  --dshp-font-mono: var(--ds-font-family-code, ui-monospace, "SFMono-Regular", Menlo, monospace);
  font-family: var(--dshp-font);
  color: var(--dshp-text);
  font-size: 13px;
  line-height: 1.55;
  display: flex;
  flex-direction: column;
  gap: var(--dshp-gap);
}

/* ---------- header ---------- */
.dshp-panel .dshp-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.dshp-panel .dshp-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  letter-spacing: 0.01em;
}
.dshp-panel .dshp-sub {
  color: var(--dshp-text-tertiary);
  font-size: 12px;
}

/* ---------- cards ---------- */
.dshp-panel .dshp-card {
  background: var(--dshp-bg);
  border: 1px solid var(--dshp-border);
  border-radius: var(--dshp-radius);
  overflow: hidden;
}
.dshp-panel .dshp-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--dshp-border);
  background: var(--dshp-bg-alt);
  font-weight: 600;
  font-size: 12.5px;
  letter-spacing: 0.02em;
}
.dshp-panel .dshp-card-body {
  padding: 12px 14px;
}

/* ---------- table ---------- */
.dshp-panel .dshp-table-wrap {
  overflow-x: auto;
}
.dshp-panel table.dshp-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.dshp-panel .dshp-table th {
  text-align: left;
  padding: 8px 10px;
  font-weight: 600;
  color: var(--dshp-text-secondary);
  border-bottom: 1px solid var(--dshp-border-strong);
  background: var(--dshp-bg-alt);
  white-space: nowrap;
  font-size: 12px;
  letter-spacing: 0.02em;
}
.dshp-panel .dshp-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--dshp-border);
  vertical-align: top;
}
.dshp-panel .dshp-table tbody tr:last-child td {
  border-bottom: none;
}
.dshp-panel .dshp-table tbody tr:hover td {
  background: color-mix(in srgb, var(--dshp-bg-alt) 60%, transparent);
}
.dshp-panel .dshp-cell-main {
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshp-panel .dshp-cell-dim {
  color: var(--dshp-text-tertiary);
  font-size: 12px;
}
.dshp-panel .dshp-cell-mono {
  font-family: var(--dshp-font-mono);
  font-size: 11.5px;
  color: var(--dshp-text-secondary);
}

/* ---------- pills / badges ---------- */
.dshp-panel .dshp-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  white-space: nowrap;
  border: 1px solid transparent;
}
.dshp-panel .dshp-pill-plain { background: var(--dshp-bg-alt); border-color: var(--dshp-border); color: var(--dshp-text-secondary); }
.dshp-panel .dshp-pill-accent { background: color-mix(in srgb, var(--dshp-accent) 12%, transparent); color: var(--dshp-accent); }
.dshp-panel .dshp-pill-success { background: color-mix(in srgb, var(--dshp-success) 12%, transparent); color: var(--dshp-success); }
.dshp-panel .dshp-pill-warn { background: color-mix(in srgb, var(--dshp-warn) 12%, transparent); color: var(--dshp-warn); }
.dshp-panel .dshp-pill-error { background: color-mix(in srgb, var(--dshp-error) 10%, transparent); color: var(--dshp-error); }

/* ---------- buttons ---------- */
.dshp-panel .dshp-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  border-radius: 7px;
  border: 1px solid var(--dshp-border-strong);
  background: var(--dshp-bg);
  color: var(--dshp-text-secondary);
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  white-space: nowrap;
}
.dshp-panel .dshp-btn:hover:not(:disabled) {
  background: var(--dshp-bg-alt);
  border-color: var(--dsw-alias-border-l3, #a1a1aa);
}
.dshp-panel .dshp-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dshp-panel .dshp-btn-primary {
  background: var(--dshp-accent);
  border-color: var(--dshp-accent);
  color: #fff;
}
.dshp-panel .dshp-btn-primary:hover:not(:disabled) { filter: brightness(1.06); background: var(--dshp-accent); }
.dshp-panel .dshp-btn-danger { color: var(--dshp-error); }
.dshp-panel .dshp-btn-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dshp-error) 8%, transparent);
  border-color: var(--dshp-error);
}
.dshp-panel .dshp-btn-sm { padding: 2px 8px; font-size: 11.5px; border-radius: 6px; }
.dshp-panel .dshp-btn-row { display: inline-flex; gap: 6px; }

/* ---------- form ---------- */
.dshp-panel .dshp-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}
.dshp-panel .dshp-field-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--dshp-text-secondary);
}
.dshp-panel .dshp-field-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.dshp-panel input.dshp-input,
.dshp-panel select.dshp-input {
  font-family: inherit;
  font-size: 12.5px;
  padding: 5px 8px;
  border-radius: 7px;
  border: 1px solid var(--dshp-border-strong);
  background: var(--dshp-bg);
  color: var(--dshp-text);
  outline: none;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
  max-width: 100%;
}
.dshp-panel input.dshp-input:focus,
.dshp-panel select.dshp-input:focus {
  border-color: var(--dshp-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dshp-accent) 18%, transparent);
}
.dshp-panel input.dshp-input[type="number"] { width: 110px; }
.dshp-panel input.dshp-input.dshp-grow { flex: 1; min-width: 200px; }
.dshp-panel label.dshp-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  cursor: pointer;
  user-select: none;
}

/* ---------- section helper classes ---------- */
.dshp-panel .dshp-empty {
  padding: 18px 14px;
  text-align: center;
  color: var(--dshp-text-dimmed);
  font-size: 12.5px;
}
.dshp-panel .dshp-error {
  color: var(--dshp-error);
  font-size: 12.5px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--dshp-error) 30%, transparent);
  background: color-mix(in srgb, var(--dshp-error) 6%, transparent);
  border-radius: 8px;
}
.dshp-panel .dshp-meta {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  color: var(--dshp-text-tertiary);
  font-size: 12px;
}
.dshp-panel .dshp-meta b { color: var(--dshp-text-secondary); font-weight: 600; }
.dshp-panel .dshp-switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--dshp-border);
}
.dshp-panel .dshp-switch-row:last-child { border-bottom: none; }
.dshp-panel .dshp-switch-label { font-size: 12.5px; font-weight: 600; }
.dshp-panel .dshp-switch-desc { color: var(--dshp-text-tertiary); font-size: 12px; margin-top: 2px; }
.dshp-panel .dshp-switch {
  position: relative;
  width: 34px;
  height: 20px;
  flex: none;
  cursor: pointer;
}
.dshp-panel .dshp-switch input { opacity: 0; width: 0; height: 0; position: absolute; }
.dshp-panel .dshp-switch-track {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--dshp-border-strong);
  transition: background 0.15s ease;
}
.dshp-panel .dshp-switch input:checked + .dshp-switch-track { background: var(--dshp-accent); }
.dshp-panel .dshp-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  transition: transform 0.15s ease;
}
.dshp-panel .dshp-switch input:checked + .dshp-switch-track + .dshp-switch-thumb { transform: translateX(14px); }

/* ---------- alarm table toolbar (filter / sort) ---------- */
.dshp-panel .dshp-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dshp-border);
  background: var(--dshp-bg-alt);
}
.dshp-panel .dshp-toolbar select.dshp-input {
  width: auto;
  min-width: 110px;
  font-size: 12px;
  padding: 4px 6px;
}

/* ---------- session cell + copy button ---------- */
.dshp-panel .dshp-session-cell {
  display: inline-flex;
  align-items: center;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
.dshp-panel .dshp-copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 5px;
  padding: 1px 5px;
  font-size: 12px;
  line-height: 16px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--dshp-text-dimmed);
  cursor: pointer;
  vertical-align: middle;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}
.dshp-panel .dshp-copy-btn:hover {
  color: var(--dshp-accent);
  background: color-mix(in srgb, var(--dshp-accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--dshp-accent) 30%, transparent);
}

/* ---------- per-alarm history expansion ---------- */
.dshp-panel .dshp-history-row td {
  background: var(--dshp-bg-alt);
  padding: 10px 12px;
}
.dshp-panel table.dshp-table.dshp-table-sub {
  border: 1px solid var(--dshp-border);
  border-radius: 8px;
  overflow: hidden;
}
.dshp-panel table.dshp-table.dshp-table-sub th:first-child { border-top-left-radius: 8px; }
.dshp-panel table.dshp-table.dshp-table-sub th:last-child { border-top-right-radius: 8px; }

/* ---------- toast (copy feedback) ---------- */
.dshp-panel .dshp-toast {
  margin: 8px 10px;
  padding: 6px 10px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--dshp-success);
  background: color-mix(in srgb, var(--dshp-success) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--dshp-success) 30%, transparent);
}

/* ---------- textarea ---------- */
.dshp-panel textarea.dshp-input {
  font-family: inherit;
  font-size: 12.5px;
  padding: 6px 8px;
  border-radius: 7px;
  border: 1px solid var(--dshp-border-strong);
  background: var(--dshp-bg);
  color: var(--dshp-text);
  outline: none;
  resize: vertical;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.dshp-panel textarea.dshp-input:focus {
  border-color: var(--dshp-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dshp-accent) 18%, transparent);
}
`;