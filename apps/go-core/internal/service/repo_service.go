package service

import (
	"context"
	"errors"
	"io/fs"
	"os"

	"github.com/SingulariTree/go-core/internal/domain"
)

// RepoService manages tracked repositories (service-design.md §1.1).
type RepoService struct {
	repoPort domain.RepoPort
	gitPort  domain.GitPort
}

// NewRepoService creates a RepoService.
func NewRepoService(repoPort domain.RepoPort, gitPort domain.GitPort) *RepoService {
	return &RepoService{repoPort: repoPort, gitPort: gitPort}
}

// Open validates that fsPath is a git repo and tracks it.
//
// Validation runs through the Git port (git rev-parse --show-toplevel /
// --git-common-dir) before anything is persisted, so a non-repo path yields
// ErrNotAGitRepo instead of a bogus repository record. The resolved top-level
// directory is used as the persisted path (worktree/subdirectory-safe).
//
// A genuinely absent path is reported as ErrRepoPathMissing instead: "the
// recorded folder is gone" is a different operator problem from "the folder
// exists but is not a Git repository". Only fs.ErrNotExist maps to missing — a
// permission (or other stat) error leaves the path falling through to Resolve,
// which reports ErrNotAGitRepo.
func (s *RepoService) Open(ctx context.Context, fsPath string) (*domain.Repository, error) {
	if s.repoPort == nil || s.gitPort == nil {
		return nil, domain.ErrNotAGitRepo.WithDetail("fs_path", fsPath)
	}
	if _, err := os.Stat(fsPath); err != nil && errors.Is(err, fs.ErrNotExist) {
		return nil, domain.ErrRepoPathMissing.WithDetail("fs_path", fsPath)
	}
	topLevel, _, err := s.gitPort.Resolve(ctx, fsPath)
	if err != nil {
		return nil, domain.ErrNotAGitRepo.WithDetail("fs_path", fsPath)
	}
	return s.repoPort.Open(ctx, topLevel)
}

// Relocate repoints an existing repository registration at fsPath, validating
// the record and the target before the stored path changes.
//
// The registration id is preserved end-to-end: the renderer must repoint rather
// than delete + re-create, which would mint a new id and drop the cached rows.
// Order mirrors the requirement: unknown id → ErrRepoNotFound, missing target →
// ErrRepoPathMissing, existing-but-not-a-repo target → ErrNotAGitRepo (the same
// Git-port resolution Open performs), then the port repoints at the resolved
// top-level.
func (s *RepoService) Relocate(ctx context.Context, id domain.RepositoryId, fsPath string) (*domain.Repository, error) {
	if s.repoPort == nil || s.gitPort == nil {
		return nil, domain.ErrRepoNotFound
	}
	repo, err := s.repoPort.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if repo == nil {
		return nil, domain.ErrRepoNotFound
	}
	if _, err := os.Stat(fsPath); err != nil && errors.Is(err, fs.ErrNotExist) {
		return nil, domain.ErrRepoPathMissing.WithDetail("fs_path", fsPath)
	}
	topLevel, _, err := s.gitPort.Resolve(ctx, fsPath)
	if err != nil {
		return nil, domain.ErrNotAGitRepo.WithDetail("fs_path", fsPath)
	}
	return s.repoPort.Relocate(ctx, id, topLevel)
}

// Get returns a tracked repository by ID.
func (s *RepoService) Get(ctx context.Context, id domain.RepositoryId) (*domain.Repository, error) {
	if s.repoPort == nil {
		return nil, domain.ErrRepoNotFound
	}
	return s.repoPort.Get(ctx, id)
}

// List returns tracked repositories.
func (s *RepoService) List(ctx context.Context) ([]domain.Repository, error) {
	if s.repoPort == nil {
		return nil, nil
	}
	return s.repoPort.List(ctx)
}

// Remove untracks a repository.
func (s *RepoService) Remove(ctx context.Context, id domain.RepositoryId) error {
	if s.repoPort == nil {
		return domain.ErrRepoNotFound
	}
	return s.repoPort.Remove(ctx, id)
}

// Resolve returns fsPath for a repository ID.
func (s *RepoService) Resolve(ctx context.Context, id domain.RepositoryId) (string, error) {
	if s.repoPort == nil {
		return "", domain.ErrRepoNotFound
	}
	repo, err := s.repoPort.Get(ctx, id)
	if err != nil {
		return "", err
	}
	if repo == nil {
		return "", domain.ErrRepoNotFound
	}
	return repo.FsPath, nil
}
