// Re-export the generated contract domain types (types-only, erased at build time).
// `export type` / `import type` keep the generated `@contracts` modules free of any
// runtime dependency, so Angular code gets the wire-accurate shapes for free.

export type {
  Commit,
  Oid,
  Signature,
  Branch,
  Remote,
  Tag,
  Stash,
  Worktree,
  Repository,
  FileStatus,
  Diff,
  Lane,
  RefLabel,
} from '@contracts/domain';

import type { Commit, Lane, RefLabel } from '@contracts/domain';

// Angular-only view model: a commit joined with its Go-computed lane (ADR-008)
// and the ref decorations pointing at it. Presentation-only, no extra state.
export interface CommitRow {
  commit: Commit;
  lane: Lane;
  refs: RefLabel[];
  isHead: boolean;
}
