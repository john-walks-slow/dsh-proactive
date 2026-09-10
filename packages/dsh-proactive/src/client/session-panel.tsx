/**
 * The conversation-page Proactive tab — the session view of dsh-proactive.
 * Mounted as one entry of the `conversation.view` slot (id "proactive"),
 * so the framework hands it the session-scoped standard kit: `sessionId`,
 * `useSession`, `useProjection`. All data is scoped to that session via the
 * `?session=` routes; mutations carry the ownership guard on the host side.
 *
 * v3 (260909 release polish): the create/edit form is the SAME dialect as
 * the settings page — target mode (resume/fork/new) plus a session-id input
 * defaulting to THIS session, so a wake can also be aimed elsewhere. The
 * owner stays pinned to this session (the host scope rule).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ConvViewProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { ProactiveHostTransport, type PanelSnapshotDto, type WorkspaceInfo } from "./host-api.js";
import { EMPTY_SOURCE, bindSource, type WorkspacesSource } from "./workspaces-source.js";
import { createArgsFromForm, type PanelCreateForm } from "../panel/contract.js";
import {
  AlarmTable, CreateForm, LoadingBlock,
  defaultPromptOf, formFromAlarm, newAlarmForm,
  type AlarmRow, type RunRow
} from "./sections.js";
import { useProactiveLocale } from "./use-locale.js";
import { injectProactiveStyles } from "./style.js";

export function ProactiveSessionPanel(props: ConvViewProps & { workspaces?: WorkspacesSource }): React.ReactElement {
  const copy = useProactiveLocale();
  const sessionId = String(props.sessionId);
  const transport = useMemo(() => new ProactiveHostTransport(), []);
  const [snapshot, setSnapshot] = useState<PanelSnapshotDto | null>(null);
  const [knownSessions, setKnownSessions] = useState<ReadonlyMap<string, string>>(new Map());
  const [sessionCwds, setSessionCwds] = useState<ReadonlyMap<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PanelCreateForm>(() => newAlarmForm("", sessionId));
  // Refs: a session switch must not let the earlier session's in-flight
  // response overwrite the current session's snapshot.
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  // Workspace rows from the live client service (same store the sidebar
  // reads; subscribe + cached snapshot, no HTTP round trip).
  const workspacesBound = useMemo(() => bindSource(props.workspaces ?? EMPTY_SOURCE), [props.workspaces]);
  const workspacesSnapshot = useSyncExternalStore(workspacesBound.subscribe, workspacesBound.getSnapshot);
  const knownWorkspaces = useMemo<readonly WorkspaceInfo[]>(() => workspacesSnapshot.items.map((item) => ({
    id: item.workspaceId,
    title: item.title !== "" ? item.title : item.path,
    path: item.path
  })), [workspacesSnapshot]);

  useEffect(() => {
    injectProactiveStyles();
  }, []);

  const reload = useCallback(async () => {
    const requested = sessionRef.current;
    try {
      const next = await transport.stateForHost(requested);
      if (sessionRef.current !== requested) return; // stale: a newer session is now active
      setSnapshot(next.snapshot);
      setKnownSessions(new Map(next.sessions.map((session) => [session.id, session.title])));
      setSessionCwds(new Map(next.sessions.filter((session) => session.cwd !== undefined).map((session) => [session.id, session.cwd as string])));
      setError(null);
    } catch (reason) {
      if (sessionRef.current !== requested) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [transport]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    setForm(newAlarmForm("", sessionId));
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
      const next = await transport.stateForHost(requested);
      if (sessionRef.current !== requested) return; // stale: a newer session is now active
      setSnapshot(next.snapshot);
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
      const next = await transport.actionForHost(action, requested);
      if (sessionRef.current !== requested) return; // stale action response from a previous session
      setSnapshot(next.snapshot);
      setKnownSessions(new Map(next.sessions.map((session) => [session.id, session.title])));
      setSessionCwds(new Map(next.sessions.filter((session) => session.cwd !== undefined).map((session) => [session.id, session.cwd as string])));
      setShowForm(false);
      setEditingId(null);
      setForm(newAlarmForm(defaultPromptOf(next.snapshot), sessionRef.current));
    } catch (reason) {
      if (sessionRef.current !== requested) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [busy, transport, refresh]);

  /** Workspace picker preselect: the workspace owning THIS session. */
  const defaultWorkspaceId = useMemo(() => {
    if (knownWorkspaces.length === 0) return undefined;
    const cwd = sessionCwds.get(sessionId);
    if (cwd === undefined) return undefined;
    return knownWorkspaces.find((workspace) => workspace.path === cwd)?.id;
  }, [sessionId, knownWorkspaces, sessionCwds]);

  const submitCreate = useCallback(async () => {
    await run({ kind: "create", sessionId, args: createArgsFromForm(form) });
  }, [run, form, sessionId]);

  const submitEdit = useCallback(async () => {
    if (editingId === null) return;
    await run({ kind: "edit", id: editingId, args: createArgsFromForm(form) });
  }, [run, editingId, form]);

  const openCreate = useCallback(() => {
    setEditingId(null);
    setForm(newAlarmForm(defaultPromptOf(snapshot), sessionId));
    setShowForm(true);
  }, [snapshot, sessionId]);

  const openEdit = useCallback((id: string) => {
    const alarm = snapshot?.alarms.find((a) => a.id === id);
    if (alarm === undefined) return;
    setEditingId(id);
    setForm(formFromAlarm(alarm));
    setShowForm(true);
  }, [snapshot]);

  /** Workspace-target display titles for the table, from the live source. */
  const workspaceTitles = useMemo(() => new Map(knownWorkspaces.map((workspace) => [workspace.id, workspace.title])), [knownWorkspaces]);
  const alarms: AlarmRow[] = useMemo(() => {
    const rows = snapshot?.alarms ?? [];
    if (workspaceTitles.size === 0) return rows;
    return rows.map((alarm) => alarm.targetWorkspaceId !== undefined && (alarm.targetWorkspaceTitle === undefined || alarm.targetWorkspaceTitle === "")
      ? { ...alarm, targetWorkspaceTitle: workspaceTitles.get(alarm.targetWorkspaceId) ?? "" }
      : alarm);
  }, [snapshot, workspaceTitles]);
  const loading = snapshot === null && error === null;
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
          <button className="dshp-btn" onClick={() => { void reload(); }} disabled={busy || loading}>{copy.refresh}</button>
          <button className="dshp-btn dshp-btn-primary" onClick={openCreate} disabled={snapshot === null}>{copy.newAlarm}</button>
        </div>
      </div>

      {error !== null && <div className="dshp-error">{copy.error}: {error}</div>}

      {showForm ? (
        <CreateForm form={form} setForm={setForm} showForm={showForm} setShowForm={setShowForm} busy={busy}
          copy={copy} editing={editingId !== null} knownSessions={knownSessions}
          knownWorkspaces={knownWorkspaces} defaultWorkspaceId={defaultWorkspaceId}
          onSubmit={() => { void (editingId !== null ? submitEdit() : submitCreate()); }} />
      ) : null}

      <div className="dshp-card">
        <div className="dshp-card-head">
          <span>{copy.alarmsTitle}</span>
          <span className="dshp-cell-dim">{snapshot?.server.corrupt === true ? copy.storageCorrupt : ""}</span>
        </div>
        <div className="dshp-card-body" style={{ padding: 0 }}>
          {loading ? (
            <LoadingBlock copy={copy} />
          ) : (
            <AlarmTable alarms={alarms} runsByAlarm={runsByAlarm} busy={busy} copy={copy}
              onToggle={(id) => { void run({ kind: "toggle", id }); }}
              onCancel={(id) => { if (confirm(copy.confirmCancel)) void run({ kind: "cancel", id }); }}
              onFire={(id) => { void run({ kind: "fire", id }); }}
              onEdit={(id) => openEdit(id)}
              onCopyId={() => undefined} />
          )}
        </div>
      </div>
    </div>
  );
}
