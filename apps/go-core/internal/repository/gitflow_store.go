package repository

import (
	"context"
	"database/sql"
	"errors"

	"github.com/SingulariTree/go-core/internal/domain"
)

// GitFlowStore is the SQLite-backed implementation of domain.GitFlowConfigPort
// (ADR-027). It persists git-flow preset configuration only; no Git data is
// ever written.
type GitFlowStore struct {
	db *sql.DB
}

var _ domain.GitFlowConfigPort = (*GitFlowStore)(nil)

// NewGitFlowStore creates a GitFlowStore over an opened SQLite database.
// ApplyMigrations must have been called before use.
func NewGitFlowStore(db *sql.DB) *GitFlowStore {
	return &GitFlowStore{db: db}
}

// Get returns the stored git-flow configuration for a repository, or the
// conventional defaults when none has been persisted (never an error for an
// unset repo, ADR-027).
func (s *GitFlowStore) Get(ctx context.Context, repoID domain.RepositoryId) (domain.GitFlowConfig, error) {
	var cfg domain.GitFlowConfig
	err := s.db.QueryRowContext(ctx,
		`SELECT main_branch, develop_branch, feature_prefix,
		        release_prefix, hotfix_prefix, version_tag_prefix
		 FROM git_flow_config WHERE repo_id = ?`, string(repoID),
	).Scan(
		&cfg.MainBranch, &cfg.DevelopBranch, &cfg.FeaturePrefix,
		&cfg.ReleasePrefix, &cfg.HotfixPrefix, &cfg.VersionTagPrefix,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.DefaultGitFlowConfig(), nil
	}
	if err != nil {
		return domain.GitFlowConfig{}, err
	}
	return cfg, nil
}

// Set upserts the git-flow configuration for a repository.
func (s *GitFlowStore) Set(ctx context.Context, repoID domain.RepositoryId, cfg domain.GitFlowConfig) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO git_flow_config (
			repo_id, main_branch, develop_branch, feature_prefix,
			release_prefix, hotfix_prefix, version_tag_prefix
		 ) VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(repo_id) DO UPDATE SET
			main_branch        = excluded.main_branch,
			develop_branch     = excluded.develop_branch,
			feature_prefix     = excluded.feature_prefix,
			release_prefix     = excluded.release_prefix,
			hotfix_prefix      = excluded.hotfix_prefix,
			version_tag_prefix = excluded.version_tag_prefix`,
		string(repoID), cfg.MainBranch, cfg.DevelopBranch, cfg.FeaturePrefix,
		cfg.ReleasePrefix, cfg.HotfixPrefix, cfg.VersionTagPrefix,
	)
	return err
}
