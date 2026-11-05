import type { Commit, Lane } from '@contracts/domain';
import type { GetCommitsResponse } from '@contracts/gitcore';
import type { CommitRow } from './repo-models';

// Pure, Angular-free mapping from the `getCommits` contract response to the
// renderer view model. Keeping it free of Angular (and of any runtime `@contracts`
// import) makes it trivially unit-testable with plain vitest.

/**
 * Neutral lane used when Go omits the lane for a row (short or missing `lanes`
 * array). A fresh object per call avoids accidental shared mutable state.
 */
export function neutralLane(): Lane {
  return { index: 0, color: 0, continues: false };
}

/** `lanes[i]` is index-aligned with `commits[i]` per contract; tolerate gaps. */
export function laneAt(lanes: readonly Lane[] | undefined | null, index: number): Lane {
  const lane = lanes?.[index];
  return lane ? { ...lane } : neutralLane();
}

export function toCommitRow(commit: Commit, lane: Lane): CommitRow {
  const refs = commit.refs ?? [];
  return {
    commit,
    lane,
    refs,
    isHead: refs.some((ref) => ref.kind === 'head'),
  };
}

/** Join the parallel `commits`/`lanes` arrays (index-aligned per contract). */
export function joinRows(
  commits: readonly Commit[],
  lanes: readonly Lane[] | undefined | null,
): CommitRow[] {
  return commits.map((commit, index) => toCommitRow(commit, laneAt(lanes, index)));
}

export function mapCommitRows(resp: GetCommitsResponse): CommitRow[] {
  return joinRows(resp.commits ?? [], resp.lanes);
}

/**
 * Lanes normalized to exactly one entry per commit so the store can append
 * windows while keeping `lanes[i]` aligned with `commits[i]` even when the core
 * returns a short/absent `lanes` array.
 */
export function mapPageLanes(resp: GetCommitsResponse): Lane[] {
  return (resp.commits ?? []).map((_, index) => laneAt(resp.lanes, index));
}

/** Highest lane index across rows (drives the SVG graph column width). */
export function maxLaneIndex(rows: readonly CommitRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.lane.index), 0);
}

/**
 * Case-insensitive filter over message, author name/email, oid (full or short)
 * and ref labels. Empty query returns a copy of every row.
 */
export function filterRows(rows: readonly CommitRow[], query: string): CommitRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];

  return rows.filter((row) => {
    const message = row.commit.message.toLowerCase();
    const oid = row.commit.oid?.hex?.toLowerCase() ?? '';
    const author = row.commit.author?.name?.toLowerCase() ?? '';
    const email = row.commit.author?.email?.toLowerCase() ?? '';
    return (
      message.includes(needle) ||
      oid.includes(needle) ||
      author.includes(needle) ||
      email.includes(needle) ||
      row.refs.some((ref) => ref.name.toLowerCase().includes(needle))
    );
  });
}
