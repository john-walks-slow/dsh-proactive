/**
 * Shared building blocks for the two Proactive surfaces (settings section =
 * host-wide view, conversation tab = session view). Pure presentational
 * components over the wire DTOs; data flow stays in the owning panels.
 *
 * v2 (260907-proactive-alarm-v2): the table and the create/edit form speak the
 * three-type vocabulary (once/every/cron), the three target modes
 * (resume/fork/new), the per-alarm respect-quiet-hours switch and the unified
 * jitter seconds knob. The owner column (sessionId) stays separate from the
 * wake target column (targetSessionId).
 */

import { Fragment, useMemo, useState, type ReactElement } from "react";
import { createArgsFromForm, type PanelCreateForm } from "../panel/contract.js";
import type { ProactivePanelCopy } from "./locales.js";

/** Row shape the alarms table renders (a subset of the wire AlarmView). */
export interface AlarmRow {
  id: string;
  /** Owner session (creator); wire-compatible legacy name. */
  sessionId: string;
  sessionTitle?: string;
  type: string;
  targetMode: string;
  targetSessionId?: string;
  targetSessionTitle?: string;
  respectQuietHours: boolean;
  prompt: string;
  nextDueAt: string;
  createdAt: string;
  state: string;
  jitterSeconds?: number;
  everySeconds?: number;
  cron?: string;
  at?: string;
}

export const STATE_LABELS: Record<string, string> = {
  scheduled: "待触发",
  overdue: "已到期",
  "in-flight": "执行中",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
  paused: "已暂停"
};

export const TYPE_LABELS: Record<string, string> = {
  once: "单次",
  every: "循环",
  cron: "Cron"
};

export const TARGET_LABELS: Record<string, string> = {
  resume: "会话",
  fork: "分支",
  new: "新建"
};

export const QUIET_LABEL = "免打扰";

export function fmtInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export const HOST_PANEL_SESSION = "host-panel";

