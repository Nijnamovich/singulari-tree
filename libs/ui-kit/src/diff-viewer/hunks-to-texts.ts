import type { Diff, Hunk } from '@contracts/domain';

/** Original / modified sides plus a plain unified rendering of a `Diff`. */
export interface DiffTexts {
  /** Context + removed lines, joined with `\n` (the "before" side). */
  original: string;
  /** Context + added lines, joined with `\n` (the "after" side). */
  modified: string;
  /** Plain unified diff (hunk headers + ` `/`-`/`+` prefixes) for the fallback. */
  unified: string;
}

const NO_NEWLINE_MARKER = '\\ No newline at end of file';

function hunkHeader(hunk: Hunk): string {
  return `@@ -${hunk.fromStart},${hunk.fromLines} +${hunk.toStart},${hunk.toLines} @@`;
}

/**
 * Pure projection of a contract `Diff` into the three text views the viewer
 * needs. No DOM/Monaco dependency, so it is unit-testable in isolation.
 *
 * - `original` keeps context + removed lines,
 * - `modified` keeps context + added lines,
 * - `unified` is a plain unified rendering used by the `<pre>` fallback.
 *
 * `noNewline` lines append a `\ No newline at end of file` marker to the
 * unified view (the two sides are joined without a trailing newline).
 */
export function hunksToTexts(diff: Diff | null | undefined): DiffTexts {
  const original: string[] = [];
  const modified: string[] = [];
  const unified: string[] = [];

  for (const hunk of diff?.hunks ?? []) {
    unified.push(hunkHeader(hunk));
    for (const line of hunk.lines ?? []) {
      switch (line.kind) {
        case 'added':
          modified.push(line.text);
          unified.push(`+${line.text}`);
          break;
        case 'removed':
          original.push(line.text);
          unified.push(`-${line.text}`);
          break;
        default:
          original.push(line.text);
          modified.push(line.text);
          unified.push(` ${line.text}`);
          break;
      }
      if (line.noNewline) unified.push(NO_NEWLINE_MARKER);
    }
  }

  return {
    original: original.join('\n'),
    modified: modified.join('\n'),
    unified: unified.join('\n'),
  };
}

/** One row of the sketch's 4-column grid fallback (plan §4.6/D13). */
export interface DiffGridRow {
  kind: 'hunk' | 'context' | 'added' | 'removed' | 'meta';
  oldNum: number | null;
  newNum: number | null;
  sign: ' ' | '+' | '-' | '@' | '\\';
  text: string;
}

/**
 * Pure projection of a `Diff` into the 4-column grid rows for the non-Monaco
 * fallback (old-num | new-num | sign | code). Gutter numbers walk the hunk's
 * `fromStart`/`toStart` per side; added lines advance the new side only,
 * removed the old side only.
 */
export function diffToGridRows(diff: Diff | null | undefined): DiffGridRow[] {
  const rows: DiffGridRow[] = [];
  for (const hunk of diff?.hunks ?? []) {
    rows.push({ kind: 'hunk', oldNum: null, newNum: null, sign: '@', text: hunkHeader(hunk) });
    let oldLine = hunk.fromStart - 1;
    let newLine = hunk.toStart - 1;
    for (const line of hunk.lines ?? []) {
      switch (line.kind) {
        case 'added':
          newLine++;
          rows.push({ kind: 'added', oldNum: null, newNum: newLine, sign: '+', text: line.text });
          break;
        case 'removed':
          oldLine++;
          rows.push({ kind: 'removed', oldNum: oldLine, newNum: null, sign: '-', text: line.text });
          break;
        default:
          oldLine++;
          newLine++;
          rows.push({
            kind: 'context',
            oldNum: oldLine,
            newNum: newLine,
            sign: ' ',
            text: line.text,
          });
          break;
      }
      if (line.noNewline) {
        rows.push({
          kind: 'meta',
          oldNum: null,
          newNum: null,
          sign: '\\',
          text: NO_NEWLINE_MARKER,
        });
      }
    }
  }
  return rows;
}

/** A changed line's address in both the grid rows and the source hunk. */
export interface HunkLineSegment {
  /** Index into the `diffToGridRows(diff)` output (the rendered row). */
  readonly rowIndex: number;
  /** Index into `hunk.lines` (the RPC's `line_indices` addressing). */
  readonly lineIndex: number;
}

/** One rendered hunk: where its header row sits and where its changed lines sit. */
export interface HunkSegment {
  /** Index into `diff().hunks` — the RPC's `hunk_index`. */
  readonly hunkIndex: number;
  /** Index of the hunk header row within the `diffToGridRows()` output. */
  readonly headerRowIndex: number;
  /** ONLY changed (added/removed) lines, in render order. */
  readonly lines: readonly HunkLineSegment[];
}

/**
 * Pure projection of a `Diff` into per-hunk render anchors: the header row's
 * index within the `diffToGridRows()` output and, for every CHANGED line, both
 * its grid `rowIndex` and its `lineIndex` inside `hunk.lines` (the values the
 * `StageHunk`/`UnstageHunk`/`DiscardHunk` RPCs address by `hunk_index` /
 * `line_indices`).
 *
 * This walks the same row layout as `diffToGridRows` (one row per line plus one
 * meta row per `noNewline`) instead of re-deriving the diff, so a rendered hunk
 * maps 1:1 to the diff the host addresses — a single source of truth for the
 * inline-action surface.
 */
export function hunkGridSegments(diff: Diff | null | undefined): HunkSegment[] {
  const segments: HunkSegment[] = [];
  let rowIndex = 0;
  for (const [hunkIndex, hunk] of (diff?.hunks ?? []).entries()) {
    const headerRowIndex = rowIndex;
    rowIndex++; // The hunk header row.
    const lines: HunkLineSegment[] = [];
    for (const [lineIndex, line] of (hunk.lines ?? []).entries()) {
      if (line.kind === 'added' || line.kind === 'removed') {
        lines.push({ rowIndex, lineIndex });
      }
      rowIndex++; // The line row.
      if (line.noNewline) rowIndex++; // The `\ No newline` meta row.
    }
    segments.push({ hunkIndex, headerRowIndex, lines });
  }
  return segments;
}
