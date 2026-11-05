package domain

import "context"

// SequencerResult reports the outcome of a cherry-pick or revert (ADR-0042).
// The shape mirrors MergeResult: on conflict the working tree is intentionally
// left in the conflicted state (HasConflict true) with CHERRY_PICK_HEAD /
// REVERT_HEAD still present, so a subsequent Status read surfaces
// is_conflicted and a Diff read surfaces has_conflict_markers.
type SequencerResult struct {
	// Oid is HEAD after the operation (the picked/reverted commit, or the
	// unchanged HEAD for --no-commit and for a conflict); empty when it could
	// not be resolved.
	Oid         Oid
	HasConflict bool
}

// SequencerPort is the Git port for cherry-pick, revert and read-only revision
// resolution (ADR-0042). Mutations take ONE revision string and resolve it to a
// commit inside the core; the caller never sends a flag or a command.
type SequencerPort interface {
	// CherryPick maps to `git cherry-pick [-x] [--no-commit] <source>`;
	// recordOrigin maps to -x and noCommit to --no-commit.
	CherryPick(ctx context.Context, repoID RepositoryId, source string, recordOrigin, noCommit bool) (*SequencerResult, error)
	// Revert maps to `git revert --no-edit <source>`.
	Revert(ctx context.Context, repoID RepositoryId, source string) (*SequencerResult, error)
	// ResolveRevision resolves a revision (sha, short sha, branch, tag or rev
	// expression) to its commit without mutating anything.
	ResolveRevision(ctx context.Context, repoID RepositoryId, revision string) (*Commit, error)
}