/** User-facing owner label: settings-page pseudo session → global. */
export function fmtSession(sessionId: string, sessionTitle?: string): string {
  if (sessionTitle !== undefined && sessionTitle !== "") return sessionTitle;
  return sessionId === HOST_PANEL_SESSION ? "全局（设置页）" : sessionId;
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

export function AlarmTable({ alarms, runsByAlarm, showSession, busy, copy, onToggle, onCancel, onFire, onEdit, onCopyId }: AlarmTableProps): ReactElement {
  const [stateFilter, setStateFilter] = useState<string>("");
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
        (stateFilter === "" || alarm.state === stateFilter) &&
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
          <option value="">{copy.filterAllStates}</option>
          {stateOptions.map((value) => <option key={value} value={value}>{STATE_LABELS[value] ?? value}</option>)}
        </select>
        <select className="dshp-input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">{copy.filterAllTypes}</option>
          {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {showSession === true ? (
          <select className="dshp-input" value={sessionFilter} onChange={(e) => setSessionFilter(e.target.value)}>
            <option value="">{copy.filterAllSessions}</option>
            {sessionOptions.map((alarm) => (
              <option key={alarm.sessionId} value={alarm.sessionId}>{fmtSession(alarm.sessionId, alarm.sessionTitle)}</option>
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
            const targetTitle = alarm.targetSessionTitle ?? alarm.targetSessionId;
            return (
              <Fragment key={alarm.id}>
                <tr>
                  <td>
                    <div className="dshp-cell-main" title={alarm.prompt}>{alarm.prompt}</div>
                    <div className="dshp-cell-dim">
                      {STATE_LABELS[alarm.state] ?? alarm.state}
                      {alarm.respectQuietHours ? <span className="dshp-pill dshp-pill-plain" style={{ marginLeft: 6 }}>{QUIET_LABEL}</span> : null}
                    </div>
                  </td>
                  <td><StatePill state={alarm.state} /></td>
                  <td>
                    <span className="dshp-pill dshp-pill-plain">{TYPE_LABELS[alarm.type] ?? alarm.type}</span>
                    {alarm.jitterSeconds !== undefined && alarm.jitterSeconds > 0 ? (
                      <span className="dshp-pill dshp-pill-accent" style={{ marginLeft: 4 }} title={copy.jitterSeconds}>±{alarm.jitterSeconds}s</span>
                    ) : null}
                  </td>
                  <td>
                    <span className="dshp-pill dshp-pill-plain">{TARGET_LABELS[alarm.targetMode] ?? alarm.targetMode}</span>
                    {alarm.targetMode !== "new" && targetTitle !== undefined && targetTitle !== "" ? (
                      <div className="dshp-cell-dim" style={{ marginTop: 2 }}>{fmtSession(alarm.targetSessionId ?? "", alarm.targetSessionTitle)}</div>
                    ) : null}
                  </td>
                  <td className="dshp-cell-mono">{fmtInstant(alarm.nextDueAt)}</td>
                  {showSession === true ? (
                    <td>
                      <span className="dshp-session-cell">{fmtSession(alarm.sessionId, alarm.sessionTitle)}</span>
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

function StatePill({ state }: { state: string }): ReactElement {
  const tone =
    state === "scheduled" ? "accent" :
    state === "overdue" ? "warn" :
    state === "in-flight" ? "warn" :
    state === "completed" ? "success" :
    state === "cancelled" || state === "failed" ? "error" : "plain";
  return <span className={"dshp-pill dshp-pill-" + tone}>{STATE_LABELS[state] ?? state}</span>;
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
          <th>{copy.state}</th>
          <th>决策</th>
          <th>预算</th>
          <th>摘要（思考 / 回复）</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((run) => {
          const summaryParts = [
            ...(run.reasoningSummary !== undefined && run.reasoningSummary !== "" ? ["思考：" + run.reasoningSummary] : []),
            ...(run.replySummary !== undefined && run.replySummary !== "" ? ["回复：" + run.replySummary] : [])
          ];
          const summaryText = summaryParts.join(" ｜ ");
          return (
            <tr key={run.id}>
              <td className="dshp-cell-mono">{fmtInstant(run.firedAt)}</td>
              <td><span className="dshp-pill dshp-pill-plain">{run.decision}</span></td>
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
  /** Host-wide view: session pickers (owner + wake target). The conversation tab pins its own session. */
  sessions?: Array<{ id: string; title?: string }>;
  /** Editing an existing alarm instead of creating a new one. */
  editing?: boolean;
  /** Conversation tab: the only allowed target/fork source is this session. */
  fixedSession?: string;
}

export function CreateForm({ form, setForm, showForm, setShowForm, busy, copy, onSubmit, sessions, editing, fixedSession }: CreateFormProps): ReactElement {
  if (!showForm) return <Fragment />;
  const kind = form.kind ?? "every";
  const pickKind = (nextKind: PanelCreateForm["kind"]) => {
    if (nextKind === "every") setForm({ ...form, kind: nextKind, everySeconds: form.everySeconds ?? 3600 });
    else if (nextKind === "cron") setForm({ ...form, kind: nextKind, cron: form.cron ?? "" });
    else setForm({ ...form, kind: nextKind });
  };
  const showOwnerPicker = sessions !== undefined;
  const showTargetPicker = sessions !== undefined && form.targetMode === "fork";
  const canSubmit =
    (form.prompt ?? "").trim() !== "" &&
    (kind !== "every" || (form.everySeconds ?? 0) >= 300) &&
    (kind !== "cron" || (form.cron ?? "").trim() !== "") &&
    (kind !== "once" || (form.afterSeconds !== undefined && (form.afterSeconds ?? 0) > 0) || ((form.atDate ?? "") !== "" && (form.atTime ?? "") !== "")) &&
    (!showOwnerPicker || (form.sessionId ?? "") !== "");

  return (
    <div className="dshp-card">
      <div className="dshp-card-head">{editing === true ? copy.edit : copy.newAlarm}</div>
      <div className="dshp-card-body">
        <div className="dshp-field">
          <label className="dshp-field-label">{copy.prompt}</label>
          <input className="dshp-input dshp-grow" value={form.prompt ?? ""} placeholder="例如：确认今天的待办进度" onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
        </div>
        <div className="dshp-field-row">
          <div className="dshp-field" style={{ flex: 1, minWidth: 220 }}>
            <label className="dshp-field-label">{copy.type}</label>
            <div className="dshp-btn-row">
              {(["once", "every", "cron"] as const).map((k) => (
                <button key={k} className={"dshp-btn dshp-btn-sm" + (kind === k ? " dshp-btn-primary" : "")} onClick={() => pickKind(k)}>
                  {TYPE_LABELS[k]}
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
        {showOwnerPicker ? (
          <div className="dshp-field">
            <label className="dshp-field-label">{copy.session}</label>
            <select className="dshp-input dshp-grow" value={form.sessionId ?? ""} disabled={editing === true}
              onChange={(e) => setForm({ ...form, sessionId: e.target.value })}>
              <option value="">{copy.selectSession}</option>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>{fmtSession(session.id, session.title)}</option>
              ))}
              {editing === true && !sessions.some((session) => session.id === form.sessionId) ? (
                // The alarm's owner may predate the live session list (e.g.
                // legacy rows); keep it visible in the disabled picker so the
                // edit form shows the real owner.
                <option value={form.sessionId ?? ""}>{fmtSession(form.sessionId ?? "")}</option>
              ) : null}
            </select>
            {sessions.length === 0 ? <div className="dshp-cell-dim">{copy.loadFailure}: {copy.selectSessionFail}</div> : null}
          </div>
        ) : null}
        <div className="dshp-field-row">
          <div className="dshp-field" style={{ flex: 1, minWidth: 160 }}>
            <label className="dshp-field-label">{copy.target}</label>
            <select className="dshp-input dshp-grow" value={form.targetMode ?? "resume"}
              disabled={fixedSession !== undefined && editing !== true}
              onChange={(e) => setForm({ ...form, targetMode: e.target.value as PanelCreateForm["targetMode"] })}>
              <option value="resume">{TARGET_LABELS.resume}（{copy.targetSession}）</option>
              <option value="fork">{TARGET_LABELS.fork}</option>
              <option value="new">{TARGET_LABELS.new}</option>
            </select>
            {form.targetMode === "new" ? <div className="dshp-cell-dim">{copy.newSessionHint}</div> : null}
          </div>
          {form.targetMode === "fork" ? (
            <div className="dshp-field" style={{ flex: 1, minWidth: 200 }}>
              <label className="dshp-field-label">{copy.forkSourceSession}</label>
              {fixedSession !== undefined ? (
                <div className="dshp-cell-mono dshp-cell-dim">{fmtSession(fixedSession)}</div>
              ) : (
                <select className="dshp-input dshp-grow" value={form.targetSessionId ?? ""}
                  onChange={(e) => setForm({ ...form, targetSessionId: e.target.value })}>
                  <option value="">{copy.selectSession}</option>
                  {(sessions ?? []).map((session) => (
                    <option key={session.id} value={session.id}>{fmtSession(session.id, session.title)}</option>
                  ))}
                </select>
              )}
            </div>
          ) : form.targetMode === "resume" && fixedSession !== undefined ? (
            <div className="dshp-field" style={{ flex: 1, minWidth: 200 }}>
              <label className="dshp-field-label">{copy.targetSession}</label>
              <div className="dshp-cell-mono dshp-cell-dim">{fmtSession(fixedSession)}</div>
            </div>
          ) : null}
        </div>
        <div className="dshp-btn-row">
          <button className="dshp-btn dshp-btn-primary" disabled={busy || !canSubmit} onClick={onSubmit}>{editing === true ? copy.save : copy.create}</button>
          <button className="dshp-btn" onClick={() => setShowForm(false)}>{copy.cancel}</button>
        </div>
      </div>
    </div>
  );
}

/** Default create-form state (every 1h, user-requested, resume on the creator). */
export function formFromSnapshot(_snapshot: unknown): PanelCreateForm {
  return { prompt: "", kind: "every", everySeconds: 3600, respectQuietHours: false, targetMode: "resume" };
}

/** Build the edit-form state from an alarm row (v2 fields → form fields). */
export function formFromAlarm(alarm: AlarmRow): PanelCreateForm {
  const next: PanelCreateForm = {
    prompt: alarm.prompt,
    kind: alarm.type === "every" ? "every" : alarm.type === "cron" ? "cron" : "once",
    respectQuietHours: alarm.respectQuietHours,
    targetMode: (alarm.targetMode === "fork" || alarm.targetMode === "new" ? alarm.targetMode : "resume") as PanelCreateForm["targetMode"],
    ...(alarm.targetMode !== "new" && alarm.targetSessionId !== undefined && alarm.targetSessionId !== "" ? { targetSessionId: alarm.targetSessionId } : {})
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

export { createArgsFromForm };
export type { PanelCreateForm };