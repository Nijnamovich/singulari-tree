package service

import (
	"context"
	"errors"
	"strings"

	"github.com/SingulariTree/go-core/internal/domain"
)

// GitFlowService owns the git-flow workflow semantics (ADR-027) and orchestrates
// the ADR-028 Git operations (branch create/delete, checkout, merge, tag
// create). The renderer addresses a workflow by kind/name only; the core
// constructs the command sequence. Configuration is SQLite metadata (never Git
// data).
type GitFlowService struct {
	gitPort    domain.GitPort
	configPort domain.GitFlowConfigPort
}

// NewGitFlowService creates a GitFlowService. A nil configPort yields the
// conventional defaults.
func NewGitFlowService(gitPort domain.GitPort, configPort domain.GitFlowConfigPort) *GitFlowService {
	return &GitFlowService{gitPort: gitPort, configPort: configPort}
}

// Config returns the git-flow configuration for a repository, defaulting when
// unset. Empty stored fields also fall back to the defaults.
func (s *GitFlowService) Config(ctx context.Context, repoID domain.RepositoryId) (domain.GitFlowConfig, error) {
	if s.configPort == nil {
		return domain.DefaultGitFlowConfig(), nil
	}
	cfg, err := s.configPort.Get(ctx, repoID)
	if err != nil {
		return domain.GitFlowConfig{}, err
	}
	return normalizeGitFlowConfig(cfg), nil
}

// SetConfig stores the git-flow configuration for a repository. Empty fields
// fall back to the conventional defaults so a partial update never yields an
// unusable preset.
func (s *GitFlowService) SetConfig(ctx context.Context, repoID domain.RepositoryId, cfg domain.GitFlowConfig) (domain.GitFlowConfig, error) {
	if s.configPort == nil {
		return domain.DefaultGitFlowConfig(), nil
	}
	cfg = normalizeGitFlowConfig(cfg)
	if err := s.configPort.Set(ctx, repoID, cfg); err != nil {
		return domain.GitFlowConfig{}, err
	}
	return cfg, nil
}

// normalizeGitFlowConfig replaces empty fields with the conventional defaults.
func normalizeGitFlowConfig(cfg domain.GitFlowConfig) domain.GitFlowConfig {
	def := domain.DefaultGitFlowConfig()
	if strings.TrimSpace(cfg.MainBranch) == "" {
		cfg.MainBranch = def.MainBranch
	}
	if strings.TrimSpace(cfg.DevelopBranch) == "" {
		cfg.DevelopBranch = def.DevelopBranch
	}
	if cfg.FeaturePrefix == "" {
		cfg.FeaturePrefix = def.FeaturePrefix
	}
	if cfg.ReleasePrefix == "" {
		cfg.ReleasePrefix = def.ReleasePrefix
	}
	if cfg.HotfixPrefix == "" {
		cfg.HotfixPrefix = def.HotfixPrefix
	}
	if cfg.VersionTagPrefix == "" {
		cfg.VersionTagPrefix = def.VersionTagPrefix
	}
	return cfg
}

// resolveName strips the kind's configured prefix from name so a caller may send
// either "login" or "feature/login"; an empty result is rejected.
func resolveName(name, prefix string) (string, error) {
	name = strings.TrimSpace(name)
	if prefix != "" {
		name = strings.TrimPrefix(name, prefix)
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return "", domain.ErrGitFlowFailed.WithDetail("reason", "name is required")
	}
	return name, nil
}

// Start creates and checks out a workflow branch (ADR-027):
//
//	FEATURE -> <feature_prefix><name> off develop (or base)
//	RELEASE -> <release_prefix><name> off develop (or base)
//	HOTFIX  -> <hotfix_prefix><name>  off main (or base)
func (s *GitFlowService) Start(ctx context.Context, repoID domain.RepositoryId, kind domain.GitFlowKind, name, base string) (*domain.GitFlowResult, error) {
	if s.gitPort == nil {
		return nil, domain.ErrGitFlowFailed.WithDetail("reason", "git not configured")
	}
	if !validGitFlowKind(kind) {
		return nil, domain.ErrGitFlowFailed.WithDetail("reason", "kind is required")
	}
	cfg, err := s.Config(ctx, repoID)
	if err != nil {
		return nil, err
	}
	resolved, err := resolveName(name, cfg.Prefix(kind))
	if err != nil {
		return nil, err
	}
	baseBranch, _ := gitFlowBaseBranch(kind, cfg)
	if b := strings.TrimSpace(base); b != "" {
		baseBranch = b
	}
	branch := cfg.Prefix(kind) + resolved

	steps := make([]string, 0, 2)
	if err := s.gitPort.Checkout(ctx, repoID, domain.RefName{Raw: baseBranch}, false, false); err != nil {
		return nil, err
	}
	steps = append(steps, "checkout "+baseBranch)

	if _, err := s.gitPort.BranchCreate(ctx, repoID, branch, baseBranch, true); err != nil {
		return nil, err
	}
	steps = append(steps, "create "+branch)

	return &domain.GitFlowResult{Branch: branch, Steps: steps}, nil
}

