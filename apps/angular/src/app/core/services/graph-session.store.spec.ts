import { describe, expect, it } from 'vitest';
import type { Commit } from '@contracts/domain';
import { GraphSessionStore, type RepoGraphSessionState } from './graph-session.store';

const COMMIT: Commit = {
  oid: { hex: 'a'.repeat(40), kind: 'SHA1' },
  parents: [],
  author: { name: 'Author', email: 'author@example.com', when: '2026-01-02T10:00:00Z' },
  committer: undefined,
  message: 'commit',
  treeOid: undefined,
  committedAt: '2026-01-02T10:05:00Z',
  refs: [],
};

function makeState(selectedOid: string | null): RepoGraphSessionState {
  return {
    selectedOid,
    lockedOid: selectedOid,
    lockedCommit: selectedOid ? COMMIT : null,
  };
}

describe('GraphSessionStore', () => {
  it('returns null for a repo with no saved session', () => {
    const store = new GraphSessionStore();

    expect(store.read('repo-1')).toBeNull();
  });

  it('writes and reads a repo session, replacing an earlier value', () => {
    const store = new GraphSessionStore();
    const first = makeState('a'.repeat(40));
    const second = makeState('b'.repeat(40));

    store.write('repo-1', first);
    expect(store.read('repo-1')).toBe(first);

    store.write('repo-1', second);
    expect(store.read('repo-1')).toBe(second);
  });

  it('keeps each repo session isolated', () => {
    const store = new GraphSessionStore();
    const repoOne = makeState('a'.repeat(40));
    const repoTwo = makeState('b'.repeat(40));

    store.write('repo-1', repoOne);
    store.write('repo-2', repoTwo);

    expect(store.read('repo-1')).toBe(repoOne);
    expect(store.read('repo-2')).toBe(repoTwo);
    expect(store.read('repo-3')).toBeNull();
  });

  it('forgets only the requested repo session', () => {
    const store = new GraphSessionStore();
    const repoOne = makeState('a'.repeat(40));
    const repoTwo = makeState('b'.repeat(40));
    store.write('repo-1', repoOne);
    store.write('repo-2', repoTwo);

    store.forget('repo-1');

    expect(store.read('repo-1')).toBeNull();
    expect(store.read('repo-2')).toBe(repoTwo);
  });

  it('tolerates forgetting an unknown repo', () => {
    const store = new GraphSessionStore();

    expect(() => store.forget('missing')).not.toThrow();
    expect(store.read('missing')).toBeNull();
  });
});
