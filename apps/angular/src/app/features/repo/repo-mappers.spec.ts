import { describe, expect, it } from 'vitest';
import type { GetCommitsResponse } from '@contracts/gitcore';
import type { Commit } from '@contracts/domain';
import { filterRows, joinRows, mapCommitRows, mapPageLanes, maxLaneIndex } from './repo-mappers';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_C = 'c'.repeat(40);
const OID_D = 'd'.repeat(64);

const COMMIT_A: Commit = {
  oid: { hex: OID_A, kind: 'SHA1' },
  parents: [{ hex: OID_B, kind: 'SHA1' }],
  author: { name: 'Ada Lovelace', email: 'ada@example.com', when: '2026-01-02T10:00:00Z' },
  committer: { name: 'Grace Hopper', email: 'grace@example.com', when: '2026-01-02T10:05:00Z' },
  message: 'feat(graph): load commit window',
  treeOid: { hex: OID_C, kind: 'SHA1' },
  committedAt: '2026-01-02T10:05:00Z',
  refs: [
    { name: 'main', kind: 'head' },
    { name: 'origin/main', kind: 'remote' },
  ],
};

const COMMIT_B: Commit = {
  oid: { hex: OID_D, kind: 'SHA256' },
  parents: [],
  author: undefined,
  committer: undefined,
  message: 'chore: initial import',
  treeOid: undefined,
  committedAt: '2026-01-01T00:00:00Z',
  refs: [],
};

const RESPONSE: GetCommitsResponse = {
  total: 2,
  commits: [COMMIT_A, COMMIT_B],
  lanes: [
    { index: 0, color: 3, continues: true },
    { index: 1, color: 1, continues: false },
  ],
  inRefs: [],
};

describe('mapCommitRows', () => {
  it('maps a realistic GetCommitsResponse into lane-aligned CommitRow[]', () => {
    const rows = mapCommitRows(RESPONSE);

    expect(rows).toHaveLength(2);

    const [first, second] = rows;

    // First commit carries a full DAG/author payload and its Go-computed lane.
    expect(first.commit.oid?.hex).toBe(OID_A);
    expect(first.commit.message).toBe('feat(graph): load commit window');
    expect(first.commit.parents[0]?.hex).toBe(OID_B);
    expect(first.commit.author?.name).toBe('Ada Lovelace');
    expect(first.commit.committer?.when).toBe('2026-01-02T10:05:00Z');
    expect(first.lane).toEqual({ index: 0, color: 3, continues: true });
    expect(first.refs.map((ref) => ref.name)).toEqual(['main', 'origin/main']);
    expect(first.isHead).toBe(true);

    // Second commit is a root commit with optional fields absent and no refs.
    expect(second.commit.oid?.kind).toBe('SHA256');
    expect(second.commit.author).toBeUndefined();
    expect(second.lane).toEqual({ index: 1, color: 1, continues: false });
    expect(second.refs).toEqual([]);
    expect(second.isHead).toBe(false);

    // Lanes are cloned, never shared with the contract payload.
    expect(first.lane).not.toBe(RESPONSE.lanes[0]);
    expect(first.lane).not.toBe(second.lane);
  });

  it('returns an empty array for an empty response', () => {
    expect(mapCommitRows({ commits: [], total: 0, lanes: [], inRefs: [] })).toEqual([]);
  });

  it('defaults a neutral lane when the lanes array is missing or short', () => {
    const missing = mapCommitRows({
      commits: [COMMIT_A, COMMIT_B],
      total: 2,
      lanes: [],
      inRefs: [],
    } as GetCommitsResponse);
    expect(missing.map((row) => row.lane)).toEqual([
      { index: 0, color: 0, continues: false },
      { index: 0, color: 0, continues: false },
    ]);

    const short = joinRows([COMMIT_A, COMMIT_B], [{ index: 4, color: 2, continues: true }]);
    expect(short[0]?.lane).toEqual({ index: 4, color: 2, continues: true });
    expect(short[1]?.lane).toEqual({ index: 0, color: 0, continues: false });
  });

  it('normalizes page lanes to one entry per commit', () => {
    const lanes = mapPageLanes({
      commits: [COMMIT_A, COMMIT_B],
      total: 2,
      lanes: [],
      inRefs: [],
    });
    expect(lanes).toEqual([
      { index: 0, color: 0, continues: false },
      { index: 0, color: 0, continues: false },
    ]);
  });

  it('computes the highest lane index for the graph column width', () => {
    expect(maxLaneIndex(mapCommitRows(RESPONSE))).toBe(1);
    expect(maxLaneIndex([])).toBe(0);
  });
});

describe('filterRows', () => {
  const rows = mapCommitRows(RESPONSE);

  it('returns every row (a copy) for an empty query', () => {
    const result = filterRows(rows, '   ');
    expect(result).toEqual(rows);
    expect(result).not.toBe(rows);
  });

  it('matches message, author, email and short oid case-insensitively', () => {
    expect(filterRows(rows, 'GRAPH')).toHaveLength(1);
    expect(filterRows(rows, 'ada lovelace')).toHaveLength(1);
    expect(filterRows(rows, 'ada@example.com')).toHaveLength(1);
    expect(filterRows(rows, OID_D.slice(0, 7))).toHaveLength(1);
    expect(filterRows(rows, 'origin/main')).toHaveLength(1);
  });

  it('returns no rows when nothing matches', () => {
    expect(filterRows(rows, 'does-not-exist')).toEqual([]);
  });
});
