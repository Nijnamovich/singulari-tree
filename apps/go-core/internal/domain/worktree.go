package domain

import "context"

// Worktree entity (domain-model.md §1.2).
type Worktree struct {
	FsPath string
	Branch *RefName
	Head   Oid
	IsMain bool
}

// WorktreePort is the Git port for worktrees.
type WorktreePort interface {
	List(ctx context.Context, repoID RepositoryId) ([]Worktree, error)
	Add(ctx context.Context, repoID RepositoryId, path string, branch *RefName) (*Worktree, error)
	Remove(ctx context.Context, repoID RepositoryId, path string) error
}
