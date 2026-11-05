import { Injectable, computed, inject, signal } from '@angular/core';
import type { Repository } from '@contracts/domain';
import { GraphSessionStore } from './graph-session.store';
import { RepoState } from './repo-state.service';

/**
 * One open repository tab. Renderer-only UI-state (ADR-024): it mirrors an
 * already-opened repository record from the core `repos` table and adds no
 * entity, RPC or Git truth of its own.
 */
export interface RepoTab {
  /** Matches `Repository.id` from the core. */
  readonly repoId: string;
  /** Cached filesystem path (mirrors `Repository.fsPath`). */
  readonly fsPath: string;
  /** Cached display name (mirrors `Repository.name`). */
  readonly name: string;
}

/** Persisted shape of the workspace UI-state (which tabs, order and active). */
interface PersistedWorkspaces {
  readonly tabs: RepoTab[];
  readonly activeTabId: string | null;
}

/** localStorage key for the workspace UI-state (matches the `st:` convention). */
export const WORKSPACES_STORAGE_KEY = 'st:workspaceTabs';

/**
 * Root store for repo tabs ("workspaces", ADR-024).
 *
 * Owns the ordered list of open repository tabs, the active tab id and the
 * tab-only view state. It is deliberately renderer UI-state: the opened-repo
 * records live in the core (`RepoService` Open/List/Remove) and this store adds
 * no core entity. `RepoState.activeId`/`activeRepo` stays the single active-repo
 * source of truth — `selectTab` mirrors the selection into `RepoState`.
 *
 * The list, order and active tab persist to localStorage (UI-state only, never
 * Git or core domain state). `RepoState` is a constructor parameter (defaulting
 * to DI) so the store is unit-testable without TestBed.
 *
 * Closing (or reconciling away) a tab also forgets that repo's graph session
 * selection/padlock: the session is session-scoped UI state and must not
 * outlive the tab it belongs to.
 */
@Injectable({ providedIn: 'root' })
export class WorkspacesStore {
  private readonly repoState: RepoState;
  /**
   * Root in-memory graph session, captured once at construction. Optional so
   * plain `new WorkspacesStore(fakeRepoState)` unit tests keep working without
   * a DI context (see {@link safeInjectGraphSession}).
   */
  private readonly graphSession: GraphSessionStore | null;

  constructor(
    repoState: RepoState = inject(RepoState),
    graphSession: GraphSessionStore | null = safeInjectGraphSession(),
  ) {
    this.repoState = repoState;
    this.graphSession = graphSession;
  }

  private readonly tabsState = signal<RepoTab[]>([]);
  private readonly activeTabIdState = signal<string | null>(null);

  /** Ordered open tabs, left to right. */
  readonly tabs = this.tabsState.asReadonly();
  /** Id of the active tab, or null when no tab is open. */
  readonly activeTabId = this.activeTabIdState.asReadonly();
  /** The active tab record, or null. */
  readonly activeTab = computed<RepoTab | null>(() => {
    const id = this.activeTabIdState();
    if (!id) return null;
    return this.tabsState().find((tab) => tab.repoId === id) ?? null;
  });

  // -- startup: rehydrate + reconcile --------------------------------------

  /**
   * Restore the persisted tab list/order/active id from localStorage. Malformed
   * or unreadable state is ignored (the store simply starts empty).
   */
  rehydrate(): void {
    const persisted = this.readPersisted();
    if (!persisted) return;
    this.tabsState.set(persisted.tabs);
    this.activeTabIdState.set(persisted.activeTabId);
  }

  /**
   * Drop tabs whose repository no longer exists in the core list and refresh the
   * cached name/path from the authoritative records. When the active tab was
   * dropped, the first remaining tab (if any) becomes active.
   */
  reconcile(repos: readonly Repository[]): void {
    const byId = new Map(repos.map((repo) => [repo.id, repo]));
    const previous = this.tabsState();
    // A tab dropped by the filter is dead: discard its graph session too, so a
    // closed repo never leaves an orphan selection/padlock in memory.
    for (const tab of previous) {
      if (!byId.has(tab.repoId)) this.graphSession?.forget(tab.repoId);
    }
    const tabs = previous
      .filter((tab) => byId.has(tab.repoId))
      .map((tab) => {
        const repo = byId.get(tab.repoId);
        return repo
          ? { repoId: repo.id, fsPath: repo.fsPath, name: repo.name }
          : tab;
      });
    this.tabsState.set(tabs);

    const active = this.activeTabIdState();
    if (active && !tabs.some((tab) => tab.repoId === active)) {
      const fallbackId = tabs[0]?.repoId ?? null;
      this.activeTabIdState.set(fallbackId);
      if (fallbackId) {
        // Mirror the fallback into RepoState so the active-repo source of truth
        // never points at a tab that no longer exists.
        const repo = byId.get(fallbackId);
        if (repo) this.repoState.setActive(repo);
      } else {
        // Every tab was dropped: clear the active repository.
        this.repoState.clearActive();
      }
    }
    this.persist();
  }

  // -- mutations -----------------------------------------------------------

  /**
   * Register `repo` as an open tab (or refresh its cached name/path) and make it
   * the active tab. Does not touch `RepoState`: callers activate the repository
   * explicitly so opening from the repos page/picker keeps a single flow.
   */
  openTab(repo: Repository): void {
    const exists = this.tabsState().some((tab) => tab.repoId === repo.id);
    const tab: RepoTab = { repoId: repo.id, fsPath: repo.fsPath, name: repo.name };
    this.tabsState.update((prev) =>
      exists ? prev.map((current) => (current.repoId === repo.id ? tab : current)) : [...prev, tab],
    );
    this.activeTabIdState.set(repo.id);
    this.persist();
  }

