import { Injectable, signal } from '@angular/core';

/** A commit the renderer asked to focus: which repository and which oid. */
export interface CommitFocusRequest {
  readonly repoId: string;
  readonly oid: string;
}

/**
 * Root hand-off for "focus this commit" navigation (ADR-025 deep links).
 *
 * A deep link that names a commit can arrive before the commit graph is mounted:
 * the graph is route-scoped and only exists once `/repo` is mounted for the
 * target repository. This tiny signal service bridges the two: the shell's
 * `open-commit` deep-link path (or any caller) publishes a pending focus, and the
 * route-scoped `RepoPage` consumes it once the matching repository is open,
 * selecting the commit in the graph.
 */
@Injectable({ providedIn: 'root' })
export class CommitFocusService {
  private readonly state = signal<CommitFocusRequest | null>(null);

  /** The pending focus request, or null when none is queued. */
  readonly pending = this.state.asReadonly();

  /** Queue a focus request for `oid` in `repoId`, replacing any previous one. */
  request(repoId: string, oid: string): void {
    if (!repoId || !oid) return;
    this.state.set({ repoId, oid });
  }

  /** Clear the pending request. */
  clear(): void {
    this.state.set(null);
  }

  /**
   * Consume the pending request when it targets `repoId`, returning its oid and
   * clearing it; returns null when the pending request is for another repository.
   */
  consume(repoId: string): string | null {
    const pending = this.state();
    if (pending && pending.repoId === repoId) {
      this.state.set(null);
      return pending.oid;
    }
    return null;
  }
}
