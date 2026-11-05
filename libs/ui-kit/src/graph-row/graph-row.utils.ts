// Pure helpers for the graph-row component. Kept free of Angular so they can be
// unit-tested without a DOM/TestBed.

/** First line of a commit message (subject). */
export function firstLine(message: string): string {
  const index = message.indexOf('\n');
  return index === -1 ? message : message.slice(0, index);
}

/** Short oid used in the row (git's default abbreviation length is 7). */
export function shortOidHex(hex: string | undefined, length = 7): string {
  if (!hex) return '·······';
  return hex.slice(0, length);
}

/** Deterministic `YYYY-MM-DD` date (contract timestamps are RFC3339/UTC). */
export function formatShortDate(iso: string): string {
  if (!iso) return '';
  const date = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : iso;
}

export type RefKind = 'head' | 'branch' | 'remote' | 'tag' | 'other';

/** Mainline branch names git conventionally uses; they take the mint `--st-color-ref-main` role. */
const MAINLINE_BRANCHES: readonly string[] = ['main', 'master'];

/** True when the branch name is the repository mainline (`main` / `master`). */
export function isMainlineBranch(name: string): boolean {
  return MAINLINE_BRANCHES.includes(name.trim().toLowerCase());
}

/**
 * Contract `RefLabel.kind` is a free-form string ("head" | "branch" | "remote" |
 * "tag"); normalize it so unknown kinds still render with a neutral style.
 */
export function normalizeRefKind(kind: string): RefKind {
  if (kind === 'head' || kind === 'branch' || kind === 'remote' || kind === 'tag') {
    return kind;
  }
  return 'other';
}

/** Author display name, falling back to the committer when the author is absent. */
export function authorName(name: string | undefined, fallback: string | undefined): string {
  return name ?? fallback ?? 'Unknown';
}
