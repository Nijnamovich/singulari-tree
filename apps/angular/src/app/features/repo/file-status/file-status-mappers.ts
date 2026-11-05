import type { Branch, Diff, FileDiff } from '@contracts/domain';
import type { ResolvedBaseRef } from './file-status.models';

// Pure, Angular-free mapping from the `getBranches`/`getDiff` contract responses
// to the renderer view model. Keeping it free of Angular (and of any runtime
// `@contracts` import) makes it trivially unit-testable with plain vitest.

/** Branches tried, in order, as the default PR base before any heuristic. */
const PREFERRED_BASES: readonly string[] = ['main', 'master'];

function oidHex(branch: Branch): string | null {
  return branch.tip?.hex ?? null;
}

/**
 * Lift one file section of a whole-repository diff into a synthetic single-file
 * `Diff`.
 *
 * `DiffViewer` (`libs/ui-kit`) reads ONLY `diff.hunks`, `diff.isBinary` and
 * `diff.hasConflictMarkers` — it cannot read `Diff.files`. So the selected file
 * must be re-shaped into a `Diff`-scoped object for the viewer to render it;
 * this keeps `DiffViewer` reusable completely unchanged.
 *
 * Returns `null` when there is nothing to show (no diff, no path, or the path is
 * not part of the diff). A renamed file resolves by its NEW path: `oldPath` is
 * never matched, because that is the path the viewer is addressing.
 */
export function toSingleFileDiff(diff: Diff | null | undefined, path: string | null): Diff | null {
  if (!diff || !path) return null;
  const file = diff.files?.find((candidate) => candidate.path === path);
  if (!file) return null;

  return {
    from: diff.from,
    to: diff.to,
    hunks: file.hunks ?? [],
    additions: file.additions,
    deletions: file.deletions,
    isBinary: file.isBinary,
    hasConflictMarkers: file.hasConflictMarkers,
    files: [file],
    truncated: diff.truncated,
  };
}

function toResolvedRef(branch: Branch): ResolvedBaseRef {
  return { name: branch.name, oid: oidHex(branch) ?? '', isRemote: branch.isRemote };
}

/** True when a remote-tracking name/short name/full ref ends with `/pref`. */
function matchesRemoteRef(branch: Branch, pref: string): boolean {
  return (
    branch.name === pref || branch.name.endsWith('/' + pref) || (branch.refName?.endsWith('/' + pref) ?? false)
  );
}

/**
 * Resolve the default PR base to a concrete branch.
 *
 * Preferred local names win over remote-tracking ones (a stale `origin/main`
 * must never shadow the local `main`); after every preferred name is exhausted
 * the fallbacks are, in order: the current local branch, the first local branch,
 * then the first remote-tracking branch. Branches without a tip (an unborn or
 * unresolved ref) are never selectable. Returns `null` when there is nothing
 * resolvable at all.
 */
export function resolveBaseRef(
  branches: readonly Branch[],
  preferred: readonly string[] = PREFERRED_BASES,
): ResolvedBaseRef | null {
  if (!branches || branches.length === 0) return null;

  for (const pref of preferred) {
    const local = branches.find((b) => !b.isRemote && b.name === pref && !!oidHex(b));
    if (local) return toResolvedRef(local);

    const remote = branches.find((b) => b.isRemote && matchesRemoteRef(b, pref) && !!oidHex(b));
    if (remote) return toResolvedRef(remote);
  }

  const current = branches.find((b) => !b.isRemote && b.isCurrent && !!oidHex(b));
  if (current) return toResolvedRef(current);

  const firstLocal = branches.find((b) => !b.isRemote && !!oidHex(b));
  if (firstLocal) return toResolvedRef(firstLocal);

  const firstRemote = branches.find((b) => b.isRemote && !!oidHex(b));
  return firstRemote ? toResolvedRef(firstRemote) : null;
}

/**
 * Resolve any ref display name (a base override or a PR target picked in a
 * `<select>`) to its oid hex. Local refs match exactly; remote-tracking refs
 * match on their name or on any `/`-terminated ref suffix, so `main` resolves
 * `origin/main`. Surrounding whitespace is trimmed. Returns `null` when the
 * ref is unknown or carries no tip.
 */
export function findRefOid(branches: readonly Branch[], refName: string): string | null {
  const needle = refName.trim();
  if (!needle) return null;

  const local = branches.find((b) => !b.isRemote && b.name === needle && !!oidHex(b));
  if (local) return oidHex(local);

  const remote = branches.find((b) => b.isRemote && matchesRemoteRef(b, needle) && !!oidHex(b));
  return remote ? oidHex(remote) : null;
}

/**
 * Count-only summary of a diff (header line of the commit/PR variants). Counts
 * are read straight from the payload: the core already aggregated them, and
 * re-deriving them per file here would duplicate that work.
 */
export function commitChangeSummary(diff: Diff | null | undefined): {
  filesChanged: number;
  additions: number;
  deletions: number;
} {
  return {
    filesChanged: diff?.files?.length ?? 0,
    additions: diff?.additions ?? 0,
    deletions: diff?.deletions ?? 0,
  };
}
