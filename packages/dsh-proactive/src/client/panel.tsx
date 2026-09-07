/**
 * The settings.section panel — the host-wide Proactive view. Shows the
 * editable global config, the single alarm table (all sessions, filterable /
 * sortable / editable / deletable / per-alarm history), and the create form
 * with an explicit target-session picker. Session-scoped management lives in
 * the conversation-page tab (session-panel.tsx).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ProactiveHostTransport, type PanelSnapshotDto } from "./host-api.js";
import { createArgsFromForm, type PanelCreateForm } from "../panel/contract.js";
import { AlarmTable, CreateForm, HOST_PANEL_SESSION, formFromSnapshot, fmtSession, type AlarmRow, type RunRow } from "./sections.js";
import { useProactiveLocale } from "./use-locale.js";
import { injectProactiveStyles } from "./style.js";

export interface ProactivePanelProps {
  close: () => void;
}

interface ConfigDraft {
  enabled: boolean;
  maxDeliveriesPerDay: string;
  quietStart: string;
  quietEnd: string;
  quietTimeZone: string;
  heartbeatPrompt: string;
}

function configDraftFrom(snapshot: PanelSnapshotDto): ConfigDraft {
  return {
    enabled: snapshot.config.enabled,
    maxDeliveriesPerDay: String(snapshot.config.maxDeliveriesPerDay),
    quietStart: snapshot.config.quietHours.start,
    quietEnd: snapshot.config.quietHours.end,
    quietTimeZone: snapshot.config.quietHours.timeZone,
    heartbeatPrompt: snapshot.config.heartbeatPrompt
  };
}

export function ProactivePanel(_props: ProactivePanelProps): React.ReactElement {
  const copy = useProactiveLocale();
  const transport = useMemo(() => new ProactiveHostTransport(), []);
  const [snapshot, setSnapshot] = useState<PanelSnapshotDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PanelCreateForm>({ prompt: "", afterSeconds: 3600 });
  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    injectProactiveStyles();
  }, []);

  const reload = useCallback(async () => {
    try {
      const next = await transport.stateEnriched();
      setSnapshot(next);
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
      setSnapshot(await transport.actionEnriched(action));
      setShowForm(false);
      setEditingId(null);
      setForm({ prompt: "", afterSeconds: 3600 });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [busy, transport]);

  const submitCreate = useCallback(async () => {
    await run({ kind: "create", sessionId: form.sessionId ?? "", args: createArgsFromForm(form) });
  }, [run, form]);

  const submitEdit = useCallback(async () => {
    if (editingId === null) return;
    await run({ kind: "edit", id: editingId, args: createArgsFromForm(form) });
  }, [run, editingId, form]);

  const submitConfig = useCallback(async () => {
    if (draft === null) return;
    await run({
      kind: "update_config",
      patch: {
        enabled: draft.enabled,
        max_deliveries_per_day: Number(draft.maxDeliveriesPerDay),
        quiet_hours: { start: draft.quietStart, end: draft.quietEnd, time_zone: draft.quietTimeZone },
        heartbeat_prompt: draft.heartbeatPrompt
      }
    });
  }, [run, draft]);

  const openCreate = useCallback(() => {
    setEditingId(null);
    const alarms = snapshot?.alarms ?? [];
    const firstSession = alarms.length > 0 ? alarms[0].sessionId : HOST_PANEL_SESSION;
    setForm({ ...formFromSnapshot(snapshot), sessionId: firstSession });
    setShowForm(true);
  }, [snapshot]);

  const openEdit = useCallback((id: string) => {
    const alarm = snapshot?.alarms.find((a) => a.id === id);
    if (alarm === undefined) return;
    const next: PanelCreateForm = {
      prompt: alarm.prompt,
      wakeReason: alarm.wakeReason,
      sessionId: alarm.sessionId
    };
    if (alarm.mode === "repeat" && alarm.everySeconds !== undefined) {
      next.everySeconds = alarm.everySeconds;
      next.jitter = alarm.jitter ?? 0;
    } else if (alarm.at !== undefined) {
      // One-shot at instant → offer "from now" so the edit form stays
      // one dialect; the row keeps showing its planned instant until saved.
      const remaining = Math.max(1, Math.floor((new Date(alarm.at).getTime() - Date.now()) / 1000));
      next.afterSeconds = remaining;
    } else {
      next.afterSeconds = 3600;
    }
    setEditingId(id);
    setForm(next);
    setShowForm(true);
  }, [snapshot]);

  const copyId = useCallback(async (sessionId: string) => {
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopiedId(sessionId);
      setTimeout(() => setCopiedId(null), 1200);
    } catch {
      setError(copy.error);
    }
  }, [copy]);

  const alarms: AlarmRow[] = snapshot?.alarms ?? [];
  const runsByAlarm = useMemo(() => {
    const map = new Map<string, RunRow[]>();
    for (const run of snapshot?.runs ?? []) {
      const bucket = map.get(run.alarmId) ?? [];
      bucket.push(run);
      map.set(run.alarmId, bucket);
    }
    return map;
  }, [snapshot]);

  // Distinct sessions seen across alarms (for the target-session picker).
  const sessionOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const alarm of alarms) {
      if (!seen.has(alarm.sessionId)) seen.set(alarm.sessionId, alarm.sessionTitle ?? "");
    }
    return [...seen.entries()].map(([id, title]) => ({ id, title }));
  }, [alarms]);

  return (
    <div className="dshp-panel" data-testid="proactive-panel">
      <div className="dshp-head">
        <div>
          <h2 className="dshp-title">{copy.globalTitle}</h2>
          <div className="dshp-sub">{copy.globalView} · {alarms.length} {copy.alarms}</div>
        </div>
        <div className="dshp-btn-row">
          <button className="dshp-btn" onClick={() => { void reload(); }} disabled={busy}>{copy.refresh}</button>
          <button className="dshp-btn dshp-btn-primary" onClick={openCreate} disabled={snapshot === null}>{copy.newAlarm}</button>
        </div>
      </div>

      {error !== null && <div className="dshp-error">{copy.error}: {error}</div>}

      {snapshot !== null ? (
        <div className="dshp-card">
          <div className="dshp-card-head">
            <span>{copy.configSectionTitle}</span>
            <span className="dshp-cell-dim">{copy.configSectionDesc}</span>
          </div>
          <div className="dshp-card-body">
            <div className="dshp-switch-row">
              <div>
                <div className="dshp-switch-label">{copy.enabledToggle}</div>
                <div className="dshp-switch-desc">{copy.budget}: {snapshot.config.maxDeliveriesPerDay}/日 · {copy.quietHours}: {snapshot.config.quietHours.start}-{snapshot.config.quietHours.end}</div>
              </div>
              <label className="dshp-switch">
                <input type="checkbox" checked={(draft ?? configDraftFrom(snapshot)).enabled} disabled={busy}
                  onChange={(e) => setDraft({ ...(draft ?? configDraftFrom(snapshot)), enabled: e.target.checked })} />
                <span className="dshp-switch-track" />
                <span className="dshp-switch-thumb" />
              </label>
            </div>
            <div className="dshp-field-row">
              <div className="dshp-field" style={{ flex: 1, minWidth: 120 }}>
                <label className="dshp-field-label">{copy.budget}</label>
                <input className="dshp-input" type="number" min={0} max={50} value={(draft ?? configDraftFrom(snapshot)).maxDeliveriesPerDay} disabled={busy}
                  onChange={(e) => setDraft({ ...(draft ?? configDraftFrom(snapshot)), maxDeliveriesPerDay: e.target.value })} />
              </div>
              <div className="dshp-field" style={{ flex: 1, minWidth: 100 }}>
                <label className="dshp-field-label">{copy.quietHours} 开始</label>
                <input className="dshp-input" type="time" value={(draft ?? configDraftFrom(snapshot)).quietStart} disabled={busy}
                  onChange={(e) => setDraft({ ...(draft ?? configDraftFrom(snapshot)), quietStart: e.target.value })} />
              </div>
              <div className="dshp-field" style={{ flex: 1, minWidth: 100 }}>
                <label className="dshp-field-label">{copy.quietHours} 结束</label>
                <input className="dshp-input" type="time" value={(draft ?? configDraftFrom(snapshot)).quietEnd} disabled={busy}
                  onChange={(e) => setDraft({ ...(draft ?? configDraftFrom(snapshot)), quietEnd: e.target.value })} />
              </div>
              <div className="dshp-field" style={{ flex: 1, minWidth: 140 }}>
                <label className="dshp-field-label">时区</label>
                <input className="dshp-input" value={(draft ?? configDraftFrom(snapshot)).quietTimeZone} disabled={busy}
                  onChange={(e) => setDraft({ ...(draft ?? configDraftFrom(snapshot)), quietTimeZone: e.target.value })} />
              </div>
            </div>
            <div className="dshp-field">
              <label className="dshp-field-label">心跳唤醒指令（默认值）</label>
              <textarea className="dshp-input dshp-grow" rows={2} value={(draft ?? configDraftFrom(snapshot)).heartbeatPrompt} disabled={busy}
                onChange={(e) => setDraft({ ...(draft ?? configDraftFrom(snapshot)), heartbeatPrompt: e.target.value })} />
            </div>
            <div className="dshp-btn-row">
              <button className="dshp-btn dshp-btn-primary" disabled={busy} onClick={() => { void submitConfig(); }}>{copy.saveConfig}</button>
            </div>
          </div>
        </div>
      ) : null}

      {showForm ? (
        <CreateForm form={form} setForm={setForm} showForm={showForm} setShowForm={setShowForm} busy={busy}
          copy={copy} sessions={sessionOptions} editing={editingId !== null}
          onSubmit={() => { void (editingId !== null ? submitEdit() : submitCreate()); }} />
      ) : null}

      <div className="dshp-card">
        <div className="dshp-card-head">
          <span>{copy.alarms}</span>
          <span className="dshp-cell-dim">{snapshot?.server.corrupt === true ? "（存储损坏，只读）" : ""}</span>
        </div>
        <div className="dshp-card-body" style={{ padding: 0 }}>
          <AlarmTable alarms={alarms} runsByAlarm={runsByAlarm} showSession busy={busy} copy={copy}
            onToggle={(id) => { void run({ kind: "toggle", id }); }}
            onCancel={(id) => { if (confirm(copy.confirmCancel)) void run({ kind: "cancel", id }); }}
            onFire={(id) => { void run({ kind: "fire", id }); }}
            onEdit={(id) => openEdit(id)}
            onCopyId={(sessionId) => { void copyId(sessionId); }} />
          {copiedId !== null ? (
            <div className="dshp-toast">{copy.copied}: {copiedId === HOST_PANEL_SESSION ? fmtSession(copiedId) : copiedId}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}