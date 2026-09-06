/**
 * Shared building blocks for the two Proactive surfaces (settings section =
 * host-wide view, conversation tab = session view). Pure presentational
 * components over the wire DTOs; data flow stays in the owning panels.
 */

import { Fragment, useMemo, useState, type ReactElement } from "react";
import { createArgsFromForm, type PanelCreateForm } from "../panel/contract.js";
import type { ProactivePanelCopy } from "./locales.js";

/** Row shape the alarms table renders (a subset of the wire AlarmView). */
export interface AlarmRow {
  id: string;
  sessionId: string;
  sessionTitle?: string;
  mode: string;
  prompt: string;
  wakeReason: string;
  nextDueAt: string;
  createdAt: string;
  state: string;
  jitter?: number;
  everySeconds?: number;
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

export const MODE_LABELS: Record<string, string> = {
  "one-shot": "单次",
  repeat: "重复"
};

export const WAKE_LABELS: Record<string, string> = {
  heartbeat: "心跳",
  alarm: "闹钟"
};

export function kindMin(form: { afterSeconds?: number; everySeconds?: number }): string {
  return form.everySeconds !== undefined ? "300" : "1";
}

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
  const [modeFilter, setModeFilter] = useState<string>("");
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
        (modeFilter === "" || alarm.mode === modeFilter) &&
        (sessionFilter === "" || alarm.sessionId === sessionFilter)
    );
    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === "created") return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
      if (sortKey === "prompt") return a.prompt.localeCompare(b.prompt);
      return a.nextDueAt < b.nextDueAt ? -1 : a.nextDueAt > b.nextDueAt ? 1 : 0;
    });
    return sorted;
  }, [alarms, stateFilter, modeFilter, sessionFilter, sortKey]);

  return (
    <div className="dshp-table-wrap">
      <div className="dshp-toolbar">
        <select className="dshp-input" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
          <option value="">{copy.filterAllStates}</option>
          {stateOptions.map((value) => <option key={value} value={value}>{STATE_LABELS[value] ?? value}</option>)}
        </select>
        <select className="dshp-input" value={modeFilter} onChange={(e) => setModeFilter(e.target.value)}>
          <option value="">{copy.filterAllModes}</option>
          {Object.entries(MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
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
            <th>{copy.mode}</th>
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
                    <div className="dshp-cell-dim">{STATE_LABELS[alarm.state] ?? alarm.state} · {WAKE_LABELS[alarm.wakeReason] ?? alarm.wakeReason}</div>
                  </td>
                  <td><StatePill state={alarm.state} /></td>
                  <td>
                    <span className="dshp-pill dshp-pill-plain">{MODE_LABELS[alarm.mode] ?? alarm.mode}</span>
                    {alarm.jitter !== undefined ? (
                      <span className="dshp-pill dshp-pill-accent" style={{ marginLeft: 4 }}>±{Math.round(alarm.jitter * 100)}%</span>
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
                    <td colSpan={showSession === true ? 7 : 6}>
                      <RunsTable runs={runs} copy={copy} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
          {visible.length === 0 ? (
            <tr><td colSpan={showSession === true ? 7 : 6}><div className="dshp-empty">{copy.emptyAlarms}</div></td></tr>
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
  /** Host-wide view: pick the owning session (the conversation tab pins its own). */
  sessions?: Array<{ id: string; title?: string }>;
  /** Editing an existing alarm instead of creating a new one. */
  editing?: boolean;
}

export function CreateForm({ form, setForm, showForm, setShowForm, busy, copy, onSubmit, sessions, editing }: CreateFormProps): ReactElement {
  if (!showForm) return <Fragment />;
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
            <label className="dshp-field-label">{copy.triggerKind}</label>
            <div className="dshp-field-row">
              <select className="dshp-input" value={form.everySeconds !== undefined ? "every" : "after"} onChange={(e) => {
                const kind = e.target.value;
                setForm(kind === "every" ? { ...form, everySeconds: form.everySeconds ?? 3600, afterSeconds: undefined, jitter: form.jitter ?? 0 } : { ...form, afterSeconds: form.afterSeconds ?? 3600, everySeconds: undefined, jitter: undefined });
              }}>
                <option value="after">{copy.afterSeconds}</option>
                <option value="every">{copy.everySeconds}</option>
              </select>
              <input className="dshp-input" type="number" min={kindMin(form)} value={form.everySeconds !== undefined ? form.everySeconds : form.afterSeconds ?? 3600} onChange={(e) => {
                const value = Number(e.target.value);
                setForm(form.everySeconds !== undefined ? { ...form, everySeconds: value } : { ...form, afterSeconds: value });
              }} />
            </div>
          </div>
          {form.everySeconds !== undefined ? (
            <div className="dshp-field" style={{ flex: 1, minWidth: 220 }}>
              <label className="dshp-field-label">{copy.jitter}</label>
              <input className="dshp-input" type="number" min={0} max={1} step={0.05} value={form.jitter ?? 0} onChange={(e) => {
                const value = Number(e.target.value);
                setForm({ ...form, jitter: Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0 });
              }} />
            </div>
          ) : null}
          <div className="dshp-field">
            <label className="dshp-field-label">{copy.wakeReason}</label>
            <select className="dshp-input" value={form.wakeReason ?? "alarm"} onChange={(e) => setForm({ ...form, wakeReason: e.target.value })}>
              {Object.entries(WAKE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
        </div>
        {sessions !== undefined ? (
          <div className="dshp-field">
            <label className="dshp-field-label">{copy.targetSession}</label>
            <select className="dshp-input dshp-grow" value={form.sessionId ?? ""} onChange={(e) => setForm({ ...form, sessionId: e.target.value })}>
              <option value="">{copy.loadFailure}…</option>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>{fmtSession(session.id, session.title)}</option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="dshp-btn-row">
          <button className="dshp-btn dshp-btn-primary" disabled={busy || (form.prompt ?? "").trim() === ""} onClick={onSubmit}>{editing === true ? copy.save : copy.create}</button>
          <button className="dshp-btn" onClick={() => setShowForm(false)}>{copy.cancel}</button>
        </div>
      </div>
    </div>
  );
}

/** Build the shared create-form args with the panel defaults from a snapshot. */
export function formFromSnapshot(snapshot: { config: { heartbeatPrompt: string } } | null): PanelCreateForm {
  if (snapshot === null) return { prompt: "", afterSeconds: 3600 };
  return { prompt: snapshot.config.heartbeatPrompt, afterSeconds: 3600 };
}

export { createArgsFromForm };
export type { PanelCreateForm };