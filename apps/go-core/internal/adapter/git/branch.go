package git

import (
	"context"
	"strings"

	"github.com/SingulariTree/go-core/internal/domain"
)

// branchOpFailed builds a typed BRANCH_NOT_FOUND error with a short, bounded
// message. BRANCH_NOT_FOUND is the only non-collision branch code the contract
// (ADR-028) defines, so a rejected branch mutation other than a name collision
// (e.g. deleting an unmerged branch) reuses it and carries the specific git
// summary in the message/details.
func branchOpFailed(message string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeBranchNotFound,
		Message: truncateValidUTF8(strings.TrimSpace(message), maxCheckoutErrLen),
	}
}

// branchOpFailedFromGit builds the BRANCH_NOT_FOUND error for a failed branch
// git command: a short summary plus the bounded raw text for diagnostics.
func branchOpFailedFromGit(rawErr string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeBranchNotFound,
		Message: shortGitSummaryWithFallback(rawErr, "git branch failed"),
		Details: map[string]string{"raw": boundCheckoutRaw(rawErr)},
	}
}

// branchExists builds the typed BRANCH_EXISTS error for a name collision.
func branchExists(name string) domain.AppError {
	return domain.ErrBranchExists.WithDetail("name", name)
}

// gitSaysAlreadyExists reports whether a git error envelope indicates a ref
// name collision. It catches the race where a branch appears between the
// pre-check and the mutating command.
func gitSaysAlreadyExists(rawErr string) bool {
	return strings.Contains(rawErr, "already exists")
}

// localBranchExists reports whether refs/heads/<name> exists, using
// `git show-ref --verify --quiet` (exit 0 == exists, 1 == missing).
func (a *Adapter) localBranchExists(ctx context.Context, fsPath, name string) bool {
	_, code, _ := runGitAllowExit(ctx, fsPath, "show-ref", "--verify", "--quiet", "refs/heads/"+name)
	return code == 0
}

// newBranch reads back a just-created/renamed local branch. The tip is resolved
// best-effort (an unborn repository has none); isCurrent is supplied by the
// caller.
func (a *Adapter) newBranch(ctx context.Context, fsPath, name string, isCurrent bool) *domain.Branch {
	b := &domain.Branch{
		Name:      name,
		RefName:   domain.RefName{Raw: "refs/heads/" + name},
		IsCurrent: isCurrent,
	}
	if out, err := runGit(ctx, fsPath, "rev-parse", "--verify", "refs/heads/"+name); err == nil {
		if oid, oerr := domain.NewOid(strings.TrimSpace(out)); oerr == nil {
			b.Tip = oid
		}
	}
	return b
}

// BranchCreate creates a local branch from startPoint (empty means HEAD) via
// `git branch <name> [<startPoint>]`, then `git checkout <name>` when checkout
// is true. An existing branch yields BRANCH_EXISTS; any other failure yields
// BRANCH_NOT_FOUND (the contract's generic branch code).
func (a *Adapter) BranchCreate(ctx context.Context, repoID domain.RepositoryId, name, startPoint string, checkout bool) (*domain.Branch, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	if name == "" || !checkSafeRef(name) {
		return nil, branchOpFailed("invalid branch name")
	}
	startPoint = strings.TrimSpace(startPoint)
	if startPoint != "" && !checkSafeArg(startPoint) {
		return nil, branchOpFailed("invalid start point")
	}
	if a.localBranchExists(ctx, fsPath, name) {
		return nil, branchExists(name)
	}
	args := []string{"branch", name}
	if startPoint != "" {
		args = append(args, startPoint)
	}
	if _, err := runGit(ctx, fsPath, args...); err != nil {
		if gitSaysAlreadyExists(err.Error()) {
			return nil, branchExists(name)
		}
		return nil, branchOpFailedFromGit(err.Error())
	}
	if checkout {
		if _, err := runGit(ctx, fsPath, "checkout", name); err != nil {
			return nil, checkoutFailedFromGit(err.Error())
		}
	}
	return a.newBranch(ctx, fsPath, name, checkout), nil
}

// BranchRename renames a local branch via `git branch -m <oldName> <newName>`.
// A missing old branch yields BRANCH_NOT_FOUND and an existing new branch
// yields BRANCH_EXISTS.
func (a *Adapter) BranchRename(ctx context.Context, repoID domain.RepositoryId, oldName, newName string) (*domain.Branch, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	oldName = strings.TrimSpace(oldName)
	newName = strings.TrimSpace(newName)
	if oldName == "" || !checkSafeRef(oldName) || newName == "" || !checkSafeRef(newName) {
		return nil, branchOpFailed("invalid branch name")
	}
	if !a.localBranchExists(ctx, fsPath, oldName) {
		return nil, domain.ErrBranchNotFound.WithDetail("name", oldName)
	}
	if newName != oldName && a.localBranchExists(ctx, fsPath, newName) {
		return nil, branchExists(newName)
	}
	if _, err := runGit(ctx, fsPath, "branch", "-m", oldName, newName); err != nil {
		if gitSaysAlreadyExists(err.Error()) {
			return nil, branchExists(newName)
		}
		return nil, branchOpFailedFromGit(err.Error())
	}
	return a.newBranch(ctx, fsPath, newName, currentBranch(ctx, fsPath) == newName), nil
}

// BranchDelete deletes a local branch via `git branch -d|-D <name>` (-D when
// force). A missing branch yields BRANCH_NOT_FOUND.
func (a *Adapter) BranchDelete(ctx context.Context, repoID domain.RepositoryId, ref domain.RefName, force bool) error {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(ref.Raw)
	name = strings.TrimPrefix(name, "refs/heads/")
	if name == "" || !checkSafeRef(name) {
		return branchOpFailed("invalid branch name")
	}
	if !a.localBranchExists(ctx, fsPath, name) {
		return domain.ErrBranchNotFound.WithDetail("name", name)
	}
	flag := "-d"
	if force {
		flag = "-D"
	}
	if _, err := runGit(ctx, fsPath, "branch", flag, name); err != nil {
		return branchOpFailedFromGit(err.Error())
	}
	return nil
}
