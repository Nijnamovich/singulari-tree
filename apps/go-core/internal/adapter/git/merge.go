package git

import (
	"context"
	"strings"

	"github.com/SingulariTree/go-core/internal/domain"
)

// mergeFailed builds a typed MERGE_FAILED error with a short, bounded message.
func mergeFailed(message string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeMergeFailed,
		Message: truncateValidUTF8(strings.TrimSpace(message), maxCheckoutErrLen),
	}
}

// mergeFailedFromGit builds the MERGE_FAILED error for a failed `git merge`: a
// short summary plus the bounded raw text for diagnostics.
func mergeFailedFromGit(rawErr string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeMergeFailed,
		Message: shortGitSummaryWithFallback(rawErr, "git merge failed"),
		Details: map[string]string{"raw": boundCheckoutRaw(rawErr)},
	}
}

// isMergeConflict reports whether a failed `git merge` produced conflict
// markers rather than a plain failure. git writes "CONFLICT (...)" lines to
// stdout and "Automatic merge failed; fix conflicts..." to stderr.
func isMergeConflict(stdout, rawErr string) bool {
	return strings.Contains(stdout, "CONFLICT") ||
		strings.Contains(rawErr, "CONFLICT") ||
		strings.Contains(rawErr, "fix conflicts")
}

// headOidDomain resolves HEAD to a domain Oid (zero Oid when HEAD is unborn or
// unreadable). It is a best-effort read used to populate MergeResult.Oid.
func (a *Adapter) headOidDomain(ctx context.Context, fsPath string) domain.Oid {
	out, err := runGit(ctx, fsPath, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return domain.Oid{}
	}
	oid, oerr := domain.NewOid(strings.TrimSpace(out))
	if oerr != nil {
		return domain.Oid{}
	}
	return oid
}

// Merge integrates ref into the current branch via `git merge`. The strategy
// selects the flags (MERGE -> --no-edit; NO_FF -> --no-ff; FF_ONLY -> --ff-only;
// SQUASH -> --squash); no_commit adds --no-commit and a non-empty message
// overrides the default commit message with -m.
//
// A conflict exits non-zero with CONFLICT output: the working tree is left in
// the conflicted state (so Status reports is_conflicted and Diff reports
// has_conflict_markers) and the method returns a MergeResult with
// HasConflict:true together with a typed MERGE_CONFLICT error. Any other
// failure yields MERGE_FAILED. MERGE_STRATEGY_UNSPECIFIED is rejected.
func (a *Adapter) Merge(ctx context.Context, repoID domain.RepositoryId, ref string, strategy domain.MergeStrategy, noCommit bool, message string) (*domain.MergeResult, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	ref = strings.TrimSpace(ref)
	if ref == "" || !checkSafeArg(ref) {
		return nil, mergeFailed("invalid ref")
	}

	args := []string{"merge"}
	switch strategy {
	case domain.MergeStrategyMerge:
		args = append(args, "--no-edit")
	case domain.MergeStrategyNoFF:
		args = append(args, "--no-ff", "--no-edit")
	case domain.MergeStrategyFFOnly:
		args = append(args, "--ff-only")
	case domain.MergeStrategySquash:
		args = append(args, "--squash")
	default:
		return nil, mergeFailed("merge strategy is required")
	}
	if noCommit {
		args = append(args, "--no-commit")
	}
	if msg := strings.TrimSpace(message); msg != "" {
		args = append(args, "-m", msg)
	}
	args = append(args, ref)

	out, code, err := runGitAllowExit(ctx, fsPath, args...)
	if err != nil {
		raw := err.Error()
		if code != 0 && isMergeConflict(out, raw) {
			return &domain.MergeResult{
					Oid:         a.headOidDomain(ctx, fsPath),
					HasConflict: true,
				},
				domain.ErrMergeConflict.WithDetail("raw", boundCheckoutRaw(raw))
		}
		return nil, mergeFailedFromGit(raw)
	}
	return &domain.MergeResult{Oid: a.headOidDomain(ctx, fsPath)}, nil
}
