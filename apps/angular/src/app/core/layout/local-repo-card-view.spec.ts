import { describe, expect, it } from 'vitest';
import type { Repository } from '@contracts/domain';
import { toLocalRepoCardView } from './local-repo-card-view';

const REPO: Repository = {
  id: 'repo-a',
  fsPath: '/tmp/a',
  commonDir: '/tmp/a/.git',
  name: 'alpha',
  createdAt: '2026-01-01T00:00:00Z',
  lastOpenedAt: '2026-01-01T00:00:00Z',
};

describe('toLocalRepoCardView', () => {
  it('projects a local Repository to a RepoCardView', () => {
    expect(toLocalRepoCardView(REPO)).toEqual({
      id: REPO.id,
      name: REPO.name,
      subtitle: REPO.fsPath,
    });
  });
});
