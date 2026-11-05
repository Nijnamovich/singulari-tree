package domain

import "context"

// Stash entity — stack entry (domain-model.md §1.2).
type Stash struct {
	Index      int
	Oid        Oid
	Message    string
	BranchName *string
}

// StashPort is the Git port for stash.
type StashPort interface {
	List(ctx context.Context, repoID RepositoryId) ([]Stash, error)
	Push(ctx context.Context, repoID RepositoryId, message string) (*Stash, error)
	// Apply maps to `git stash apply [--index] stash@{N}`; restoreIndex selects
	// --index (reapply the staged state too).
	Apply(ctx context.Context, repoID RepositoryId, index int, restoreIndex bool) error
	Pop(ctx context.Context, repoID RepositoryId, index int) error
	Drop(ctx context.Context, repoID RepositoryId, index int) error
}
