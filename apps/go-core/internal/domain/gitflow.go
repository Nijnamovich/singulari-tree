package domain

import "context"

// GitFlowKind names a git-flow workflow branch kind (ADR-027). The zero value
// is invalid: callers must name a kind, mapping to the GitFlowKind enum on the
// wire.
type GitFlowKind int

const (
	GitFlowKindUnspecified GitFlowKind = iota
	GitFlowKindFeature
	GitFlowKindRelease
	GitFlowKindHotfix
)

// GitFlowConfig is the per-repo git-flow preset configuration (ADR-027). It is
// SQLite config metadata — never Git data.
type GitFlowConfig struct {
	MainBranch       string
	DevelopBranch    string
	FeaturePrefix    string
	ReleasePrefix    string
	HotfixPrefix     string
	VersionTagPrefix string
}

// DefaultGitFlowConfig returns the conventional git-flow defaults, also used
// when a repository has no stored configuration.
func DefaultGitFlowConfig() GitFlowConfig {
	return GitFlowConfig{
		MainBranch:       "main",
		DevelopBranch:    "develop",
		FeaturePrefix:    "feature/",
		ReleasePrefix:    "release/",
		HotfixPrefix:     "hotfix/",
		VersionTagPrefix: "v",
	}
}

// Prefix returns the branch prefix for a kind, or "" for an invalid kind.
func (c GitFlowConfig) Prefix(kind GitFlowKind) string {
	switch kind {
	case GitFlowKindFeature:
		return c.FeaturePrefix
	case GitFlowKindRelease:
		return c.ReleasePrefix
	case GitFlowKindHotfix:
		return c.HotfixPrefix
	default:
		return ""
	}
}

// GitFlowResult reports the outcome of a git-flow start/finish (ADR-027).
// HasConflict mirrors the ADR-028 merge semantics: on a conflict the sequence
// stops, the working tree is left conflicted and HasConflict is true.
type GitFlowResult struct {
	Branch      string
	Steps       []string
	HasConflict bool
}

// GitFlowConfigPort is the persistence port for per-repo git-flow config
// (ADR-027). Get returns the defaults for an unset repository rather than an
// error.
type GitFlowConfigPort interface {
	Get(ctx context.Context, repoID RepositoryId) (GitFlowConfig, error)
	Set(ctx context.Context, repoID RepositoryId, cfg GitFlowConfig) error
}

// Errors
var (
	// ErrGitFlowFailed marks an invalid git-flow request (unspecified kind,
	// empty name) or a git-flow orchestration failure.
	ErrGitFlowFailed = AppError{Code: ErrCodeGitFlowFailed, Message: "git-flow operation failed"}
)
