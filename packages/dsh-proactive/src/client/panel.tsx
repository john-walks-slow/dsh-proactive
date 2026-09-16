/**
 * The settings.section panel — the host-wide Proactive view. Shows the
 * editable global config (including the default wake-up instruction the
 * create form pre-fills), the single alarm table (all sessions, filterable /
 * sortable / editable / deletable / per-alarm history), and the create form.
 * Session-scoped management lives in the conversation-page tab
 * (session-panel.tsx); both surfaces share ONE create-form dialect.
 *
 * The owner of a created alarm is derived, never picked: resume/fork owns the
 * target session, "new" falls back to the GUI's current session (or the
 * host-panel pseudo session when none is selected).
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ProactiveHostTransport, type PanelSnapshotDto, type WorkspaceInfo } from "./host-api.js";
import { EMPTY_SOURCE, bindSource, type WorkspacesSource } from "./workspaces-source.js";
import { createArgsFromForm, type PanelCreateForm } from "../panel/contract.js";
import { MAX_PROMPT_LENGTH } from "../domain.js";
import {
  AlarmTable, CreateForm, HOST_PANEL_SESSION, LoadingBlock,
  defaultPromptOf, fmtSession, formFromAlarm, newAlarmForm,
  type AlarmRow, type RunRow
} from "./sections.js";
import { useProactiveLocale } from "./use-locale.js";
import { injectProactiveStyles } from "./style.js";

export interface ProactivePanelProps {
  close: () => void;
  /**
   * Client-side workspace store (`ctx.get("workspaces")?.list`). Optional: a
   * GUI without the workspace controller still mounts the panel — the
   * workspace picker then disables with a hint. Live subscription, not a
   * per-pull fetch: there is no workspace/list RPC.
   */
  workspaces?: WorkspacesSource;
  /**
   * Framework global-standard hook (every slot component receives it): reads
   * the GUI's current session selection, used as the create form's default
   * target and as the owner fallback for "new"-mode alarms. Optional so the
   * component still mounts under older hosts / unit tests.
   */
  useSessions?: <S>(selector: (state: { current?: string }) => S, equals?: (a: S, b: S) => boolean) => S;
}

interface ConfigDraft {
  enabled: boolean;
  maxDeliveriesPerDay: string;
  quietStart: string;
  quietEnd: string;
  defaultPrompt: string;
  silentWakeCompaction: boolean;
}

function configDraftFrom(snapshot: PanelSnapshotDto): ConfigDraft {
  return {
    enabled: snapshot.config.enabled,
    maxDeliveriesPerDay: String(snapshot.config.maxDeliveriesPerDay),
    quietStart: snapshot.config.quietHours.start,
    quietEnd: snapshot.config.quietHours.end,
    defaultPrompt: snapshot.config.defaultPrompt ?? "",
    silentWakeCompaction: snapshot.config.silentWakeCompaction ?? false
  };
}

