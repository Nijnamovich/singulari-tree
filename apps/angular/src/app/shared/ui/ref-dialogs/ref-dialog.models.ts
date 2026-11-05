import type { AppError } from '@core/services/ipc-bridge.service';

/**
 * Wire form of the merge strategy (ADR-028).
 *
 * The Angular `@contracts/gitcore` enum is numeric, but the Electron preload
 * decodes proto enums with `enums: String`, so the value that actually crosses
 * IPC is the enum value name. Callers always name the strategy; there is no
 * default. `MERGE_STRATEGY_UNSPECIFIED` is rejected by the core and never sent.
 */
export type MergeStrategyName = 'MERGE' | 'NO_FF' | 'FF_ONLY' | 'SQUASH';

/** The ordered strategy options offered by the merge dialog. */
export const MERGE_STRATEGIES: readonly MergeStrategyName[] = ['MERGE', 'NO_FF', 'FF_ONLY', 'SQUASH'];

/** Submitted payload of the create-branch dialog. */
export interface BranchCreateValue {
  readonly name: string;
  /** Commit-ish to start the branch at (branch name, HEAD or an oid). */
  readonly startPoint: string;
  /** Switch the working tree to the new branch after creating it. */
  readonly checkout: boolean;
}

/** Submitted payload of the create-tag dialog. */
export interface TagCreateValue {
  readonly name: string;
  /** Commit-ish the tag points at (default HEAD; the clicked oid from the graph). */
  readonly target: string;
  readonly annotated: boolean;
  /** Required only when `annotated` is true. */
  readonly message: string;
  /** Move an existing tag of the same name. */
  readonly force: boolean;
}

/** Submitted payload of the merge dialog. */
export interface MergeValue {
  readonly ref: string;
  readonly strategy: MergeStrategyName;
  readonly noCommit: boolean;
  readonly message: string;
}

/** Submitted payload of the cherry-pick dialog (ADR-0042). */
export interface CherryPickValue {
  /** Bare revision: sha, short sha, branch, remote ref, tag or rev expression. */
  readonly source: string;
  /** `-x`: append the source commit reference to the new message. */
  readonly recordOrigin: boolean;
  /** `--no-commit`: leave the change staged instead of committing it. */
  readonly noCommit: boolean;
}

/** Shared error shape accepted by every ref dialog. */
export type RefDialogError = AppError | null;
