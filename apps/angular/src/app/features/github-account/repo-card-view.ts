import type { GitHubRepo } from '@contracts/auth';
import type { RepoCardView } from '@singularitree/ui-kit';

/**
 * Map a GitHub repository payload to the shared repo-card presentational view.
 *
 * Single source of truth for the `GitHubRepo -> RepoCardView` projection used by
 * both the account page list and the shell drawer.
 */
export function toRepoCardView(repo: GitHubRepo): RepoCardView {
  return {
    id: String(repo.id),
    name: repo.fullName || repo.name,
    subtitle: repo.description || repo.cloneUrl || '',
    badge: repo.visibility || (repo.private ? 'private' : 'public'),
  };
}