export function ProactivePanel(props: ProactivePanelProps): React.ReactElement {
  const copy = useProactiveLocale();
  const transport = useMemo(() => new ProactiveHostTransport(), []);
  const [snapshot, setSnapshot] = useState<PanelSnapshotDto | null>(null);
  const [knownSessions, setKnownSessions] = useState<ReadonlyMap<string, string>>(new Map());
  const [sessionCwds, setSessionCwds] = useState<ReadonlyMap<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PanelCreateForm>(() => newAlarmForm("", ""));
  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Workspace rows straight from the live client service (subscribe + cached
  // snapshot — the same store the sidebar reads; no HTTP round trip).
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

  // The GUI's current session (sidebar selection); stable hook call order —
  // the prop itself is constant for a given mount.
  const currentSession = props.useSessions?.((state) => state.current) ?? "";

  const reload = useCallback(async () => {
    try {
      const next = await transport.stateForHost();
      setSnapshot(next.snapshot);
      setKnownSessions(new Map(next.sessions.map((session) => [session.id, session.title])));
      setSessionCwds(new Map(next.sessions.filter((session) => session.cwd !== undefined).map((session) => [session.id, session.cwd as string])));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [transport]);

  /**
   * Silent data re-pull: refresh the table without touching the error banner.
   * Used after a failed action — a stale row whose alarm vanished (e.g.
   * cancelled elsewhere, `not_found`) must leave the table instead of
   * lingering next to the error message.
   */
  const refresh = useCallback(async () => {
    try {
      const next = await transport.stateForHost();
      setSnapshot(next.snapshot);
    } catch {
      /* keep the current snapshot and the error banner */
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
      const next = await transport.actionForHost(action);
      setSnapshot(next.snapshot);
      setKnownSessions(new Map(next.sessions.map((session) => [session.id, session.title])));
      setSessionCwds(new Map(next.sessions.filter((session) => session.cwd !== undefined).map((session) => [session.id, session.cwd as string])));
      setShowForm(false);
      setEditingId(null);
      setForm(newAlarmForm(defaultPromptOf(next.snapshot), currentSession));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [busy, transport, refresh, currentSession]);

  /**
   * Owner for a settings-page create: the wake target session for
   * resume/fork with a session source; otherwise (new mode, or a
   * workspace/preset source whose destination is resolved at fire time) the
   * GUI's current session, falling back to the host-panel pseudo session.
   */
  const ownerForCreate = useCallback((form_: PanelCreateForm): string => {
    const mode = form_.targetMode ?? "resume";
    if (mode === "new" || (form_.targetSource ?? "session") !== "session") {
      return currentSession !== "" ? currentSession : HOST_PANEL_SESSION;
    }
    return (form_.targetSessionId ?? "").trim();
  }, [currentSession]);

  /** Workspace picker preselect: the workspace owning the GUI's current session. */
  const defaultWorkspaceId = useMemo(() => {
    if (currentSession === "" || knownWorkspaces.length === 0) return undefined;
    const cwd = sessionCwds.get(currentSession);
    if (cwd === undefined) return undefined;
    return knownWorkspaces.find((workspace) => workspace.path === cwd)?.id;
  }, [currentSession, knownWorkspaces, sessionCwds]);

  const submitCreate = useCallback(async () => {
    await run({ kind: "create", sessionId: ownerForCreate(form), args: createArgsFromForm(form) });
  }, [run, form, ownerForCreate]);

  const submitEdit = useCallback(async () => {
    if (editingId === null) return;
    await run({ kind: "edit", id: editingId, args: createArgsFromForm(form) });
  }, [run, editingId, form]);

  const submitConfig = useCallback(async () => {
    if (draft === null || snapshot === null) return;
    await run({
      kind: "update_config",
      patch: {
        enabled: draft.enabled,
        max_deliveries_per_day: Number(draft.maxDeliveriesPerDay),
        quiet_hours: { start: draft.quietStart, end: draft.quietEnd, time_zone: snapshot.config.quietHours.timeZone },
        // Only offered (and sent) when the host advertises the field; an
        // older host would reject the unknown key.
        ...(snapshot.config.defaultPrompt !== undefined ? { default_prompt: draft.defaultPrompt } : {}),
        ...(snapshot.config.silentWakeCompaction !== undefined ? { silent_wake_compaction: draft.silentWakeCompaction } : {})
      }
    });
  }, [run, draft, snapshot]);

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

  const openCreate = useCallback(() => {
    setEditingId(null);
    setForm(newAlarmForm(defaultPromptOf(snapshot), currentSession));
    setShowForm(true);
  }, [snapshot, currentSession]);

  const openEdit = useCallback((id: string) => {
    const alarm = snapshot?.alarms.find((a) => a.id === id);
    if (alarm === undefined) return;
    setEditingId(id);
    setForm(formFromAlarm(alarm));
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
    <div className="dshp-panel" data-testid="proactive-panel">
      <div className="dshp-head">
        <div>
          <h2 className="dshp-title">{copy.globalTitle}</h2>
          <div className="dshp-sub">
            {loading ? copy.loading : copy.globalView + " · " + alarms.length + " " + copy.alarms}
          </div>
        </div>
        <div className="dshp-btn-row">
          <button className="dshp-btn" onClick={() => { void reload(); }} disabled={busy || loading}>{copy.refresh}</button>
          <button className="dshp-btn dshp-btn-primary" onClick={openCreate} disabled={snapshot === null}>{copy.newAlarm}</button>
        </div>
      </div>

      {error !== null && <div className="dshp-error">{copy.error}: {error}</div>}

      {loading ? (
        <div className="dshp-card"><LoadingBlock copy={copy} /></div>
      ) : snapshot !== null ? (
        <div className="dshp-card">
          <div className="dshp-card-head">
            <span>{copy.configSectionTitle}</span>
            <span className="dshp-cell-dim">{copy.configSectionDesc}</span>
          </div>
          <div className="dshp-card-body">
            <div className="dshp-switch-row">
              <div>
                <div className="dshp-switch-label">{copy.enabledToggle}</div>
                <div className="dshp-switch-desc">{copy.budget}: {snapshot.config.maxDeliveriesPerDay}{copy.perDay} · {copy.quietHours}: {snapshot.config.quietHours.start}-{snapshot.config.quietHours.end}</div>
              </div>
              <label className="dshp-switch">
                <input type="checkbox" checked={(draft ?? configDraftFrom(snapshot)).enabled} disabled={busy}
                  onChange={(e) => setDraft({ ...(draft ?? configDraftFrom(snapshot)), enabled: e.target.checked })} />
                <span className="dshp-switch-track" />
                <span className="dshp-switch-thumb" />
              </label>
            </div>
            {snapshot.config.silentWakeCompaction !== undefined ? (
              <div className="dshp-switch-row">
                <div>
                  <div className="dshp-switch-label">{copy.silentWakeCompactionToggle}</div>
                  <div className="dshp-switch-desc">{copy.silentWakeCompactionHint}</div>
                </div>
                <label className="dshp-switch">
                  <input type="checkbox" checked={(draft ?? configDraftFrom(snapshot)).silentWakeCompaction} disabled={busy}
                    onChange={(e) => setDraft({ ...(draft ?? configDraftFrom(snapshot)), silentWakeCompaction: e.target.checked })} />
                  <span className="dshp-switch-track" />
                  <span className="dshp-switch-thumb" />
                </label>
              </div>
            ) : null}
            <div className="dshp-field-row">
              <div className="dshp-field" style={{ flex: 1, minWidth: 120 }}>
                <label className="dshp-field-label">{copy.budget}</label>
                <input className="dshp-input" type="number" min={0} max={50} value={(draft ?? configDraftFrom(snapshot)).maxDeliveriesPerDay} disabled={busy}
                  onChange={(e) => setDraft({ ...(draft ?? configDraftFrom(snapshot)), maxDeliveriesPerDay: e.target.value })} />
              </div>
              <div className="dshp-field" style={{ flex: 1, minWidth: 100 }}>
                <label className="dshp-field-label">{copy.quietHoursStart}</label>
                <input className="dshp-input" type="time" value={(draft ?? configDraftFrom(snapshot)).quietStart} disabled={busy}
                  onChange={(e) => setDraft({ ...(draft ?? configDraftFrom(snapshot)), quietStart: e.target.value })} />
              </div>
              <div className="dshp-field" style={{ flex: 1, minWidth: 100 }}>
                <label className="dshp-field-label">{copy.quietHoursEnd}</label>
                <input className="dshp-input" type="time" value={(draft ?? configDraftFrom(snapshot)).quietEnd} disabled={busy}
                  onChange={(e) => setDraft({ ...(draft ?? configDraftFrom(snapshot)), quietEnd: e.target.value })} />
              </div>
            </div>
            {snapshot.config.defaultPrompt !== undefined ? (
              <div className="dshp-field">
                <label className="dshp-field-label">{copy.defaultPromptLabel}</label>
                <textarea className="dshp-input dshp-grow" rows={3} maxLength={MAX_PROMPT_LENGTH} value={(draft ?? configDraftFrom(snapshot)).defaultPrompt} disabled={busy}
                  placeholder={defaultPromptOf(null)}
                  onChange={(e) => setDraft({ ...(draft ?? configDraftFrom(snapshot)), defaultPrompt: e.target.value })} />
                <div className="dshp-cell-dim">{copy.defaultPromptHint}</div>
              </div>
            ) : null}
            <div className="dshp-btn-row">
              <button className="dshp-btn dshp-btn-primary" disabled={busy} onClick={() => { void submitConfig(); }}>{copy.saveConfig}</button>
            </div>
          </div>
        </div>
      ) : null}

      {showForm ? (
        <CreateForm form={form} setForm={setForm} showForm={showForm} setShowForm={setShowForm} busy={busy}
          copy={copy} editing={editingId !== null} knownSessions={knownSessions}
          knownWorkspaces={knownWorkspaces} knownPresets={snapshot?.presets} defaultWorkspaceId={defaultWorkspaceId}
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
            <AlarmTable alarms={alarms} runsByAlarm={runsByAlarm} showSession busy={busy} copy={copy}
              onToggle={(id) => { void run({ kind: "toggle", id }); }}
              onCancel={(id) => { if (confirm(copy.confirmCancel)) void run({ kind: "cancel", id }); }}
              onFire={(id) => { void run({ kind: "fire", id }); }}
              onEdit={(id) => openEdit(id)}
              onCopyId={(sessionId) => { void copyId(sessionId); }} />
          )}
          {copiedId !== null ? (
            <div className="dshp-toast">{copy.copied}: {copiedId === HOST_PANEL_SESSION ? fmtSession(copiedId, undefined, copy) : copiedId}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
