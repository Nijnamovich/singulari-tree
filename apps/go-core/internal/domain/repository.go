package domain

import (
	"context"
	"path/filepath"
	"time"
)

// RepositoryId is a local UUID v4 identifying a tracked repository.
type RepositoryId string

// Repository is the aggregate root. See domain-model.md §1.1.
type Repository struct {
	ID           RepositoryId
	FsPath       string // absolute, normalized
	CommonDir    string // git common dir (worktree-aware)
	Name         string
	CreatedAt    time.Time
	LastOpenedAt time.Time
}

// NewRepository validates and creates a Repository.
func NewRepository(id RepositoryId, fsPath, commonDir, name string) (Repository, error) {
	if fsPath == "" {
		return Repository{}, AppError{Code: ErrCodeRepoNotFound, Message: "fs_path is required"}
	}
	abs, err := filepath.Abs(filepath.Clean(fsPath))
	if err != nil {
		return Repository{}, AppError{Code: ErrCodeRepoNotFound, Message: "invalid fs_path", Details: map[string]string{"fs_path": fsPath}}
	}
	if commonDir == "" {
		commonDir = filepath.Join(abs, ".git")
	}
	if name == "" {
		name = filepath.Base(abs)
	}
	now := time.Now().UTC()
	return Repository{
		ID:           id,
		FsPath:       abs,
		CommonDir:    commonDir,
		Name:         name,
		CreatedAt:    now,
		LastOpenedAt: now,
	}, nil
}

// RepoPort is the persistence port for repositories.
type RepoPort interface {
	Open(ctx context.Context, fsPath string) (*Repository, error)
	List(ctx context.Context) ([]Repository, error)
	Remove(ctx context.Context, id RepositoryId) error
	Get(ctx context.Context, id RepositoryId) (*Repository, error)
	// Relocate repoints an existing registration at fsPath, preserving the
	// repository id and created_at and refreshing common_dir. It deliberately
	// keeps the id: a delete + re-create would mint a new id and drop the cached
	// rows, silently losing the registration.
	Relocate(ctx context.Context, id RepositoryId, fsPath string) (*Repository, error)
}

// Domain errors (same-file constants per backend/docs/context/architecture.md)
var (
	ErrRepoNotFound    = AppError{Code: ErrCodeRepoNotFound, Message: "repository not found"}
	ErrNotAGitRepo     = AppError{Code: ErrCodeNotAGitRepo, Message: "not a git repository"}
	ErrRepoPathMissing = AppError{Code: ErrCodeRepoPathMissing, Message: "repository path not found"}
	ErrRepoPathInUse   = AppError{Code: ErrCodeRepoPathInUse, Message: "repository path already tracked"}
)
