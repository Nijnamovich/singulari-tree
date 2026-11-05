import { Injectable } from '@angular/core';
import type { Commit } from '@contracts/domain';

/**
 * Per-repository graph UI-state kept for the lifetime of the app session.
 *
 * This is the selection/padlock counterpart of the route-scoped `GraphStore`:
 * the graph store itself is destroyed whenever the user leaves `/repo` (or
 * switches repo tabs), so the values it owns would otherwise be lost. The root
 * session store outlives those instances and lets a freshly created graph store
 * rehydrate the repo it is opening.
 */
export interface RepoGraphSessionState {
  readonly selectedOid: string | null;
  readonly lockedOid: string | null;
  readonly lockedCommit: Commit | null;
}

/**
 * Root, in-memory session store for graph selection/lock state, keyed by
 * repository id.
 *
 * Session-scoped UI state only: it is deliberately NOT persisted to
 * localStorage, sessionStorage, SQLite, disk or IPC. Quitting the app discards
 * everything. A repo tab that is closed (or reconciled away) calls
 * {@link forget}, so a dead tab never leaves an orphan entry behind.
 *
 * Synchronous and dependency-free by design: `GraphStore` reads/writes it from
 * plain synchronous mutators, and unit tests can instantiate it directly.
 */
@Injectable({ providedIn: 'root' })
export class GraphSessionStore {
  private readonly sessions = new Map<string, RepoGraphSessionState>();

  /** The saved state for `repoId`, or null when that repo has no session. */
  read(repoId: string): RepoGraphSessionState | null {
    return this.sessions.get(repoId) ?? null;
  }

  /** Save (or replace) the graph state for `repoId`. */
  write(repoId: string, state: RepoGraphSessionState): void {
    this.sessions.set(repoId, state);
  }

  /** Discard the saved state for `repoId` (closed/dead tab). */
  forget(repoId: string): void {
    this.sessions.delete(repoId);
  }
}
