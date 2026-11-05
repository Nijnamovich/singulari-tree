import { describe, expect, it } from 'vitest';
import type { Branch, Diff, FileDiff, Hunk, Oid } from '@contracts/domain';
import {
  commitChangeSummary,
  findRefOid,
  resolveBaseRef,
  toSingleFileDiff,
} from './file-status-mappers';

function oid(hex: string): Oid {
  return { hex, kind: 'SHA1' };
}

function hunk(text = 'x'): Hunk {
  return {
    fromStart: 1,
    fromLines: 1,
    toStart: 1,
    toLines: 1,
    lines: [{ kind: 'added', text, noNewline: false }],
  };
}

function fileDiff(path: string, overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path,
    oldPath: '',
    status: 'M',
    hunks: [hunk()],
    additions: 1,
    deletions: 0,
    isBinary: false,
    hasConflictMarkers: false,
    ...overrides,
  };
}

function wholeDiff(files: FileDiff[], overrides: Partial<Diff> = {}): Diff {
  return {
    from: oid('from-oid'),
    to: oid('to-oid'),
    hunks: [],
    additions: 2,
    deletions: 1,
    isBinary: false,
    hasConflictMarkers: false,
    files,
    truncated: false,
    ...overrides,
  };
}

function branch(
  name: string,
  tip: string | undefined,
  overrides: Partial<Branch> = {},
): Branch {
  return {
    name,
    refName: overrides.isRemote ? `refs/remotes/${name}` : `refs/heads/${name}`,
    tip: tip ? oid(tip) : undefined,
    upstream: '',
    isCurrent: false,
    isRemote: false,
    behind: 0,
    ...overrides,
  };
}

const A = fileDiff('a.ts');
const B = fileDiff('b.ts', { additions: 3, deletions: 2, status: 'A' });

describe('toSingleFileDiff', () => {
  it('lifts the matching file into a single-file Diff', () => {
    const result = toSingleFileDiff(wholeDiff([A, B]), 'a.ts');

    expect(result).not.toBeNull();
    expect(result?.files).toEqual([A]);
    expect(result?.hunks).toEqual(A.hunks);
    expect(result?.from?.hex).toBe('from-oid');
    expect(result?.to?.hex).toBe('to-oid');
  });

  it('carries hunks, additions, deletions, binary, conflict and truncated flags', () => {
    const file = fileDiff('bin.dat', {
      hunks: [],
      additions: 0,
      deletions: 0,
      isBinary: true,
      hasConflictMarkers: true,
    });
    const result = toSingleFileDiff(
      wholeDiff([file], { truncated: true, hunks: [hunk('legacy')] }),
      'bin.dat',
    );

    expect(result).toEqual({
      from: oid('from-oid'),
      to: oid('to-oid'),
      hunks: [],
      additions: 0,
      deletions: 0,
      isBinary: true,
      hasConflictMarkers: true,
      files: [file],
      truncated: true,
    });
  });

  it('returns null on a falsy diff or path', () => {
    expect(toSingleFileDiff(null, 'a.ts')).toBeNull();
    expect(toSingleFileDiff(undefined, 'a.ts')).toBeNull();
    expect(toSingleFileDiff(wholeDiff([A]), null)).toBeNull();
    expect(toSingleFileDiff(wholeDiff([A]), '')).toBeNull();
  });

  it('returns null when no file matches the path', () => {
    expect(toSingleFileDiff(wholeDiff([A, B]), 'c.ts')).toBeNull();
    expect(toSingleFileDiff(wholeDiff([]), 'a.ts')).toBeNull();
  });

  it('resolves a renamed file by its new path but never by its old path', () => {
    const renamed = fileDiff('renamed.ts', { oldPath: 'old.ts', status: 'R' });
    const diff = wholeDiff([renamed]);

    expect(toSingleFileDiff(diff, 'renamed.ts')?.files).toEqual([renamed]);
    expect(toSingleFileDiff(diff, 'old.ts')).toBeNull();
  });
});

