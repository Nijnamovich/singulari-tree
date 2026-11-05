import type { RefLabel } from '@contracts/domain';
import { shortOidHex } from '@singularitree/ui-kit';

/**
 * Wire form of the reset mode (ADR-0021).
 *
 * The Angular `@contracts/gitcore` enum is numeric, but the Electron preload
 * decodes proto enums with `enums: String`, so the value that actually crosses
 * IPC is the enum value name. Callers always name the mode; there is no default.
 */
export type ResetModeName = 'SOFT' | 'MIXED' | 'HARD';

/** The commit a graph context menu was opened for. */
export interface GraphContextMenuTarget {
  readonly oid: string;
  /** Ref decorations attached to the commit (may be empty). */
  readonly refs: readonly RefLabel[];
}

/** Resolved checkout target for a commit: a branch/remote ref, or a detached oid. */
export interface CheckoutTarget {
  /** Ref to hand to `checkout`: a display name or the raw oid hex. */
  readonly refName: string;
  /** Remote-tracking refs are resolved through `RepoState.remoteRefByName`. */
  readonly isRemote: boolean;
  /** Human-readable label shown in the menu entry. */
  readonly label: string;
}

/**
 * Repo screen the context menu can route to (ADR-0029).
 *
 * Additive union: every entry names a child route of the repo route. The menu
 * emits the target and the owning page decides what to do with it, so the menu
 * stays a dumb presentation component.
 */
export type GraphContextMenuScreenTarget = 'file-status';

/**
 * Pick the ref to check out for a commit (ADR-0022):
 * a local branch (head/branch) wins, then a remote-tracking branch, and only
 * when neither exists does the commit itself become a detached-HEAD target.
 */
export function checkoutTargetFor(target: GraphContextMenuTarget): CheckoutTarget {
  const local = target.refs.find((ref) => ref.kind === 'head' || ref.kind === 'branch');
  if (local) return { refName: local.name, isRemote: false, label: local.name };

  const remote = target.refs.find((ref) => ref.kind === 'remote');
  if (remote) return { refName: remote.name, isRemote: true, label: remote.name };

  return { refName: target.oid, isRemote: false, label: shortOidHex(target.oid) };
}
