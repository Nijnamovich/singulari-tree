package domain

import (
	"context"
	"strings"
)

// RefName is a Git ref name value object (e.g. refs/heads/main, HEAD).
type RefName struct {
	Raw string
}

// Short returns short name (e.g. main from refs/heads/main, origin/main from refs/remotes/origin/main).
func (r RefName) Short() string {
	s := r.Raw
	if s == "HEAD" {
		return "HEAD"
	}
	for _, prefix := range []string{"refs/heads/", "refs/remotes/", "refs/tags/"} {
		if strings.HasPrefix(s, prefix) {
			return strings.TrimPrefix(s, prefix)
		}
	}
	return s
}

// Branch entity (domain-model.md §1.2).
type Branch struct {
	Name      string
	RefName   RefName
	Tip       Oid
	Upstream  *RefName
	IsCurrent bool
	IsRemote  bool
	// Behind is the pull-pending count: the number of commits on the branch's
	// configured upstream that are not present in this branch (git's
	// `%(upstream:track)` "behind N"). It is > 0 only for local branches with a
	// configured upstream; remote-tracking refs and detached/unborn HEAD are 0.
	Behind int32
}

// BranchPort is the Git port for branches.
type BranchPort interface {
	List(ctx context.Context, repoID RepositoryId) ([]Branch, error)
	// Create creates a local branch from startPoint (empty means HEAD). When
	// checkout is true the new branch is switched to. Maps to
	// `git branch <name> [<startPoint>]` (+ `git checkout <name>`).
	Create(ctx context.Context, repoID RepositoryId, name, startPoint string, checkout bool) (*Branch, error)
	// Rename maps to `git branch -m <oldName> <newName>`.
	Rename(ctx context.Context, repoID RepositoryId, oldName, newName string) (*Branch, error)
	// Delete maps to `git branch -d|-D <name>`; force selects -D.
	Delete(ctx context.Context, repoID RepositoryId, ref RefName, force bool) error
	Checkout(ctx context.Context, repoID RepositoryId, ref RefName) error
}

// Errors
var (
	ErrBranchNotFound = AppError{Code: ErrCodeBranchNotFound, Message: "branch not found"}
	ErrBranchExists   = AppError{Code: ErrCodeBranchExists, Message: "branch already exists"}
	ErrDetachedHead   = AppError{Code: ErrCodeDetachedHead, Message: "detached HEAD"}
)
