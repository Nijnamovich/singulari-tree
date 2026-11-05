package git

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/SingulariTree/go-core/internal/domain"
)

// errPathEscapesRoot guards file removal against a path that resolves outside
// the repository root.
var errPathEscapesRoot = errors.New("path escapes repository root")

// Discard reverts file-level changes (ADR-0020). Tracked paths are restored from
// HEAD (index and worktree together); a path tracked only in the index (a newly
// `git add`-ed file) is unstaged and its worktree copy removed; untracked paths
// are removed. This is the only discard that accepts untracked paths — hunk
// discard never does. Paths travel literally (`--literal-pathspecs`).
func (a *Adapter) Discard(ctx context.Context, repoID domain.RepositoryId, paths []string) error {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return err
	}
	if len(paths) == 0 {
		return nil
	}
	for _, p := range paths {
		if !validPathArg(p) {
			return discardFailed("invalid path")
		}
	}
	for _, p := range paths {
		if a.pathTracked(ctx, fsPath, p) {
			if _, err := runGit(ctx, fsPath, "--literal-pathspecs", "checkout", "HEAD", "--", p); err != nil {
				// Not present in HEAD (newly added): unstage and remove the
				// worktree copy instead.
				if _, rmErr := runGit(ctx, fsPath, "--literal-pathspecs", "rm", "--cached", "-r", "--", p); rmErr != nil {
					return discardFailedFromGit(rmErr.Error())
				}
				if rerr := removeWorktreePath(fsPath, p); rerr != nil {
					return discardFailed("could not remove " + p)
				}
			}
			continue
		}
		if err := removeWorktreePath(fsPath, p); err != nil {
			return discardFailed("could not remove " + p)
		}
	}
	return nil
}

// pathTracked reports whether path is tracked in the index.
func (a *Adapter) pathTracked(ctx context.Context, fsPath, path string) bool {
	_, code, err := runGitAllowExit(ctx, fsPath, "--literal-pathspecs", "ls-files", "--error-unmatch", "--", path)
	return err == nil && code == 0
}

// removeWorktreePath removes an untracked file (or directory) below root,
// refusing any path that resolves outside the repository root. The lexical
// check is the first line of defense; a symlink-aware check runs as
// defense-in-depth before anything is removed.
func removeWorktreePath(root, rel string) error {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	target := filepath.Join(rootAbs, filepath.FromSlash(rel))
	targetAbs, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	relToRoot, err := filepath.Rel(rootAbs, targetAbs)
	if err != nil || relToRoot == ".." || strings.HasPrefix(relToRoot, ".."+string(filepath.Separator)) {
		return errPathEscapesRoot
	}
	if targetAbs == rootAbs {
		return errPathEscapesRoot
	}
	if err := ensureResolvedWithinRoot(rootAbs, targetAbs); err != nil {
		return err
	}
	return os.RemoveAll(targetAbs)
}

// ensureResolvedWithinRoot resolves symlinks on the deepest existing ancestor
// of target's parent chain and rejects the path when that resolved ancestor
// escapes root. This closes the gap left by the purely lexical check: a path
// such as `link/file`, where `link` is a symlink to a directory outside the
// repository, would otherwise let os.RemoveAll traverse the link and delete the
// outside target.
//
// The final path component is deliberately never resolved: removing a symlink
// itself does not traverse its target, so it stays allowed. Rejections are
// conservative — an unresolvable repo root or an ancestor chain that cannot be
// resolved is treated as an escape.
func ensureResolvedWithinRoot(rootAbs, targetAbs string) error {
	rootResolved, err := filepath.EvalSymlinks(rootAbs)
	if err != nil {
		return errPathEscapesRoot
	}
	// Start at the target's parent: the final component is intentionally left
	// unresolved so deleting a symlink stays safe.
	ancestor := filepath.Dir(targetAbs)
	for {
		resolved, err := filepath.EvalSymlinks(ancestor)
		if err == nil {
			rel, relErr := filepath.Rel(rootResolved, resolved)
			if relErr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return errPathEscapesRoot
			}
			return nil
		}
		// Not resolvable (missing or broken link): walk up the parent chain.
		if ancestor == rootAbs {
			return errPathEscapesRoot
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return errPathEscapesRoot
		}
		ancestor = parent
	}
}

// Reset runs `git reset --<mode> <to>` (ADR-0021). to is an oid hex or a ref,
// resolved in core; an unresolvable target is rejected before the reset runs.
// MODE_UNSPECIFIED (and any unknown mode) is rejected: the caller must name a
// mode.
func (a *Adapter) Reset(ctx context.Context, repoID domain.RepositoryId, to string, mode domain.ResetMode) error {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return err
	}
	flag, ok := resetFlag(mode)
	if !ok {
		return resetFailed("invalid reset mode")
	}
	target := strings.TrimSpace(to)
	if target == "" || strings.HasPrefix(target, "-") || hasControlChars(target) {
		return resetFailed("invalid reset target")
	}
	if _, err := runGit(ctx, fsPath, "rev-parse", "--verify", "--quiet", target); err != nil {
		return resetFailed("reset target does not resolve: " + target)
	}
	if _, err := runGit(ctx, fsPath, "reset", flag, target); err != nil {
		return resetFailedFromGit(err.Error())
	}
	return nil
}

// resetFlag maps a domain.ResetMode to its git flag.
func resetFlag(mode domain.ResetMode) (string, bool) {
	switch mode {
	case domain.ResetModeSoft:
		return "--soft", true
	case domain.ResetModeMixed:
		return "--mixed", true
	case domain.ResetModeHard:
		return "--hard", true
	default:
		return "", false
	}
}

// discardFailed builds a typed DISCARD_FAILED error with a bounded message.
func discardFailed(message string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeDiscardFailed,
		Message: truncateValidUTF8(strings.TrimSpace(message), maxCheckoutErrLen),
	}
}

// discardFailedFromGit builds the DISCARD_FAILED error for a failed git call.
func discardFailedFromGit(rawErr string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeDiscardFailed,
		Message: shortGitSummaryWithFallback(rawErr, "git discard failed"),
		Details: map[string]string{"raw": boundCheckoutRaw(rawErr)},
	}
}

// resetFailed builds a typed RESET_FAILED error with a bounded message.
func resetFailed(message string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeResetFailed,
		Message: truncateValidUTF8(strings.TrimSpace(message), maxCheckoutErrLen),
	}
}

// resetFailedFromGit builds the RESET_FAILED error for a failed `git reset`.
func resetFailedFromGit(rawErr string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeResetFailed,
		Message: shortGitSummaryWithFallback(rawErr, "git reset failed"),
		Details: map[string]string{"raw": boundCheckoutRaw(rawErr)},
	}
}
