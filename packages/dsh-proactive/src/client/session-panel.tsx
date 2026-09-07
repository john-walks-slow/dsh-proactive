/**
 * The conversation-page Proactive tab — the session view of dsh-proactive.
 * Mounted as one entry of the `conversation.view` slot (id "proactive"),
 * so the framework hands it the session-scoped standard kit: `sessionId`,
 * `useSession`, `useProjection`. All data is scoped to that session via the
 * `?session=` routes; mutations carry the ownership guard on the host side.
 *
 * v2: the create/edit form defaults to resume-on-this-session and pins the
 * fork source / resume target to the current session (`fixedSession`); "new"
 * wakes in a fresh empty session.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConvViewProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { ProactiveHostTransport, type PanelSnapshotDto } from "./host-api.js";
import { createArgsFromForm, type PanelCreateForm } from "../panel/contract.js";
import { AlarmTable, CreateForm, formFromAlarm, type AlarmRow, type RunRow } from "./sections.js";
import { useProactiveLocale } from "./use-locale.js";
import { injectProactiveStyles } from "./style.js";

const EMPTY_FORM: PanelCreateForm = { prompt: "", kind: "every", everySeconds: 3600, respectQuietHours: false, targetMode: "resume" };

export function ProactiveSessionPanel(props: ConvViewProps): React.ReactElement {
  const copy = useProactiveLocale();
  const sessionId = String(props.sessionId);
  const transport = useMemo(() => new ProactiveHostTransport(), []);
  const [snapshot, setSnapshot] = useState<PanelSnapshotDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PanelCreateForm>(EMPTY_FORM);
  // Refs: a session switch must not let the earlier session's in-flight
  // response overwrite the current session's snapshot.
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  useEffect(() => {
    injectProactiveStyles();
  }, []);

  const reload = useCallback(async () => {
    const requested = sessionRef.current;
    try {
      const next = await transport.stateEnriched(requested);
      if (sessionRef.current !== requested) return; // stale: a newer session is now active
      setSnapshot(next);
      setError(null);
    } catch (reason) {
      if (sessionRef.current !== requested) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [transport]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    void reload();
    const unsubscribe = transport.subscribe(() => {
      void reload();
    });
    return unsubscribe;
  }, [reload, transport, sessionId]);

  /**
   * Silent data re-pull: refresh the table without touching the error banner.
   * After a failed action a stale row (alarm vanished elsewhere, `not_found`)
   * must leave the table instead of lingering next to the error message.
   */
  const refresh = useCallback(async () => {
    const requested = sessionRef.current;
    try {
      const next = await transport.stateEnriched(requested);
      if (sessionRef.current !== requested) return; // stale: a newer session is now active
      setSnapshot(next);
    } catch {
      /* keep the current snapshot and the error banner */
    }
  }, [transport]);

  const run = useCallback(async (action: Parameters<typeof transport.action>[0]) => {
    if (busy) return;
    const requested = sessionRef.current;
    setBusy(true);
    setError(null);
    try {
      const next = await transport.actionEnriched(action, requested);
      if (sessionRef.current !== requested) return; // stale action response from a previous session
      setSnapshot(next);
      setShowForm(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
    } catch (reason) {
      if (sessionRef.current !== requested) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [busy, transport, refresh]);

  const submitCreate = useCallback(async () => {
    await run({ kind: "create", sessionId, args: createArgsFromForm(form) });
  }, [run, form, sessionId]);

  const submitEdit = useCallback(async () => {
    if (editingId === null) return;
    await run({ kind: "edit", id: editingId, args: createArgsFromForm(form) });
  }, [run, editingId, form]);

  const openCreate = useCallback(() => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setShowForm(true);
  }, []);

  const openEdit = useCallback((id: string) => {
    const alarm = snapshot?.alarms.find((a) => a.id === id);
    if (alarm === undefined) return;
    setEditingId(id);
    setForm(formFromAlarm(alarm));
    setShowForm(true);
  }, [snapshot]);

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

  return (
    <div className="dshp-panel dshp-panel-session" data-testid="proactive-session-panel">
      <div className="dshp-head">
        <div>
          <h2 className="dshp-title">{copy.sessionTitle}</h2>
          <div className="dshp-sub">{copy.sessionSubtitle}</div>
        </div>
        <div className="dshp-btn-row">
          <button className="dshp-btn" onClick={() => { void reload(); }} disabled={busy}>{copy.refresh}</button>
          <button className="dshp-btn dshp-btn-primary" onClick={openCreate}>{copy.newAlarm}</button>
        </div>
      </div>

      {error !== null && <div className="dshp-error">{copy.error}: {error}</div>}

      {showForm ? (
        <CreateForm form={form} setForm={setForm} showForm={showForm} setShowForm={setShowForm} busy={busy}
          copy={copy} editing={editingId !== null} fixedSession={sessionId}
          onSubmit={() => { void (editingId !== null ? submitEdit() : submitCreate()); }} />
      ) : null}

      <div className="dshp-card">
        <div className="dshp-card-head">
          <span>{copy.alarms}</span>
          <span className="dshp-cell-dim">{snapshot?.server.corrupt === true ? "（存储损坏，只读）" : ""}</span>
        </div>
        <div className="dshp-card-body" style={{ padding: 0 }}>
          <AlarmTable alarms={alarms} runsByAlarm={runsByAlarm} busy={busy} copy={copy}
            onToggle={(id) => { void run({ kind: "toggle", id }); }}
            onCancel={(id) => { if (confirm(copy.confirmCancel)) void run({ kind: "cancel", id }); }}
            onFire={(id) => { void run({ kind: "fire", id }); }}
            onEdit={(id) => openEdit(id)}
            onCopyId={() => undefined} />
        </div>
      </div>
    </div>
  );
}