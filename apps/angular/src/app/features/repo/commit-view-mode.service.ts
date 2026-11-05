import { Injectable, effect, inject, signal } from '@angular/core';
import { RepoState } from '../../core/services/repo-state.service';

/** The two exclusive regions the commit-details panel can show. */
export type CommitViewMode = 'description' | 'files';

/**
 * Route-scoped `description | files` choice shared by the commit-details hosts.
 *
 * The panel instance is unmounted across `/repo` ↔ `/repo/file-status`, so the
 * mode cannot live inside it: it is provided on the parent repository route
 * (next to `GraphStore`/`StatusStore`) and survives that navigation.
 *
 * The mode is deliberately per-repository view state: whenever the active
 * repository changes the service resets to `description`, so a `files` pick
 * never leaks into another repository.
 */
@Injectable()
export class CommitViewModeService {
  private readonly repoState = inject(RepoState);

  readonly mode = signal<CommitViewMode>('description');

  /** Last active repository id observed by the reset effect. */
  private previousRepoId: string | null;

  constructor() {
    this.previousRepoId = this.repoState.activeId();
    effect(() => {
      const repoId = this.repoState.activeId();
      if (repoId === this.previousRepoId) return;
      this.previousRepoId = repoId;
      this.reset();
    });
  }

  setMode(mode: CommitViewMode): void {
    this.mode.set(mode);
  }

  /** Back to the default segment (also used when the repository changes). */
  reset(): void {
    this.mode.set('description');
  }
}
