// View models and intents for the Git remote dialogs (Pull/Push/Fetch).
// Presentation-only: the renderer never talks to Git directly, these types
// describe what the dialogs collect before handing an intent to
// `RemoteOpsStore` (which crosses the IPC bridge). Intent fields mirror the
// camelCase `@contracts/gitcore` request messages.

/** Which remote dialog is currently open. */
export type RemoteDialogKind = 'pull' | 'push' | 'fetch';

/** Per-repository status of the renderer-orchestrated fetch (shown one repo at a time). */
export type RepoFetchState = 'pending' | 'success' | 'failed';

/** Progress reported by a remote operation (mirrors the contract `Progress`). */
export interface RemoteOpProgress {
  percent: number;
  message: string;
}

/** A selectable remote (name + primary URL) for the dialog pickers. */
export interface RemoteOption {
  name: string;
  url: string;
}

/**
 * A selectable remote branch: either a REAL remote-tracking branch
 * (`derivedFromUpstream:false`) or an upstream-derived fallback
 * (`derivedFromUpstream:true`).
 */
export interface RemoteBranchOption {
  name: string;
  refName: string;
  derivedFromUpstream: boolean;
}

/** One row of the Push dialog: a local branch and its default remote target. */
export interface PushRowView {
  localBranch: string;
  isCurrent: boolean;
  upstream: string;
  defaultRemoteBranch: string;
}

/** Per-row Push selection produced by the dialog. */
export interface PushRowSelection {
  localBranch: string;
  remoteBranch: string;
  track: boolean;
}

/**
 * Pull intent: pull `branch` from `remote`. Mirrors the `PullRequest` fields
 * the renderer can set; `intoLocalBranch` maps to the request's `localBranch`.
 */
export interface PullIntent {
  remote: string;
  branch: string;
  intoLocalBranch: string;
  /** When true, do not commit the merge (`--no-commit`). */
  noCommit: boolean;
  /** Include messages from the merged commits (`--log`). */
  log: boolean;
  /** Always create a merge commit (`--no-ff`). */
  noFf: boolean;
  /** Rebase instead of merging (`--rebase`). */
  rebase: boolean;
}

/** Push intent: push every selected row to `remote` with the shared options. */
export interface PushIntent {
  remote: string;
  branches: readonly PushRowSelection[];
  /** Push all tags (`--tags`). */
  tags: boolean;
  /** Force-push (`--force`). */
  force: boolean;
}

/** Fetch intent: either every remote, or a single one, plus the fetch options. */
export interface FetchIntent {
  allRemotes: boolean;
  remote: string;
  /** Prune deleted remote refs (`--prune`). */
  prune: boolean;
  /** Fetch all tags (`--tags`). */
  tags: boolean;
  /** Overwrite moved local tags (`--force`). */
  force: boolean;
}

const REMOTE_TRACKING_PREFIX = 'refs/remotes/';

/**
 * Split a remote-tracking ref such as `refs/remotes/origin/david/fix-x` into
 * `{ remote: 'origin', branch: 'david/fix-x' }`. Returns `null` for refs that
 * are not remote-tracking (local branches, tags, HEAD, empty, malformed).
 */
export function parseRemoteTracking(ref: string): { remote: string; branch: string } | null {
  if (!ref.startsWith(REMOTE_TRACKING_PREFIX)) return null;
  const rest = ref.slice(REMOTE_TRACKING_PREFIX.length);
  const separator = rest.indexOf('/');
  if (separator <= 0) return null;
  const remote = rest.slice(0, separator);
  const branch = rest.slice(separator + 1);
  if (!remote || !branch) return null;
  return { remote, branch };
}
