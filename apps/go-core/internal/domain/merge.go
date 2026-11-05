package domain

import "context"

// MergeStrategy names the git merge strategy (ADR-028). The zero value is
// invalid: callers must name a strategy, mapping to the MergeStrategy enum on
// the wire.
type MergeStrategy int

const (
	MergeStrategyUnspecified MergeStrategy = iota
	MergeStrategyMerge
	MergeStrategyNoFF
	MergeStrategyFFOnly
	MergeStrategySquash
)

// MergeResult reports the outcome of a merge (ADR-028). On conflict the working
// tree is intentionally left in the conflicted state (HasConflict true) so a
// subsequent Status read surfaces is_conflicted and a Diff read surfaces
// has_conflict_markers; the conflict editor is out of M3 scope.
type MergeResult struct {
	// Oid is the resulting HEAD oid (the new merge commit, or the unchanged
	// HEAD for --no-commit/--squash); empty when it could not be resolved.
	Oid         Oid
	HasConflict bool
}

// MergePort is the Git port for merges (ADR-028).
type MergePort interface {
	Merge(ctx context.Context, repoID RepositoryId, ref string, strategy MergeStrategy, noCommit bool, message string) (*MergeResult, error)
}