  /**
   * Activate the tab for `repoId` and mirror it into `RepoState` (the active-repo
   * source of truth). No-op for an unknown id, or for a tab that is already both
   * active and mirrored (re-clicking the active tab stays a no-op).
   *
   * When the tab's record is present in `RepoState.repos()` the mirror is
   * synchronous (`setActive`, ADR-024: "Switching tabs routes to existing
   * per-repo IPC calls"). When it is missing — e.g. a rehydrated tab whose repo
   * is not yet in the settled core list — the source of truth follows the tab by
   * opening it by path through `RepoState`: on success the repo is opened and
   * activated (and `RepoPage`'s effect opens the graph). On failure the core no
   * longer knows this path, so the tab is dropped and a neighbour is activated
   * (mirroring `reconcile`); the failure itself is recorded on
   * `RepoState.reposError` (visible in the drawer).
   */
  selectTab(repoId: string): void {
    const tab = this.tabsState().find((candidate) => candidate.repoId === repoId);
    if (!tab) return;
    // Already active *and* already mirrored: nothing to do.
    if (this.activeTabIdState() === repoId && this.repoState.activeId() === repoId) return;
    this.activeTabIdState.set(repoId);
    const repo = this.repoState.repos().find((candidate) => candidate.id === repoId);
    if (repo) {
      this.repoState.setActive(repo);
    } else {
      // Not in the core list yet: open by path so the active-repo source of
      // truth follows the tab.
      void this.repoState.openRepositoryPath(tab.fsPath).then((opened) => {
        // The open failed: the core no longer knows this path. Drop the dead
        // tab exactly like `reconcile` does at startup — `closeTab` activates
        // (and mirrors) the neighbour, or clears the active repo when this was
        // the last tab — so the top bar, `RepoState` and the graph never
        // diverge. The failure itself is recorded on `RepoState.reposError`.
        if (!opened) this.closeTab(repoId);
      });
    }
    this.persist();
  }

  /**
   * Close the tab for `repoId`. When the active tab is closed, the neighbour at
   * the same index (or the previous one) becomes active, and its repository is
   * mirrored into `RepoState`; with no tabs left the active id becomes null.
   */
  closeTab(repoId: string): void {
    const tabs = this.tabsState();
    const index = tabs.findIndex((tab) => tab.repoId === repoId);
    if (index === -1) return;

    // The tab exists, so its session is now dead: discard it (no-op when the
    // repo never saved any selection/lock).
    this.graphSession?.forget(repoId);

    const next = tabs.filter((tab) => tab.repoId !== repoId);
    this.tabsState.set(next);

    if (this.activeTabIdState() === repoId) {
      const neighbour = next[Math.min(index, next.length - 1)] ?? null;
      this.activeTabIdState.set(neighbour?.repoId ?? null);
      if (neighbour) {
        const repo = this.repoState.repos().find((candidate) => candidate.id === neighbour.repoId);
        if (repo) this.repoState.setActive(repo);
      } else {
        // No tab left: clear the active repository so the sidebar/toolbar stop
        // showing refs for a repo that no longer has an open tab.
        this.repoState.clearActive();
      }
    }
    this.persist();
  }

  /** Move the tab at `from` to `to`, preserving the active selection. */
  moveTab(from: number, to: number): void {
    const tabs = [...this.tabsState()];
    if (from < 0 || from >= tabs.length || to < 0 || to >= tabs.length || from === to) return;
    const [moved] = tabs.splice(from, 1);
    tabs.splice(to, 0, moved);
    this.tabsState.set(tabs);
    this.persist();
  }

  // -- persistence ---------------------------------------------------------

  private persist(): void {
    const payload: PersistedWorkspaces = {
      tabs: this.tabsState(),
      activeTabId: this.activeTabIdState(),
    };
    try {
      localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Persistence is best-effort UI-state; a full/blocked storage is harmless.
    }
  }

  private readPersisted(): PersistedWorkspaces | null {
    try {
      const raw = localStorage.getItem(WORKSPACES_STORAGE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!isPlainObject(parsed)) return null;
      const tabs = Array.isArray(parsed['tabs']) ? parsed['tabs'].filter(isRepoTab) : [];
      const active = parsed['activeTabId'];
      const activeTabId = typeof active === 'string' ? active : null;
      return {
        tabs,
        activeTabId: activeTabId && tabs.some((tab) => tab.repoId === activeTabId) ? activeTabId : null,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Read the root `GraphSessionStore` when one exists, else `null`.
 *
 * The store is also constructed directly (`new WorkspacesStore(repoState)`) in
 * unit tests with no DI context, where a bare `inject()` would throw NG0203;
 * forgetting a closed tab's session then simply degrades to a no-op.
 */
function safeInjectGraphSession(): GraphSessionStore | null {
  try {
    return inject(GraphSessionStore, { optional: true });
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isRepoTab(value: unknown): value is RepoTab {
  return (
    isPlainObject(value) &&
    typeof value['repoId'] === 'string' &&
    typeof value['fsPath'] === 'string' &&
    typeof value['name'] === 'string'
  );
}
