/**
 * Shared building blocks for the two Proactive surfaces (settings section =
 * host-wide view, conversation tab = session view). Pure presentational
 * components over the wire DTOs; data flow stays in the owning panels.
 *
 * v4 (260911 target refactor): the create/edit form speaks the new target
 * dialect — 目标类型 (new/resume/fork) is orthogonal to 来源
 * (session/workspace/preset). "new" carries optional workspace/preset/model
 * config; resume/fork pick their source conversation by session id, the
 * workspace's most recent session, or the preset's most recent session. The
 * owner is not a form field: the conversation tab pins its own session, the
 * settings page derives it from the target. All labels — pills, run headers,
 * dates — flow through the locale dictionary.
 */

import { Fragment, useEffect, useMemo, useState, type ReactElement } from "react";
import { createArgsFromForm, type PanelCreateForm } from "../panel/contract.js";
import { DEFAULT_WAKE_PROMPT, isValidSessionId, MAX_PROMPT_LENGTH } from "../domain.js";
import type { ProactivePanelCopy } from "./locales.js";
import type { PresetInfo, WorkspaceInfo } from "./host-api.js";

/** Row shape the alarms table renders (a subset of the wire AlarmView). */
export interface AlarmRow {
  id: string;
  /** Owner session (creator); wire-compatible legacy name. */
  sessionId: string;
  sessionTitle?: string;
  type: string;
  targetMode: string;
  /** Source arm for resume/fork targets (session/workspace/preset). */
  targetSource?: string;
  targetSessionId?: string;
  targetSessionTitle?: string;
  /** Workspace id (workspace-sourced resume/fork, legacy workspace mode, or new-mode config). */
  targetWorkspaceId?: string;
  /** Workspace display title (client-enriched). */
  targetWorkspaceTitle?: string;
  /** Preset id (preset-sourced resume/fork, or new-mode stamp). */
  targetPresetId?: string;
  /** New-mode model override. */
  targetProvider?: string;
  targetModel?: string;
  respectQuietHours: boolean;
  prompt: string;
  nextDueAt: string;
  createdAt: string;
  state: string;
  compaction: "off" | "minimal" | "aggressive";
  jitterSeconds?: number;
  everySeconds?: number;
  cron?: string;
  at?: string;
}

export function stateLabel(copy: ProactivePanelCopy, state: string): string {
  switch (state) {
    case "scheduled": return copy.stateScheduled;
    case "overdue": return copy.stateOverdue;
    case "in-flight": return copy.stateInFlight;
    case "completed": return copy.stateCompleted;
    case "cancelled": return copy.stateCancelled;
    case "failed": return copy.stateFailed;
    case "paused": return copy.statePaused;
    default: return state;
  }
}

export function typeLabel(copy: ProactivePanelCopy, type: string): string {
  switch (type) {
    case "once": return copy.typeOnce;
    case "every": return copy.typeEvery;
    case "cron": return copy.typeCron;
    default: return type;
  }
}

export function targetLabel(copy: ProactivePanelCopy, mode: string): string {
  switch (mode) {
    case "resume": return copy.targetResume;
    case "fork": return copy.targetFork;
    case "new": return copy.targetNew;
    case "workspace": return copy.targetWorkspace;
    default: return mode;
  }
}

/** Source-arm label for resume/fork targets (session/workspace/preset). */
export function sourceLabel(copy: ProactivePanelCopy, source: string | undefined): string {
  switch (source) {
    case "workspace": return copy.sourceWorkspace;
    case "preset": return copy.sourcePreset;
    case "session": return copy.sourceSession;
    default: return copy.sourceSession;
  }
}

/**
 * The dim second line under the target pill: the named source for
 * resume/fork (session title / workspace title / preset id) or the new-mode
 * config summary (workspace · preset · provider/model).
 */
export function targetDetail(alarm: AlarmRow): ReactElement | null {
  if (alarm.targetMode === "workspace" || (alarm.targetMode !== "new" && alarm.targetSource === "workspace")) {
    return alarm.targetWorkspaceId !== undefined ? (
      <div className="dshp-cell-dim" style={{ marginTop: 2 }} title={alarm.targetWorkspaceId}>
        {alarm.targetWorkspaceTitle ?? alarm.targetWorkspaceId}
      </div>
    ) : null;
  }
  if (alarm.targetMode !== "new" && alarm.targetSource === "preset") {
    return alarm.targetPresetId !== undefined ? (
      <div className="dshp-cell-dim" style={{ marginTop: 2 }} title={alarm.targetPresetId}>{alarm.targetPresetId}</div>
    ) : null;
  }
  if (alarm.targetMode === "new") {
    const parts: string[] = [];
    if (alarm.targetWorkspaceId !== undefined && alarm.targetWorkspaceId !== "") {
      parts.push(alarm.targetWorkspaceTitle ?? alarm.targetWorkspaceId);
    }
    if (alarm.targetPresetId !== undefined && alarm.targetPresetId !== "") {
      parts.push(alarm.targetPresetId);
    }
    if (alarm.targetProvider !== undefined && alarm.targetModel !== undefined) {
      parts.push(alarm.targetProvider + "/" + alarm.targetModel);
    }
    return parts.length > 0 ? <div className="dshp-cell-dim" style={{ marginTop: 2 }}>{parts.join(" · ")}</div> : null;
  }
  return alarm.targetSessionId !== undefined && alarm.targetSessionId !== "" ? (
    <div className="dshp-cell-dim" style={{ marginTop: 2 }}>{alarm.targetSessionTitle ?? alarm.targetSessionId}</div>
  ) : null;
}