// Finish integrates and cleans up a workflow branch (ADR-027):
//
//	FEATURE -> checkout develop, merge <feature> (no-ff), delete branch
//	RELEASE -> checkout main, merge <release>, tag, checkout develop, merge, delete
//	HOTFIX  -> same shape as release, off main
//
// On a merge conflict the sequence stops, the working tree is left conflicted,
// HasConflict is set and the typed MERGE_CONFLICT error is returned alongside a
// non-nil result (consistent with ADR-028).
func (s *GitFlowService) Finish(ctx context.Context, repoID domain.RepositoryId, kind domain.GitFlowKind, name string, deleteBranch bool) (*domain.GitFlowResult, error) {
	if s.gitPort == nil {
		return nil, domain.ErrGitFlowFailed.WithDetail("reason", "git not configured")
	}
	if !validGitFlowKind(kind) {
		return nil, domain.ErrGitFlowFailed.WithDetail("reason", "kind is required")
	}
	cfg, err := s.Config(ctx, repoID)
	if err != nil {
		return nil, err
	}
	resolved, err := resolveName(name, cfg.Prefix(kind))
	if err != nil {
		return nil, err
	}
	branch := cfg.Prefix(kind) + resolved

	steps := make([]string, 0, 6)
	st := &domain.GitFlowResult{Branch: branch}

	switch kind {
	case domain.GitFlowKindFeature:
		if err := s.checkout(ctx, repoID, cfg.DevelopBranch, &steps, st); err != nil {
			return st, err
		}
		if err := s.merge(ctx, repoID, branch, &steps, st); err != nil {
			return st, err
		}
	case domain.GitFlowKindRelease, domain.GitFlowKindHotfix:
		if err := s.checkout(ctx, repoID, cfg.MainBranch, &steps, st); err != nil {
			return st, err
		}
		if err := s.merge(ctx, repoID, branch, &steps, st); err != nil {
			return st, err
		}
		tag := cfg.VersionTagPrefix + resolved
		if _, err := s.gitPort.TagCreate(ctx, repoID, tag, "", true, "", false); err != nil {
			return st, err
		}
		steps = append(steps, "tag "+tag)

		if err := s.checkout(ctx, repoID, cfg.DevelopBranch, &steps, st); err != nil {
			return st, err
		}
		if err := s.merge(ctx, repoID, branch, &steps, st); err != nil {
			return st, err
		}
	default:
		return nil, domain.ErrGitFlowFailed.WithDetail("reason", "kind is required")
	}

	if deleteBranch {
		if err := s.gitPort.BranchDelete(ctx, repoID, domain.RefName{Raw: branch}, false); err != nil {
			return st, err
		}
		steps = append(steps, "delete "+branch)
	}
	st.Steps = steps
	return st, nil
}

// checkout performs a workflow checkout and records the step.
func (s *GitFlowService) checkout(ctx context.Context, repoID domain.RepositoryId, branch string, steps *[]string, st *domain.GitFlowResult) error {
	if err := s.gitPort.Checkout(ctx, repoID, domain.RefName{Raw: branch}, false, false); err != nil {
		return err
	}
	*steps = append(*steps, "checkout "+branch)
	st.Steps = *steps
	return nil
}

// merge merges branch with --no-ff, recording the step. A conflict stops the
// sequence and is surfaced as HasConflict plus MERGE_CONFLICT.
func (s *GitFlowService) merge(ctx context.Context, repoID domain.RepositoryId, branch string, steps *[]string, st *domain.GitFlowResult) error {
	*steps = append(*steps, "merge "+branch)
	st.Steps = *steps
	if _, err := s.gitPort.Merge(ctx, repoID, branch, domain.MergeStrategyNoFF, false, ""); err != nil {
		var appErr domain.AppError
		if errors.As(err, &appErr) && appErr.Code == domain.ErrCodeMergeConflict {
			st.HasConflict = true
			return err
		}
		return err
	}
	return nil
}

// validGitFlowKind reports whether kind is a concrete git-flow kind rather than
// the unspecified zero value.
func validGitFlowKind(kind domain.GitFlowKind) bool {
	return kind == domain.GitFlowKindFeature ||
		kind == domain.GitFlowKindRelease ||
		kind == domain.GitFlowKindHotfix
}

// gitFlowBaseBranch returns the conventional base branch for a kind and whether
// the kind is specified. Feature/release branch off develop; hotfix off main.
func gitFlowBaseBranch(kind domain.GitFlowKind, cfg domain.GitFlowConfig) (string, bool) {
	switch kind {
	case domain.GitFlowKindFeature, domain.GitFlowKindRelease:
		return cfg.DevelopBranch, true
	case domain.GitFlowKindHotfix:
		return cfg.MainBranch, true
	default:
		return "", false
	}
}