describe('resolveBaseRef', () => {
  it('prefers the local branch over origin/main', () => {
    const branches = [
      branch('origin/main', 'origin-main-oid', { isRemote: true }),
      branch('main', 'main-oid'),
    ];

    expect(resolveBaseRef(branches)).toEqual({ name: 'main', oid: 'main-oid', isRemote: false });
  });

  it('falls back to the local master', () => {
    // `main` does not resolve at all (neither local nor remote), so the second
    // preferred name is used and its LOCAL match wins over origin/master.
    const branches = [
      branch('origin/master', 'origin-master-oid', { isRemote: true }),
      branch('master', 'master-oid'),
    ];

    expect(resolveBaseRef(branches)).toEqual({ name: 'master', oid: 'master-oid', isRemote: false });
  });

  it('prefers origin/main over a local master (per-preferred local-then-remote)', () => {
    const branches = [
      branch('origin/main', 'origin-main-oid', { isRemote: true }),
      branch('master', 'master-oid'),
    ];

    expect(resolveBaseRef(branches)).toEqual({
      name: 'origin/main',
      oid: 'origin-main-oid',
      isRemote: true,
    });
  });

  it('falls back to origin/main then origin/master', () => {
    expect(resolveBaseRef([branch('origin/main', 'origin-main-oid', { isRemote: true })])).toEqual({
      name: 'origin/main',
      oid: 'origin-main-oid',
      isRemote: true,
    });
    expect(resolveBaseRef([branch('origin/master', 'origin-master-oid', { isRemote: true })])).toEqual({
      name: 'origin/master',
      oid: 'origin-master-oid',
      isRemote: true,
    });
  });

  it('matches a remote-tracking branch by its ref suffix', () => {
    const remote = branch('main', 'remote-main-oid', {
      isRemote: true,
      refName: 'refs/remotes/upstream/main',
    });

    expect(resolveBaseRef([remote])).toEqual({ name: 'main', oid: 'remote-main-oid', isRemote: true });
  });

  it('falls back to the current local branch, then the first local, then the first remote', () => {
    const current = branch('develop', 'develop-oid', { isCurrent: true });
    expect(resolveBaseRef([branch('feature', 'feature-oid'), current])).toEqual({
      name: 'develop',
      oid: 'develop-oid',
      isRemote: false,
    });

    const firstLocal = branch('feature', 'feature-oid');
    expect(resolveBaseRef([firstLocal, branch('origin/other', 'other-oid', { isRemote: true })])).toEqual({
      name: 'feature',
      oid: 'feature-oid',
      isRemote: false,
    });

    const onlyRemote = branch('origin/other', 'other-oid', { isRemote: true });
    expect(resolveBaseRef([onlyRemote])).toEqual({
      name: 'origin/other',
      oid: 'other-oid',
      isRemote: true,
    });
  });

  it('honours a custom preferred list', () => {
    const branches = [branch('main', 'main-oid'), branch('develop', 'develop-oid')];

    expect(resolveBaseRef(branches, ['develop'])?.name).toBe('develop');
  });

  it('never selects a branch without a tip', () => {
    expect(resolveBaseRef([branch('main', undefined), branch('origin/main', undefined, { isRemote: true })])).toBeNull();
  });

  it('returns null on an empty or absent branch list', () => {
    expect(resolveBaseRef([])).toBeNull();
    expect(resolveBaseRef([] as Branch[])).toBeNull();
  });
});

describe('findRefOid', () => {
  const branches = [
    branch('main', 'main-oid'),
    branch('feature', 'feature-oid', { isCurrent: true }),
    branch('origin/main', 'origin-main-oid', { isRemote: true }),
  ];

  it('resolves a local branch exactly', () => {
    expect(findRefOid(branches, 'main')).toBe('main-oid');
    expect(findRefOid(branches, 'feature')).toBe('feature-oid');
  });

  it('resolves a remote-tracking branch by exact name or short suffix', () => {
    expect(findRefOid(branches, 'origin/main')).toBe('origin-main-oid');
    expect(findRefOid(branches, 'main')).toBe('main-oid'); // local wins over the remote
  });

  it('trims surrounding whitespace', () => {
    expect(findRefOid(branches, '  feature  ')).toBe('feature-oid');
  });

  it('returns null when the ref is absent or has no tip', () => {
    expect(findRefOid(branches, 'nope')).toBeNull();
    expect(findRefOid(branches, '')).toBeNull();
    expect(findRefOid([branch('main', undefined)], 'main')).toBeNull();
    expect(findRefOid([branch('origin/main', undefined, { isRemote: true })], 'origin/main')).toBeNull();
  });
});

describe('commitChangeSummary', () => {
  it('counts files, additions and deletions', () => {
    expect(commitChangeSummary(wholeDiff([A, B], { additions: 4, deletions: 2 }))).toEqual({
      filesChanged: 2,
      additions: 4,
      deletions: 2,
    });
  });

  it('returns all-zero counts on a missing diff', () => {
    expect(commitChangeSummary(null)).toEqual({ filesChanged: 0, additions: 0, deletions: 0 });
    expect(commitChangeSummary(undefined)).toEqual({ filesChanged: 0, additions: 0, deletions: 0 });
  });
});
