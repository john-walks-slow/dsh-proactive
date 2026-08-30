/**
 * The settings.section panel: alarms table + create form + recent runs.
 * All data flows over the host panel routes; the settings surface only
 * provides the section seat (props.close) and nothing else.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ProactiveHostTransport } from "./host-api.js";
import { createArgsFromForm, type PanelCreateForm } from "../panel/contract.js";
import { zh, type ProactivePanelCopy } from "./locales.js";

export interface ProactivePanelProps {
  close: () => void;
}

interface AlarmRow {
  id: string;
  mode: string;
  prompt: string;
  wakeReason: string;
  nextDueAt: string;
  state: string;
}

const STATE_LABELS: Record<string, string> = {
  scheduled: "待触发",
  overdue: "已到期",
  "in-flight": "执行中",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
  paused: "已暂停"
}

const MODE_LABELS: Record<string, string> = {
  "one-shot": "单次",
  repeat: "重复"
}

const WAKE_LABELS: Record<string, string> = {
  heartbeat: "心跳",
  alarm: "闹钟"
}

function kindMin(form: { afterSeconds?: number; everySeconds?: number }): string {
  return form.everySeconds !== undefined ? "300" : "1";
}

function fmtInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function ProactivePanel(_props: ProactivePanelProps): React.ReactElement {
  const copy: ProactivePanelCopy = zh;
  const transport = useMemo(() => new ProactiveHostTransport(), []);
  const [snapshot, setSnapshot] = useState<{ server: { now: string; corrupt: boolean }; config: { enabled: boolean; maxDeliveriesPerDay: number; quietHours: { start: string; end: string; timeZone: string }; heartbeatPrompt: string; heartbeatEverySeconds: number }; alarms: AlarmRow[]; runs: Array<{ id: string; firedAt: string; decision: string; budgetDelta: number; reasoningSummary?: string; replySummary?: string }> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<PanelCreateForm>({ prompt: "", afterSeconds: 3600 });

  const reload = useCallback(async () => {
    try {
      setSnapshot(await transport.state());
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [transport]);

  useEffect(() => {
    void reload();
    const unsubscribe = transport.subscribe(() => {
      void reload();
    });
    return unsubscribe;
  }, [reload, transport]);

  const run = useCallback(async (action: Parameters<typeof transport.action>[0]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await transport.action(action));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [busy, transport]);

  const submitCreate = useCallback(async () => {
    await run({ kind: "create", sessionId: "host-panel", args: createArgsFromForm(form) });
    setShowForm(false);
    setForm({ prompt: "", afterSeconds: 3600 });
  }, [run, form]);

  /** Prefill the create form with the settings' heartbeat defaults (wake_reason=heartbeat). */
  const applyHeartbeat = useCallback(() => {
    if (snapshot === null) return;
    setShowForm(true);
    setForm({ prompt: snapshot.config.heartbeatPrompt, everySeconds: snapshot.config.heartbeatEverySeconds, wakeReason: "heartbeat" });
  }, [snapshot]);

  const style = {
    fontFamily: "system-ui, sans-serif",
    fontSize: 13
  } as const;
  const cell: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid #eee", verticalAlign: "top" };
  const head: React.CSSProperties = { textAlign: "left", padding: "4px 8px", borderBottom: "2px solid #ddd" };
  const button: React.CSSProperties = { marginRight: 6, fontSize: 12 };
  const input: React.CSSProperties = { marginRight: 8, padding: "3px 6px" };

  return (
    <div style={style} data-testid="proactive-panel">
      <h2 style={{ marginTop: 0 }}>{copy.title}</h2>
      {error !== null && <div style={{ color: "#b00020", marginBottom: 8 }}>{copy.error}: {error}</div>}
      <div style={{ marginBottom: 12, color: "#555" }}>
        {snapshot !== null && (<span>
          {copy.budget}: {snapshot.config.maxDeliveriesPerDay}/日 · {copy.quietHours}: {snapshot.config.quietHours.start}-{snapshot.config.quietHours.end} ({snapshot.config.quietHours.timeZone}) · 服务器: {new Date(snapshot.server.now).toLocaleString("zh-CN", { hour12: false })}
        </span>)}
      </div>
      <div style={{ marginBottom: 8 }}>
        <button style={button} onClick={() => { void reload(); }} disabled={busy}>{copy.refresh}</button>
        <button style={button} onClick={() => setShowForm((v) => !v)}>{copy.newAlarm}</button>
        <button style={button} onClick={applyHeartbeat} disabled={busy || snapshot === null} title={snapshot?.config.heartbeatPrompt ?? ""}>{copy.heartbeatPreset}</button>
      </div>
      {showForm && (
        <div style={{ border: "1px solid #ddd", padding: 10, marginBottom: 12 }}>
          <div style={{ marginBottom: 6 }}><label>{copy.prompt} <input style={input} value={form.prompt ?? ""} onChange={(e) => setForm({ ...form, prompt: e.target.value })} /></label></div>
          <div style={{ marginBottom: 6 }}>
            <label>{copy.triggerKind}: </label>
            <select value={form.everySeconds !== undefined ? "every" : "after"} onChange={(e) => {
              const kind = e.target.value;
              setForm(kind === "every" ? { ...form, everySeconds: 3600, afterSeconds: undefined } : { ...form, afterSeconds: 3600, everySeconds: undefined });
            }}>
              <option value="after">{copy.afterSeconds}</option>
              <option value="every">{copy.everySeconds}</option>
            </select>
            <input type="number" min={kindMin(form)} style={input} value={form.everySeconds !== undefined ? form.everySeconds : form.afterSeconds ?? 3600} onChange={(e) => {
              const value = Number(e.target.value);
              setForm(form.everySeconds !== undefined ? { ...form, everySeconds: value } : { ...form, afterSeconds: value });
            }} />
          </div>
          <div style={{ marginBottom: 6 }}>
            <label>{copy.wakeReason}: </label>
            <select value={form.wakeReason ?? "alarm"} onChange={(e) => setForm({ ...form, wakeReason: e.target.value })}>
              {Object.entries(WAKE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <button onClick={() => { void submitCreate(); }} disabled={busy || (form.prompt ?? "").trim() === ""}>{copy.create}</button>
        </div>
      )}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr>
          <th style={head}>{copy.prompt}</th>
          <th style={head}>{copy.state}</th>
          <th style={head}>{copy.mode}</th>
          <th style={head}>{copy.nextDue}</th>
          <th style={head}>操作</th>
        </tr></thead>
        <tbody>
          {(snapshot?.alarms ?? []).map((alarm) => (
            <tr key={alarm.id}>
              <td style={cell}>{alarm.prompt}</td>
              <td style={cell}>{STATE_LABELS[alarm.state] ?? alarm.state} · {WAKE_LABELS[alarm.wakeReason] ?? alarm.wakeReason}</td>
              <td style={cell}>{MODE_LABELS[alarm.mode] ?? alarm.mode}</td>
              <td style={cell}>{fmtInstant(alarm.nextDueAt)}</td>
              <td style={cell}>
                {alarm.state === "scheduled" || alarm.state === "overdue" ? <button style={button} onClick={() => { void run({ kind: "toggle", id: alarm.id }); }}>{copy.pause}</button> : null}
                {alarm.state === "paused" ? <button style={button} onClick={() => { void run({ kind: "toggle", id: alarm.id }); }}>{copy.resume}</button> : null}
                {alarm.state === "scheduled" || alarm.state === "overdue" || alarm.state === "paused" ? <button style={button} onClick={() => { if (confirm(copy.confirmCancel)) void run({ kind: "cancel", id: alarm.id }); }}>{copy.cancel}</button> : null}
                {alarm.state === "scheduled" || alarm.state === "overdue" || alarm.state === "paused" ? <button style={button} onClick={() => { void run({ kind: "fire", id: alarm.id }); }}>{copy.fire}</button> : null}
              </td>
            </tr>
          ))}
          {(snapshot?.alarms ?? []).length === 0 && snapshot !== null ? <tr><td style={cell} colSpan={5}>{copy.emptyAlarms}</td></tr> : null}
        </tbody>
      </table>
      <h3 style={{ marginBottom: 4 }}>{copy.runs}</h3>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr>
          <th style={head}>时间</th>
          <th style={head}>决策</th>
          <th style={head}>预算增量</th>
          <th style={head}>摘要（思考 / 回复）</th>
        </tr></thead>
        <tbody>
          {(snapshot?.runs ?? []).slice(-8).reverse().map((run) => {
            const summaryParts = [
              ...(run.reasoningSummary !== undefined && run.reasoningSummary !== "" ? ["思考：" + run.reasoningSummary] : []),
              ...(run.replySummary !== undefined && run.replySummary !== "" ? ["回复：" + run.replySummary] : [])
            ];
            const summaryText = summaryParts.join(" ｜ ");
            return (
              <tr key={run.id}>
                <td style={cell}>{fmtInstant(run.firedAt)}</td>
                <td style={cell}>{run.decision}</td>
                <td style={cell}>{run.budgetDelta}</td>
                <td style={{ ...cell, maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={summaryText}>{summaryText || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}