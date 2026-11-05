import { describe, expect, it } from 'vitest';
import type { Diff } from '@contracts/domain';
import { diffToGridRows, hunkGridSegments } from './hunks-to-texts';

// The pure mapping is the single source of truth for rendered-hunk → action-index
// addressing: a rendered hunk's `hunkIndex` and a changed line's `lineIndex` are
// exactly what `StageHunk`/`UnstageHunk`/`DiscardHunk` take as `hunk_index` /
// `line_indices`, and `rowIndex` is where that line lands in the grid.

function multiHunkDiff(): Diff {
  return {
    from: undefined,
    to: undefined,
    hunks: [
      {
        fromStart: 1,
        fromLines: 4,
        toStart: 1,
        toLines: 4,
        lines: [
          { kind: 'context', text: 'a', noNewline: false },
          { kind: 'removed', text: 'b', noNewline: false },
          { kind: 'added', text: 'B', noNewline: false },
          { kind: 'context', text: 'c', noNewline: false },
        ],
      },
      {
        fromStart: 10,
        fromLines: 3,
        toStart: 10,
        toLines: 3,
        lines: [
          { kind: 'context', text: 'x', noNewline: false },
          { kind: 'added', text: 'y', noNewline: false },
          { kind: 'removed', text: 'z', noNewline: true },
        ],
      },
    ],
    additions: 2,
    deletions: 2,
    isBinary: false,
    hasConflictMarkers: false,
    files: [],
    truncated: false,
  };
}

describe('hunkGridSegments', () => {
  it('maps each hunk header and its changed lines to grid rows and line indices', () => {
    const diff = multiHunkDiff();

    // Sanity: the row layout the segments index into.
    expect(diffToGridRows(diff).map((row) => row.kind)).toEqual([
      'hunk', // hunk 0 header
      'context', // a
      'removed', // b
      'added', // B
      'context', // c
      'hunk', // hunk 1 header
      'context', // x
      'added', // y
      'removed', // z
      'meta', // \ No newline
    ]);

    expect(hunkGridSegments(diff)).toEqual([
      {
        hunkIndex: 0,
        headerRowIndex: 0,
        lines: [
          { rowIndex: 2, lineIndex: 1 },
          { rowIndex: 3, lineIndex: 2 },
        ],
      },
      {
        hunkIndex: 1,
        headerRowIndex: 5,
        lines: [
          { rowIndex: 7, lineIndex: 1 },
          { rowIndex: 8, lineIndex: 2 },
        ],
      },
    ]);
  });

  it('counts the no-newline meta row so later hunks stay aligned', () => {
    const diff: Diff = {
      ...multiHunkDiff(),
      hunks: [
        {
          fromStart: 1,
          fromLines: 1,
          toStart: 1,
          toLines: 1,
          lines: [{ kind: 'added', text: 'only', noNewline: true }],
        },
        {
          fromStart: 5,
          fromLines: 1,
          toStart: 5,
          toLines: 1,
          lines: [{ kind: 'removed', text: 'last', noNewline: false }],
        },
      ],
    };

    expect(hunkGridSegments(diff)).toEqual([
      {
        hunkIndex: 0,
        headerRowIndex: 0,
        lines: [{ rowIndex: 1, lineIndex: 0 }],
      },
      {
        hunkIndex: 1,
        // header(0) + added(1) + meta(2) → the second header is row 3.
        headerRowIndex: 3,
        lines: [{ rowIndex: 4, lineIndex: 0 }],
      },
    ]);
  });

  it('returns an empty mapping for a null diff and for a hunk-less diff', () => {
    expect(hunkGridSegments(null)).toEqual([]);
    expect(hunkGridSegments(undefined)).toEqual([]);
    expect(hunkGridSegments({ ...multiHunkDiff(), hunks: [] })).toEqual([]);
  });
});