/** Run-history decision pill copy (no_reply/reply/skipped/failed). */
export function decisionLabel(copy: ProactivePanelCopy, decision: string): string {
  switch (decision) {
    case "no_reply": return copy.decisionNoReply;
    case "reply": return copy.decisionReply;
    case "skipped": return copy.decisionSkipped;
    case "failed": return copy.decisionFailed;
    default: return decision;
  }
}

export function fmtInstant(iso: string, localeTag: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(localeTag, { hour12: false });
}

export const HOST_PANEL_SESSION = "host-panel";

/** User-facing owner label: settings-page pseudo session → global. */
export function fmtSession(sessionId: string, sessionTitle: string | undefined, copy: ProactivePanelCopy): string {
  if (sessionTitle !== undefined && sessionTitle !== "") return sessionTitle;
  return sessionId === HOST_PANEL_SESSION ? copy.hostPanelLabel : sessionId;
}

/** Snapshot → the create-form prompt prefill (old hosts serve no field). */
export function defaultPromptOf(snapshot: { config: { defaultPrompt?: string } } | null | undefined): string {
  const value = snapshot?.config.defaultPrompt;
  return typeof value === "string" && value.trim() !== "" ? value : DEFAULT_WAKE_PROMPT;
}

export interface AlarmTableProps {
  alarms: AlarmRow[];
  runsByAlarm: Map<string, RunRow[]>;
  /** Render the owning-session column (host-wide view only). */
  showSession?: boolean;
  busy: boolean;
  copy: ProactivePanelCopy;
  onToggle: (id: string) => void;
  onCancel: (id: string) => void;
  onFire: (id: string) => void;
  onEdit: (id: string) => void;
  onCopyId: (sessionId: string) => void;
}

export interface RunRow {
  id: string;
  firedAt: string;
  decision: string;
  budgetDelta: number;
  reasoningSummary?: string;
  replySummary?: string;
}

type SortKey = "nextDue" | "created" | "prompt";

/** Non-terminal alarm states: still alive and potentially firing. */
const ACTIVE_STATES: ReadonlySet<string> = new Set(["scheduled", "overdue", "in-flight", "paused"]);

/** State-filter predicate; "active" is a pseudo-filter matching non-terminal states. */
function stateMatches(filter: string, state: string): boolean {
  if (filter === "") return true;
  if (filter === "active") return ACTIVE_STATES.has(state);
  return state === filter;
}

