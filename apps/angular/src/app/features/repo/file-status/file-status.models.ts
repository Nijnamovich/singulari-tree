// Renderer view models for the "File Status" screen (local worktree / commit /
// PR variants). Types only: every shape crossing the IPC boundary comes from
// the generated contracts, so this module stays a pure type declaration file.

/** Which file-status variant the screen is showing. */
export type FileStatusVariant = 'local' | 'commit' | 'pr';

/** A branch resolved to a concrete oid, as the PR base/target. */
export interface ResolvedBaseRef {
  readonly name: string;
  readonly oid: string;
  readonly isRemote: boolean;
}
