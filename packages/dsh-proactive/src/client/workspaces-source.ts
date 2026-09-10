/**
 * Client-side workspace data source.
 *
 * The browser GUI exposes workspaces through the `workspaces` client service
 * (dsh-api-workspace-controller): a subscribe/getSnapshot store whose items
 * are the current Workspace projection in display order. There is NO
 * `workspace/list` HTTP RPC — the list arrives through this live model — so
 * the proactive panels read it here instead of through the host transport.
 *
 * The narrow shapes below are the only fields the panels consume; the service
 * itself is optional so a GUI without the workspace controller still mounts
 * the panels (picker disabled, hint shown).
 */

/** One workspace view from the client-side projection. */
export interface WorkspaceViewItem {
  readonly workspaceId: string;
  readonly title: string;
  readonly path: string;
}

/** The store snapshot consumed by the panels. */
export interface WorkspacesSnapshot {
  readonly items: readonly WorkspaceViewItem[];
}

/** The subscribe/getSnapshot store contract (the service's `list` model). */
export interface WorkspacesSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): WorkspacesSnapshot;
}

/** Stable empty snapshot for mounts without the service (never re-created). */
export const EMPTY_WORKSPACES: WorkspacesSnapshot = { items: [] };

/** Fallback subscribe/getSnapshot pair bound to {@link EMPTY_WORKSPACES}. */
export const EMPTY_SOURCE: WorkspacesSource = {
  subscribe: () => () => undefined,
  getSnapshot: () => EMPTY_WORKSPACES
};

/**
 * `this`-safe subscribe/getSnapshot pair for useSyncExternalStore: the live
 * model's methods read `this` internally, so bare method references would
 * crash — wrap them so each call dispatches through the source object.
 */
export function bindSource(source: WorkspacesSource): {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => WorkspacesSnapshot;
} {
  return {
    subscribe: (listener: () => void) => source.subscribe(listener),
    getSnapshot: () => {
      try {
        return source.getSnapshot();
      } catch {
        return EMPTY_WORKSPACES;
      }
    }
  };
}