export function AlarmTable({ alarms, runsByAlarm, showSession, busy, copy, onToggle, onCancel, onFire, onEdit, onCopyId }: AlarmTableProps): ReactElement {
  const [stateFilter, setStateFilter] = useState<string>("active");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [sessionFilter, setSessionFilter] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("nextDue");
  const [expandedAlarm, setExpandedAlarm] = useState<string | null>(null);

  const stateOptions = useMemo(() => {
    const set = new Set(alarms.map((alarm) => alarm.state));
    return [...set].sort();
  }, [alarms]);

  const sessionOptions = useMemo(() => {
    const seen = new Set<string>();
    return alarms.filter((alarm) => (seen.has(alarm.sessionId) ? false : (seen.add(alarm.sessionId), true)));
  }, [alarms]);

  const visible = useMemo(() => {
    const filtered = alarms.filter(
      (alarm) =>
        stateMatches(stateFilter, alarm.state) &&
        (typeFilter === "" || alarm.type === typeFilter) &&
        (sessionFilter === "" || alarm.sessionId === sessionFilter)
    );
    const sorted = [...filtered].sort((a, b) => {
      // Time keys sort newest/soonest-last → descending, so the freshest
      // creation and the farthest next due sit on top; prompt stays alpha.
      if (sortKey === "created") return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
      if (sortKey === "prompt") return a.prompt.localeCompare(b.prompt);
      return a.nextDueAt < b.nextDueAt ? 1 : a.nextDueAt > b.nextDueAt ? -1 : 0;
    });
    return sorted;
  }, [alarms, stateFilter, typeFilter, sessionFilter, sortKey]);

  const colSpan = showSession === true ? 8 : 7;

  return (
    <div className="dshp-table-wrap">
      <div className="dshp-toolbar">
        <select className="dshp-input" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
          <option value="active">{copy.filterActive}</option>
          <option value="">{copy.filterAllStates}</option>
          {stateOptions.map((value) => <option key={value} value={value}>{stateLabel(copy, value)}</option>)}
        </select>
        <select className="dshp-input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">{copy.filterAllTypes}</option>
          <option value="once">{copy.typeOnce}</option>
          <option value="every">{copy.typeEvery}</option>
          <option value="cron">{copy.typeCron}</option>
        </select>
        {showSession === true ? (
          <select className="dshp-input" value={sessionFilter} onChange={(e) => setSessionFilter(e.target.value)}>
            <option value="">{copy.filterAllSessions}</option>
            {sessionOptions.map((alarm) => (
              <option key={alarm.sessionId} value={alarm.sessionId}>{fmtSession(alarm.sessionId, alarm.sessionTitle, copy)}</option>
            ))}
          </select>
        ) : null}
        <select className="dshp-input" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
          <option value="nextDue">{copy.sortBy}: {copy.sortNextDue}</option>
          <option value="created">{copy.sortBy}: {copy.sortCreated}</option>
          <option value="prompt">{copy.sortBy}: {copy.sortPrompt}</option>
        </select>
      </div>
      <table className="dshp-table">
        <thead>
          <tr>
            <th>{copy.prompt}</th>
            <th>{copy.state}</th>
            <th>{copy.type}</th>
            <th>{copy.target}</th>
            <th>{copy.nextDue}</th>
            {showSession === true ? <th>{copy.session}</th> : null}
            <th>{copy.history}</th>
            <th> </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((alarm) => {
            const runs = runsByAlarm.get(alarm.id) ?? [];
            const expanded = expandedAlarm === alarm.id;
            return (
              <Fragment key={alarm.id}>
                <tr>
                  <td>
                    <div className="dshp-cell-main" title={alarm.prompt}>{alarm.prompt}</div>
                    <div className="dshp-cell-dim">
                      {stateLabel(copy, alarm.state)}
                      {alarm.respectQuietHours ? <span className="dshp-pill dshp-pill-plain" style={{ marginLeft: 6 }}>{copy.quietLabel}</span> : null}
                    </div>
                  </td>
                  <td><StatePill copy={copy} state={alarm.state} /></td>
                  <td>
                    <span className="dshp-pill dshp-pill-plain">{typeLabel(copy, alarm.type)}</span>
                    {alarm.jitterSeconds !== undefined && alarm.jitterSeconds > 0 ? (
                      <span className="dshp-pill dshp-pill-accent" style={{ marginLeft: 4 }} title={copy.jitterSeconds}>±{alarm.jitterSeconds}s</span>
                    ) : null}
                  </td>
                  <td>
                    <span className="dshp-pill dshp-pill-plain">{targetLabel(copy, alarm.targetMode)}</span>
                    {targetDetail(alarm)}
                  </td>
                  <td className="dshp-cell-mono">{fmtInstant(alarm.nextDueAt, copy.dateTimeLocale)}</td>
                  {showSession === true ? (
                    <td>
                      <span className="dshp-session-cell">{fmtSession(alarm.sessionId, alarm.sessionTitle, copy)}</span>
                      <button
                        className="dshp-copy-btn"
                        title={copy.copyId}
                        aria-label={copy.copyId}
                        onClick={(e) => { e.stopPropagation(); onCopyId(alarm.sessionId); }}
                      >⧉</button>
                    </td>
                  ) : null}
                  <td>
                    <button className="dshp-btn dshp-btn-sm" disabled={busy} onClick={() => setExpandedAlarm(expanded ? null : alarm.id)}>
                      {expanded ? copy.hideHistory : copy.history} ({runs.length})
                    </button>
                  </td>
                  <td>
                    <div className="dshp-btn-row">
                      {alarm.state === "scheduled" || alarm.state === "overdue" ? (
                        <button className="dshp-btn dshp-btn-sm" disabled={busy} onClick={() => onToggle(alarm.id)}>{copy.pause}</button>
                      ) : null}
                      {alarm.state === "paused" ? (
                        <button className="dshp-btn dshp-btn-sm" disabled={busy} onClick={() => onToggle(alarm.id)}>{copy.resume}</button>
                      ) : null}
                      {alarm.state === "scheduled" || alarm.state === "overdue" || alarm.state === "paused" ? (
                        <button className="dshp-btn dshp-btn-sm" disabled={busy} onClick={() => onEdit(alarm.id)}>{copy.edit}</button>
                      ) : null}
                      {alarm.state === "scheduled" || alarm.state === "overdue" || alarm.state === "paused" ? (
                        <button className="dshp-btn dshp-btn-sm dshp-btn-danger" disabled={busy} onClick={() => onCancel(alarm.id)}>{copy.cancel}</button>
                      ) : null}
                      {alarm.state === "scheduled" || alarm.state === "overdue" || alarm.state === "paused" ? (
                        <button className="dshp-btn dshp-btn-sm" disabled={busy} onClick={() => onFire(alarm.id)}>{copy.fire}</button>
                      ) : null}
                    </div>
                  </td>
                </tr>
                {expanded ? (
                  <tr className="dshp-history-row">
                    <td colSpan={colSpan}>
                      <RunsTable runs={runs} copy={copy} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
          {visible.length === 0 ? (
            <tr><td colSpan={colSpan}><div className="dshp-empty">{copy.emptyAlarms}</div></td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function StatePill({ copy, state }: { copy: ProactivePanelCopy; state: string }): ReactElement {
  const tone =
    state === "scheduled" ? "accent" :
    state === "overdue" ? "warn" :
    state === "in-flight" ? "warn" :
    state === "completed" ? "success" :
    state === "cancelled" || state === "failed" ? "error" : "plain";
  return <span className={"dshp-pill dshp-pill-" + tone}>{stateLabel(copy, state)}</span>;
}

export interface RunsTableProps {
  runs: RunRow[];
  copy: ProactivePanelCopy;
}

export function RunsTable({ runs, copy }: RunsTableProps): ReactElement {
  if (runs.length === 0) return <div className="dshp-empty">{copy.emptyRuns}</div>;
  const rows = runs.slice(-8).reverse();
  return (
    <table className="dshp-table dshp-table-sub">
      <thead>
        <tr>
          <th>{copy.runTime}</th>
          <th>{copy.runDecision}</th>
          <th>{copy.runBudget}</th>
          <th>{copy.runSummary}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((run) => {
          const summaryParts = [
            ...(run.reasoningSummary !== undefined && run.reasoningSummary !== "" ? [copy.thinkingPrefix + run.reasoningSummary] : []),
            ...(run.replySummary !== undefined && run.replySummary !== "" ? [copy.replyPrefix + run.replySummary] : [])
          ];
          const summaryText = summaryParts.join(" · ");
          return (
            <tr key={run.id}>
              <td className="dshp-cell-mono">{fmtInstant(run.firedAt, copy.dateTimeLocale)}</td>
              <td><span className="dshp-pill dshp-pill-plain" title={run.decision}>{decisionLabel(copy, run.decision)}</span></td>
              <td className="dshp-cell-mono">{run.budgetDelta}</td>
              <td>
                <div className="dshp-cell-main" style={{ maxWidth: 420 }} title={summaryText}>{summaryText || "—"}</div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export interface CreateFormProps {
  form: PanelCreateForm;
  setForm: (form: PanelCreateForm) => void;
  showForm: boolean;
  setShowForm: (show: boolean) => void;
  busy: boolean;
  copy: ProactivePanelCopy;
  onSubmit: () => void;
  /** Editing an existing alarm instead of creating a new one. */
  editing?: boolean;
  /**
   * Known host sessions (id → title, from session.list) when available: a
   * typed target shows its live title, and an id outside the list gets a
   * soft typo hint — non-blocking, cold/foreign ids are still submittable.
   */
  knownSessions?: ReadonlyMap<string, string>;
  /** Registered workspaces (from the live client store) for the workspace pickers. */
  knownWorkspaces?: readonly WorkspaceInfo[];
  /** Agent preset roster (from the panel snapshot) for the preset pickers. */
  knownPresets?: readonly PresetInfo[];
  /** Preselect for the workspace picker: the workspace of the current session. */
  defaultWorkspaceId?: string;
}

/** Option label for one workspace: title with the path as the disambiguator. */
function workspaceOptionLabel(workspace: WorkspaceInfo): string {
  const title = workspace.title !== "" ? workspace.title : workspace.path;
  return title === workspace.path ? title : title + " · " + workspace.path;
}

/** Option label for one preset: authored name (else the id), default marked. */
function presetOptionLabel(preset: PresetInfo): string {
  const base = preset.name !== undefined && preset.name !== "" ? preset.name : preset.id;
  return (preset.isDefault === true ? base + " · default" : base) + (preset.broken !== undefined ? " ⚠" : "");
}

/**
 * The one create/edit form used by BOTH surfaces (settings page and the
 * conversation tab — identical options by design). The target section is a
 * mode selector (new/resume/fork): "new" carries optional workspace/preset/
 * model config; resume/fork pick a source (session id / workspace recent /
 * preset recent). The owner session is derived by the caller, never picked
 * here.
 */
export function CreateForm({ form, setForm, showForm, setShowForm, busy, copy, onSubmit, editing, knownSessions, knownWorkspaces, knownPresets, defaultWorkspaceId }: CreateFormProps): ReactElement {
  // Hooks FIRST — the showForm early-return below must not conditionally skip
  // them (React requires a stable hook count across renders of one instance).
  const targetIdRaw = (form.targetSessionId ?? "").trim();
  const [settledTargetId, setSettledTargetId] = useState(targetIdRaw);
  useEffect(() => {
    const timer = setTimeout(() => setSettledTargetId(targetIdRaw), 500);
    return () => { clearTimeout(timer); };
  }, [targetIdRaw]);

  if (!showForm) return <Fragment />;
  const kind = form.kind ?? "every";
  const mode = form.targetMode ?? "resume";
  const pickKind = (nextKind: PanelCreateForm["kind"]) => {
    if (nextKind === "every") setForm({ ...form, kind: nextKind, everySeconds: form.everySeconds ?? 3600 });
    else if (nextKind === "cron") setForm({ ...form, kind: nextKind, cron: form.cron ?? "" });
    // "once" needs a concrete delay so the submit guard passes immediately
    // (the input would otherwise show a fallback the form state lacks).
    else setForm({ ...form, kind: nextKind, afterSeconds: form.afterSeconds ?? (form.atDate !== undefined && form.atDate !== "" ? undefined : 3600) });
  };
  const targetId = targetIdRaw;
  const sessionTargeted = mode === "resume" || mode === "fork";
  const source = sessionTargeted ? (form.targetSource ?? "session") : undefined;
  const sessionSourced = source === "session";
  const targetInvalid = sessionTargeted && sessionSourced && targetId !== "" && !isValidSessionId(targetId);
  // Live title lookup: shown the moment the typed id matches a known session
  // (exact match — a partial id is not yet a session).
  const targetTitle = sessionTargeted && sessionSourced && !targetInvalid && targetId !== ""
    ? knownSessions?.get(targetId)
    : undefined;
  // The unknown-id warning is NEGATIVE feedback: it only fires on the
  // SETTLED id (500ms after typing stops), so typing a known id
  // character-by-character does not flash "not in the list" on every
  // keystroke — the positive title lookup above stays instant.
  const targetUnknown = sessionTargeted && sessionSourced && !targetInvalid && settledTargetId === targetId && targetId !== "" &&
    knownSessions !== undefined && knownSessions.size > 0 && !knownSessions.has(targetId);
  const workspaces = knownWorkspaces ?? [];
  const workspaceSelected = (form.targetWorkspaceId ?? "").trim();
  const workspaceMissing = sessionTargeted && source === "workspace" && workspaces.length === 0;
  const presets = knownPresets ?? [];
  const presetSelected = (form.targetPresetId ?? "").trim();
  const presetSourced = sessionTargeted && source === "preset";
  const canSubmit =
    (form.prompt ?? "").trim() !== "" &&
    (kind !== "every" || (form.everySeconds ?? 0) >= 300) &&
    (kind !== "cron" || (form.cron ?? "").trim() !== "") &&
    (kind !== "once" || (form.afterSeconds !== undefined && (form.afterSeconds ?? 0) > 0) || ((form.atDate ?? "") !== "" && (form.atTime ?? "") !== "")) &&
    (sessionTargeted && sessionSourced ? targetId !== "" && !targetInvalid : true) &&
    (sessionTargeted && source === "workspace" ? workspaceSelected !== "" : true) &&
    (presetSourced ? presetSelected !== "" : true);

  return (
    <div className="dshp-card">
      <div className="dshp-card-head">{editing === true ? copy.edit : copy.newAlarm}</div>
      <div className="dshp-card-body">
        <div className="dshp-field">
          <label className="dshp-field-label">{copy.prompt}</label>
          <input className="dshp-input dshp-grow" value={form.prompt ?? ""} maxLength={MAX_PROMPT_LENGTH} placeholder={copy.promptPlaceholder} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
        </div>
        <div className="dshp-field-row">
          <div className="dshp-field" style={{ flex: 1, minWidth: 220 }}>
            <label className="dshp-field-label">{copy.type}</label>
            <div className="dshp-btn-row">
              {(["once", "every", "cron"] as const).map((k) => (
                <button key={k} className={"dshp-btn dshp-btn-sm" + (kind === k ? " dshp-btn-primary" : "")} onClick={() => pickKind(k)}>
                  {typeLabel(copy, k)}
                </button>
              ))}
            </div>
          </div>
          <div className="dshp-field" style={{ flex: 1, minWidth: 220 }}>
            <label className="dshp-field-label">{copy.jitterSeconds}</label>
            <input className="dshp-input" type="number" min={0} max={86400} step={1} value={form.jitterSeconds ?? 0}
              placeholder={copy.jitterPlaceholder}
              onChange={(e) => {
                const value = Number(e.target.value);
                setForm({ ...form, jitterSeconds: Number.isFinite(value) ? Math.max(0, Math.min(86400, Math.floor(value))) : 0 });
              }} />
            <div className="dshp-cell-dim">{copy.jitterEveryHint}</div>
          </div>
        </div>
        {kind === "once" ? (
          <div className="dshp-field-row">
            <div className="dshp-field" style={{ flex: 1, minWidth: 160 }}>
              <label className="dshp-field-label">{copy.delaySeconds}</label>
              <input className="dshp-input" type="number" min={1} step={1} value={form.afterSeconds ?? 3600}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  setForm({ ...form, afterSeconds: Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined, atDate: undefined, atTime: undefined });
                }} />
            </div>
            <div className="dshp-field" style={{ flex: 1, minWidth: 200 }}>
              <label className="dshp-field-label">{copy.atDateTime}</label>
              <div className="dshp-field-row">
                <input className="dshp-input" type="date" value={form.atDate ?? ""} onChange={(e) => setForm({ ...form, atDate: e.target.value, afterSeconds: undefined })} />
                <input className="dshp-input" type="time" value={form.atTime ?? ""} onChange={(e) => setForm({ ...form, atTime: e.target.value, afterSeconds: undefined })} />
              </div>
            </div>
          </div>
        ) : kind === "every" ? (
          <div className="dshp-field">
            <label className="dshp-field-label">{copy.everySeconds}</label>
            <input className="dshp-input" type="number" min={300} max={315360000} step={1} value={form.everySeconds ?? 3600}
              onChange={(e) => {
                const value = Number(e.target.value);
                setForm({ ...form, everySeconds: Number.isFinite(value) ? Math.floor(value) : 0 });
              }} />
          </div>
        ) : (
          <div className="dshp-field">
            <label className="dshp-field-label">{copy.cronExpression}</label>
            <input className="dshp-input dshp-grow" value={form.cron ?? ""} placeholder={copy.cronPlaceholder} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
          </div>
        )}
        <div className="dshp-field">
          <label className="dshp-switch-row dshp-switch-label" style={{ cursor: "pointer" }}>
            <span>
              <span className="dshp-switch-label">{copy.respectQuietHours}</span>
              <span className="dshp-switch-desc">{copy.quietHint}</span>
            </span>
            <label className="dshp-switch">
              <input type="checkbox" checked={form.respectQuietHours === true} onChange={(e) => setForm({ ...form, respectQuietHours: e.target.checked })} />
              <span className="dshp-switch-track" />
              <span className="dshp-switch-thumb" />
            </label>
          </label>
        </div>
        <div className="dshp-field-row">
          <div className="dshp-field" style={{ flex: 1, minWidth: 150 }}>
            <label className="dshp-field-label">{copy.target}</label>
            <select className="dshp-input dshp-grow" value={mode}
              onChange={(e) => {
                const nextMode = e.target.value as PanelCreateForm["targetMode"];
                // resume/fork entering the workspace source with nothing
                // chosen preselects the current session's own workspace
                // (when it belongs to one); "new" with no preset yet keeps
                // whatever was picked before — all fields round-trip.
                setForm({
                  ...form,
                  targetMode: nextMode,
                  ...(nextMode !== "new" && (form.targetSource ?? "session") === "workspace" && (form.targetWorkspaceId ?? "").trim() === "" && defaultWorkspaceId !== undefined ? { targetWorkspaceId: defaultWorkspaceId } : {})
                });
              }}>
              <option value="resume">{targetLabel(copy, "resume")}</option>
              <option value="fork">{targetLabel(copy, "fork")}</option>
              <option value="new">{targetLabel(copy, "new")}</option>
            </select>
            {mode === "new" ? <div className="dshp-cell-dim">{copy.newSessionHint}</div> : null}
          </div>
          {sessionTargeted ? (
            <div className="dshp-field" style={{ flex: 1, minWidth: 180 }}>
              <label className="dshp-field-label">{copy.targetSourceLabel}</label>
              <select className="dshp-input dshp-grow" value={source}
                onChange={(e) => {
                  const nextSource = e.target.value as NonNullable<PanelCreateForm["targetSource"]>;
                  // Entering the workspace source with nothing chosen
                  // preselects the current session's own workspace.
                  setForm({
                    ...form,
                    targetSource: nextSource,
                    ...(nextSource === "workspace" && (form.targetWorkspaceId ?? "").trim() === "" && defaultWorkspaceId !== undefined ? { targetWorkspaceId: defaultWorkspaceId } : {})
                  });
                }}>
                <option value="session">{sourceLabel(copy, "session")}</option>
                <option value="workspace">{sourceLabel(copy, "workspace")}</option>
                <option value="preset">{sourceLabel(copy, "preset")}</option>
              </select>
              {source === "preset" ? <div className="dshp-cell-dim">{copy.presetSourceHint}</div> : null}
            </div>
          ) : null}
          {sessionTargeted && source === "workspace" ? (
            <div className="dshp-field" style={{ flex: 2, minWidth: 260 }}>
              <label className="dshp-field-label">{copy.targetWorkspaceLabel}</label>
              <select className="dshp-input dshp-grow" value={workspaceSelected} disabled={workspaces.length === 0}
                onChange={(e) => setForm({ ...form, targetWorkspaceId: e.target.value })}>
                {workspaceSelected === "" ? <option value="">{copy.workspacePickPlaceholder}</option> : null}
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspaceOptionLabel(workspace)}</option>
                ))}
              </select>
              {workspaceMissing ? <div className="dshp-field-error">{copy.noWorkspaces}</div> : null}
              {mode === "resume" && !workspaceMissing ? <div className="dshp-cell-dim">{copy.workspaceHint}</div> : null}
            </div>
          ) : sessionTargeted && source === "preset" ? (
            <div className="dshp-field" style={{ flex: 2, minWidth: 260 }}>
              <label className="dshp-field-label">{copy.targetPresetLabel}</label>
              {presets.length > 0 ? (
                <select className="dshp-input dshp-grow" value={presetSelected}
                  onChange={(e) => setForm({ ...form, targetPresetId: e.target.value })}>
                  {presetSelected === "" ? <option value="">{copy.presetPickPlaceholder}</option> : null}
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id} disabled={preset.broken !== undefined}>
                      {presetOptionLabel(preset)}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="dshp-input dshp-grow dshp-input-mono" value={form.targetPresetId ?? ""}
                  placeholder={copy.presetIdPlaceholder} spellCheck={false} autoComplete="off"
                  onChange={(e) => setForm({ ...form, targetPresetId: e.target.value })} />
              )}
              {presets.length === 0 ? <div className="dshp-cell-dim">{copy.noPresets}</div> : null}
            </div>
          ) : sessionTargeted ? (
            <div className="dshp-field" style={{ flex: 2, minWidth: 260 }}>
              <label className="dshp-field-label">{mode === "fork" ? copy.forkSourceSessionId : copy.targetSessionId}</label>
              <input className="dshp-input dshp-grow dshp-input-mono" value={form.targetSessionId ?? ""}
                placeholder={copy.targetSessionPlaceholder} spellCheck={false} autoComplete="off"
                onChange={(e) => setForm({ ...form, targetSessionId: e.target.value })} />
              {targetInvalid ? <div className="dshp-field-error">{copy.invalidSessionId}</div> : null}
              {targetUnknown ? <div className="dshp-hint-warn">{copy.unknownSession}</div> : null}
              {targetTitle !== undefined && targetTitle !== "" ? <div className="dshp-cell-dim">{targetTitle}</div> : null}
            </div>
          ) : null}
        </div>
        {mode === "new" ? (
          <div className="dshp-field-row">
            <div className="dshp-field" style={{ flex: 1, minWidth: 200 }}>
              <label className="dshp-field-label">{copy.newWorkspaceLabel}</label>
              <select className="dshp-input dshp-grow" value={workspaceSelected} disabled={workspaces.length === 0}
                onChange={(e) => setForm({ ...form, targetWorkspaceId: e.target.value })}>
                <option value="">—</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspaceOptionLabel(workspace)}</option>
                ))}
              </select>
              {workspaces.length === 0 ? <div className="dshp-cell-dim">{copy.noWorkspaces}</div> : null}
            </div>
            <div className="dshp-field" style={{ flex: 1, minWidth: 200 }}>
              <label className="dshp-field-label">{copy.newPresetLabel}</label>
              {presets.length > 0 ? (
                <select className="dshp-input dshp-grow" value={presetSelected}
                  onChange={(e) => setForm({ ...form, targetPresetId: e.target.value })}>
                  <option value="">—</option>
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id} disabled={preset.broken !== undefined}>
                      {presetOptionLabel(preset)}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="dshp-input dshp-grow dshp-input-mono" value={form.targetPresetId ?? ""}
                  placeholder={copy.presetIdPlaceholder} spellCheck={false} autoComplete="off"
                  onChange={(e) => setForm({ ...form, targetPresetId: e.target.value })} />
              )}
            </div>
            <div className="dshp-field" style={{ flex: 1, minWidth: 160 }}>
              <label className="dshp-field-label">{copy.providerPlaceholder}</label>
              <input className="dshp-input dshp-grow dshp-input-mono" value={form.targetProvider ?? ""}
                spellCheck={false} autoComplete="off"
                onChange={(e) => setForm({ ...form, targetProvider: e.target.value })} />
            </div>
            <div className="dshp-field" style={{ flex: 1, minWidth: 160 }}>
              <label className="dshp-field-label">{copy.modelPlaceholder}</label>
              <input className="dshp-input dshp-grow dshp-input-mono" value={form.targetModel ?? ""}
                spellCheck={false} autoComplete="off"
                onChange={(e) => setForm({ ...form, targetModel: e.target.value })} />
            </div>
            <div className="dshp-cell-dim" style={{ alignSelf: "flex-end", flexBasis: "100%" }}>{copy.newConfigHint}</div>
          </div>
        ) : null}
        <div className="dshp-btn-row">
          <button className="dshp-btn dshp-btn-primary" disabled={busy || !canSubmit} onClick={onSubmit}>{editing === true ? copy.save : copy.create}</button>
          <button className="dshp-btn" onClick={() => setShowForm(false)}>{copy.cancel}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Default create-form state for BOTH surfaces: every 1h, user-requested,
 * resume on the given session (the caller's "current session"), prompt
 * pre-filled with the configured default preset.
 */
export function newAlarmForm(defaultPrompt: string, targetSessionId: string): PanelCreateForm {
  return { prompt: defaultPrompt, kind: "every", everySeconds: 3600, respectQuietHours: false, targetMode: "resume", targetSource: "session", targetSessionId };
}

/**
 * Build the edit-form state from an alarm row (v3 fields → form fields).
 * Legacy "workspace"-mode rows fold to resume + workspace source (the stored
 * record converges on save); v2 rows without an explicit source keep their
 * inferred one (workspace/preset ids present) or default to session.
 */
export function formFromAlarm(alarm: AlarmRow): PanelCreateForm {
  const mode: PanelCreateForm["targetMode"] = alarm.targetMode === "fork" || alarm.targetMode === "new" ? alarm.targetMode : "resume";
  const legacyWorkspace = alarm.targetMode === "workspace";
  const source: NonNullable<PanelCreateForm["targetSource"]> = mode === "new" || !legacyWorkspace
    ? (alarm.targetSource === "workspace" || alarm.targetSource === "preset" ? alarm.targetSource : "session")
    : "workspace";
  const workspaceId = alarm.targetWorkspaceId !== undefined && alarm.targetWorkspaceId !== "" ? alarm.targetWorkspaceId : undefined;
  const presetId = alarm.targetPresetId !== undefined && alarm.targetPresetId !== "" ? alarm.targetPresetId : undefined;
  const next: PanelCreateForm = {
    prompt: alarm.prompt,
    kind: alarm.type === "every" ? "every" : alarm.type === "cron" ? "cron" : "once",
    respectQuietHours: alarm.respectQuietHours,
    compaction: alarm.compaction,
    targetMode: mode,
    ...(mode !== "new" ? { targetSource: source } : {}),
    ...(mode !== "new" && source === "session" && alarm.targetSessionId !== undefined && alarm.targetSessionId !== "" ? { targetSessionId: alarm.targetSessionId } : {}),
    ...(workspaceId !== undefined ? { targetWorkspaceId: workspaceId } : {}),
    ...(presetId !== undefined ? { targetPresetId: presetId } : {}),
    ...(mode === "new" && alarm.targetProvider !== undefined && alarm.targetProvider !== "" ? { targetProvider: alarm.targetProvider } : {}),
    ...(mode === "new" && alarm.targetModel !== undefined && alarm.targetModel !== "" ? { targetModel: alarm.targetModel } : {})
  };
  if (alarm.type === "every") {
    next.everySeconds = alarm.everySeconds ?? 3600;
    if (alarm.jitterSeconds !== undefined && alarm.jitterSeconds > 0) next.jitterSeconds = alarm.jitterSeconds;
  } else if (alarm.type === "cron") {
    next.cron = alarm.cron ?? "";
    if (alarm.jitterSeconds !== undefined && alarm.jitterSeconds > 0) next.jitterSeconds = alarm.jitterSeconds;
  } else if (alarm.at !== undefined) {
    // One-shot at instant → offer "from now" so the edit form stays one
    // dialect; the row keeps showing its planned instant until saved.
    const remaining = Math.max(1, Math.floor((new Date(alarm.at).getTime() - Date.now()) / 1000));
    next.afterSeconds = remaining;
    if (alarm.jitterSeconds !== undefined && alarm.jitterSeconds > 0) next.jitterSeconds = alarm.jitterSeconds;
  } else {
    next.afterSeconds = 3600;
  }
  return next;
}

/** Inline loading state (initial snapshot pull) shared by both surfaces. */
export function LoadingBlock({ copy }: { copy: ProactivePanelCopy }): ReactElement {
  return (
    <div className="dshp-loading" role="status" aria-live="polite">
      <span className="dshp-spinner" aria-hidden="true" />
      <span>{copy.loading}</span>
    </div>
  );
}

export { createArgsFromForm };
export type { PanelCreateForm };
