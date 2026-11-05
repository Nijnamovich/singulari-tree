import type { Repository } from '@contracts/domain';
import type { RepoCardView } from '@singularitree/ui-kit';

/**
 * Map a local tracked repository to the shared repo-card presentational view.
 *
 * Single source of truth for the `Repository -> RepoCardView` projection used by
 * the shell's "Local repositories" drawer.
 */
export function toLocalRepoCardView(repo: Repository): RepoCardView {
  return { id: repo.id, name: repo.name, subtitle: repo.fsPath };
}
