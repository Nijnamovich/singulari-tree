package service

import (
	"context"
	"errors"
	"strings"

	"github.com/SingulariTree/go-core/internal/domain"
)

// GitService handles mutating and read Git operations (service-design.md §1.1).
// Mutating ops are serialized per RepositoryId in real implementation (sync.Mutex map).
type GitService struct {
	gitPort   domain.GitPort
	cachePort domain.CachePort
	watcher   *WatcherService
}

// NewGitService creates a GitService.
func NewGitService(gitPort domain.GitPort, cachePort domain.CachePort, watcher *WatcherService) *GitService {
	return &GitService{gitPort: gitPort, cachePort: cachePort, watcher: watcher}
}

// notifyChange emits a watcher event so derived state (commit cache, lane
// layout) is invalidated after a mutating operation.
func (s *GitService) notifyChange(repoID domain.RepositoryId) {
	if s.watcher != nil {
		s.watcher.Emit(domain.FsChangedEvent{RepoID: repoID})
	}
}

// afterMutation invalidates the repo cache and notifies the watcher after a
// successful working-tree/index mutation, so file_status, the commit cache and
// the commit_stats gauge are recomputed.
func (s *GitService) afterMutation(repoID domain.RepositoryId) {
	if s.cachePort != nil {
		s.cachePort.Invalidate(repoID)
	}
	s.notifyChange(repoID)
}

// Status returns working-tree file status.
func (s *GitService) Status(ctx context.Context, repoID domain.RepositoryId) ([]domain.FileStatus, error) {
	if s.gitPort == nil {
		return nil, nil
	}
	return s.gitPort.Status(ctx, repoID)
}

// Stage stages paths.
func (s *GitService) Stage(ctx context.Context, repoID domain.RepositoryId, paths []string) error {
	if s.gitPort == nil {
		return nil
	}
	if err := s.gitPort.Stage(ctx, repoID, paths); err != nil {
		return err
	}
	if s.cachePort != nil {
		s.cachePort.Invalidate(repoID)
	}
	s.notifyChange(repoID)
	return nil
}

// Unstage unstages paths.
func (s *GitService) Unstage(ctx context.Context, repoID domain.RepositoryId, paths []string) error {
	if s.gitPort == nil {
		return nil
	}
	if err := s.gitPort.Unstage(ctx, repoID, paths); err != nil {
		return err
	}
	if s.cachePort != nil {
		s.cachePort.Invalidate(repoID)
	}
	s.notifyChange(repoID)
	return nil
}

// Commit creates a commit.
func (s *GitService) Commit(ctx context.Context, repoID domain.RepositoryId, msg string, author *domain.Signature) (*domain.Commit, error) {
	if s.gitPort == nil {
		return nil, domain.AppError{Code: domain.ErrCodeCommitFailed, Message: "git not configured"}
	}
	c, err := s.gitPort.Commit(ctx, repoID, msg, author)
	if err != nil {
		return nil, err
	}
	if s.cachePort != nil {
		s.cachePort.Invalidate(repoID)
	}
	s.notifyChange(repoID)
	return c, nil
}

// StageHunk stages one hunk (or selected lines) of path from the working tree
// into the index (ADR-0020). The core re-derives the diff and constructs the
// patch; the caller sends indices only.
func (s *GitService) StageHunk(ctx context.Context, repoID domain.RepositoryId, path string, hunkIndex uint32, lineIndices []uint32) error {
	if s.gitPort == nil {
		return nil
	}
	if err := s.gitPort.StageHunk(ctx, repoID, path, hunkIndex, lineIndices); err != nil {
		return err
	}
	s.afterMutation(repoID)
	return nil
}

// UnstageHunk removes one hunk (or selected lines) of path from the index
// (ADR-0020).
func (s *GitService) UnstageHunk(ctx context.Context, repoID domain.RepositoryId, path string, hunkIndex uint32, lineIndices []uint32) error {
	if s.gitPort == nil {
		return nil
	}
	if err := s.gitPort.UnstageHunk(ctx, repoID, path, hunkIndex, lineIndices); err != nil {
		return err
	}
	s.afterMutation(repoID)
	return nil
}

// DiscardHunk reverts one hunk (or selected lines) of path in the working tree
// (ADR-0020).
func (s *GitService) DiscardHunk(ctx context.Context, repoID domain.RepositoryId, path string, hunkIndex uint32, lineIndices []uint32) error {
	if s.gitPort == nil {
		return nil
	}
	if err := s.gitPort.DiscardHunk(ctx, repoID, path, hunkIndex, lineIndices); err != nil {
		return err
	}
	s.afterMutation(repoID)
	return nil
}

// Discard reverts file-level changes; tracked paths from HEAD/index, untracked
// paths by removal (ADR-0020).
func (s *GitService) Discard(ctx context.Context, repoID domain.RepositoryId, paths []string) error {
	if s.gitPort == nil {
		return nil
	}
	if err := s.gitPort.Discard(ctx, repoID, paths); err != nil {
		return err
	}
	s.afterMutation(repoID)
	return nil
}

// Reset runs `git reset --<mode> <to>` (ADR-0021). The mode is mandatory;
// MODE_UNSPECIFIED is rejected by the adapter.
func (s *GitService) Reset(ctx context.Context, repoID domain.RepositoryId, to string, mode domain.ResetMode) error {
	if s.gitPort == nil {
		return nil
	}
	if err := s.gitPort.Reset(ctx, repoID, to, mode); err != nil {
		return err
	}
	s.afterMutation(repoID)
	return nil
}

// CommitStats returns the change-size counts for a batch of oids (ADR-0023),
// cache-through: cached oids come from SQLite, misses are computed via git and
// written back. Only counts are persisted.
func (s *GitService) CommitStats(ctx context.Context, repoID domain.RepositoryId, oids []string) ([]domain.CommitStats, error) {
	if s.gitPort == nil {
		return nil, domain.AppError{Code: domain.ErrCodeDiffFailed, Message: "git not configured"}
	}
	byOid := make(map[string]domain.CommitStats, len(oids))
	if s.cachePort != nil {
		if cached, ok := s.cachePort.GetCommitStats(ctx, repoID, oids); ok {
			for _, st := range cached {
				byOid[st.Oid] = st
			}
		}
	}
	missing := make([]string, 0, len(oids))
	for _, oid := range oids {
		if _, ok := byOid[oid]; !ok {
			missing = append(missing, oid)
		}
	}
	if len(missing) > 0 {
		computed, err := s.gitPort.CommitStats(ctx, repoID, missing)
		if err != nil {
			return nil, err
		}
		if s.cachePort != nil {
			_ = s.cachePort.PutCommitStats(ctx, repoID, computed)
		}
		for _, st := range computed {
			byOid[st.Oid] = st
		}
	}
	out := make([]domain.CommitStats, 0, len(oids))
	for _, oid := range oids {
		if st, ok := byOid[oid]; ok {
			out = append(out, st)
		}
	}
	return out, nil
}

// Diff returns the diff addressed by req (ADR-0020), including per-file
// sections and an optional per-file/staged selector.
func (s *GitService) Diff(ctx context.Context, repoID domain.RepositoryId, req domain.DiffRequest) (*domain.Diff, error) {
	if s.gitPort == nil {
		return nil, domain.AppError{Code: domain.ErrCodeDiffFailed, Message: "git not configured"}
	}
	return s.gitPort.Diff(ctx, repoID, req)
}

// BranchList returns branches.
func (s *GitService) BranchList(ctx context.Context, repoID domain.RepositoryId) ([]domain.Branch, error) {
	if s.gitPort == nil {
		return nil, nil
	}
	return s.gitPort.BranchList(ctx, repoID)
}

// RemoteList returns configured remotes.
func (s *GitService) RemoteList(ctx context.Context, repoID domain.RepositoryId) ([]domain.Remote, error) {
	if s.gitPort == nil {
		return nil, nil
	}
	return s.gitPort.RemoteList(ctx, repoID)
}

// TagList returns tags.
func (s *GitService) TagList(ctx context.Context, repoID domain.RepositoryId) ([]domain.Tag, error) {
	if s.gitPort == nil {
		return nil, nil
	}
	return s.gitPort.TagList(ctx, repoID)
}

// Checkout checks out a ref. force discards tracked working-tree modifications;
// discardUntracked additionally discards untracked files (and implies force).
func (s *GitService) Checkout(ctx context.Context, repoID domain.RepositoryId, ref domain.RefName, force, discardUntracked bool) error {
	if s.gitPort == nil {
		return nil
	}
	if err := s.gitPort.Checkout(ctx, repoID, ref, force, discardUntracked); err != nil {
		return err
	}
	if s.cachePort != nil {
		s.cachePort.Invalidate(repoID)
	}
	s.notifyChange(repoID)
	return nil
}

// StashPush saves the working-tree changes to a new stash entry.
func (s *GitService) StashPush(ctx context.Context, repoID domain.RepositoryId, message string) (*domain.Stash, error) {
	if s.gitPort == nil {
		return nil, domain.AppError{Code: domain.ErrCodeStashFailed, Message: "git not configured"}
	}
	st, err := s.gitPort.StashPush(ctx, repoID, message)
	if err != nil {
		return nil, err
	}
	if s.cachePort != nil {
		s.cachePort.Invalidate(repoID)
	}
	s.notifyChange(repoID)
	return st, nil
}

// BranchCreate creates a local branch from startPoint (empty means HEAD) and
// optionally switches to it (ADR-028).
func (s *GitService) BranchCreate(ctx context.Context, repoID domain.RepositoryId, name, startPoint string, checkout bool) (*domain.Branch, error) {
	if s.gitPort == nil {
		return nil, domain.AppError{Code: domain.ErrCodeBranchNotFound, Message: "git not configured"}
	}
	if strings.TrimSpace(name) == "" {
		return nil, domain.AppError{Code: domain.ErrCodeBranchNotFound, Message: "branch name is required"}
	}
	b, err := s.gitPort.BranchCreate(ctx, repoID, name, startPoint, checkout)
	if err != nil {
		return nil, err
	}
	s.afterMutation(repoID)
	return b, nil
}

// BranchRename renames a local branch (ADR-028).
func (s *GitService) BranchRename(ctx context.Context, repoID domain.RepositoryId, oldName, newName string) (*domain.Branch, error) {
	if s.gitPort == nil {
		return nil, domain.AppError{Code: domain.ErrCodeBranchNotFound, Message: "git not configured"}
	}
	if strings.TrimSpace(oldName) == "" || strings.TrimSpace(newName) == "" {
		return nil, domain.AppError{Code: domain.ErrCodeBranchNotFound, Message: "branch name is required"}
	}
	b, err := s.gitPort.BranchRename(ctx, repoID, oldName, newName)
	if err != nil {
		return nil, err
	}
	s.afterMutation(repoID)
	return b, nil
}

// BranchDelete deletes a local branch; force maps to `git branch -D` (ADR-028).
func (s *GitService) BranchDelete(ctx context.Context, repoID domain.RepositoryId, ref domain.RefName, force bool) error {
	if s.gitPort == nil {
		return nil
	}
	name := strings.TrimSpace(ref.Raw)
	name = strings.TrimPrefix(name, "refs/heads/")
	if name == "" {
		return domain.AppError{Code: domain.ErrCodeBranchNotFound, Message: "branch name is required"}
	}
	if err := s.gitPort.BranchDelete(ctx, repoID, domain.RefName{Raw: name}, force); err != nil {
		return err
	}
	s.afterMutation(repoID)
	return nil
}

// Merge integrates ref into the current branch with the named strategy
// (ADR-028). MERGE_STRATEGY_UNSPECIFIED is rejected. A conflict is returned
// with a non-nil MergeResult (HasConflict true) and a typed MERGE_CONFLICT
// error; the tree is left conflicted and derived state is refreshed so
// GetStatus surfaces is_conflicted.
func (s *GitService) Merge(ctx context.Context, repoID domain.RepositoryId, ref string, strategy domain.MergeStrategy, noCommit bool, message string) (*domain.MergeResult, error) {
	if s.gitPort == nil {
		return nil, domain.AppError{Code: domain.ErrCodeMergeFailed, Message: "git not configured"}
	}
	if strings.TrimSpace(ref) == "" {
		return nil, domain.AppError{Code: domain.ErrCodeMergeFailed, Message: "merge ref is required"}
	}
	if strategy == domain.MergeStrategyUnspecified {
		return nil, domain.AppError{Code: domain.ErrCodeMergeFailed, Message: "merge strategy is required"}
	}
	result, err := s.gitPort.Merge(ctx, repoID, ref, strategy, noCommit, message)
	if err != nil {
		var appErr domain.AppError
		// A conflict still mutated the working tree, so refresh even though an
		// error is returned; other failures leave the tree untouched.
		if errors.As(err, &appErr) && appErr.Code == domain.ErrCodeMergeConflict {
			s.afterMutation(repoID)
		}
		return result, err
	}
	s.afterMutation(repoID)
	return result, nil
}

// CherryPick applies source on top of the current branch (ADR-0042).
// recordOrigin maps to -x and noCommit to --no-commit. A conflict is returned
// with a non-nil SequencerResult (HasConflict true) and a typed
// CHERRY_PICK_CONFLICT error; the tree is left conflicted and derived state is
// refreshed so GetStatus surfaces is_conflicted. Any other failure leaves
// derived state untouched.
func (s *GitService) CherryPick(ctx context.Context, repoID domain.RepositoryId, source string, recordOrigin, noCommit bool) (*domain.SequencerResult, error) {
	if s.gitPort == nil {
		return nil, domain.AppError{Code: domain.ErrCodeCherryPickFailed, Message: "git not configured"}
	}
	// Keep the guard so an unusable source never reaches the port, but carry
	// the documented rejection token: the ordered contract reports an unusable
	// source as reason=invalid-source, exactly as the adapter would.
	if strings.TrimSpace(source) == "" {
		return nil, domain.AppError{
			Code:    domain.ErrCodeCherryPickFailed,
			Message: "cherry-pick source is required",
			Details: map[string]string{"reason": "invalid-source"},
		}
	}
	result, err := s.gitPort.CherryPick(ctx, repoID, source, recordOrigin, noCommit)
	if err != nil {
		var appErr domain.AppError
		// A conflict still mutated the working tree, so refresh even though an
		// error is returned; other failures leave the tree untouched.
		if errors.As(err, &appErr) && appErr.Code == domain.ErrCodeCherryPickConflict {
			s.afterMutation(repoID)
		}
		return result, err
	}
	s.afterMutation(repoID)
	return result, nil
}

// Revert undoes source on the current branch (ADR-0042). A conflict is returned
// with a non-nil SequencerResult (HasConflict true) and a typed REVERT_CONFLICT
// error; as with Merge, the conflicted tree still refreshes derived state.
func (s *GitService) Revert(ctx context.Context, repoID domain.RepositoryId, source string) (*domain.SequencerResult, error) {
	if s.gitPort == nil {
		return nil, domain.AppError{Code: domain.ErrCodeRevertFailed, Message: "git not configured"}
	}
	// Same guard and token as CherryPick: the ordered contract reports an
	// unusable source as reason=invalid-source.
	if strings.TrimSpace(source) == "" {
		return nil, domain.AppError{
			Code:    domain.ErrCodeRevertFailed,
			Message: "revert source is required",
			Details: map[string]string{"reason": "invalid-source"},
		}
	}
	result, err := s.gitPort.Revert(ctx, repoID, source)
	if err != nil {
		var appErr domain.AppError
		if errors.As(err, &appErr) && appErr.Code == domain.ErrCodeRevertConflict {
			s.afterMutation(repoID)
		}
		return result, err
	}
	s.afterMutation(repoID)
	return result, nil
}

// ResolveRevision resolves a revision to its commit for the cherry-pick/revert
// preview (ADR-0042). It is read-only: no cache invalidation and no watcher
// notification.
func (s *GitService) ResolveRevision(ctx context.Context, repoID domain.RepositoryId, revision string) (*domain.Commit, error) {
	if s.gitPort == nil {
		return nil, domain.AppError{Code: domain.ErrCodeCommitNotFound, Message: "git not configured"}
	}
	if strings.TrimSpace(revision) == "" {
		return nil, domain.AppError{Code: domain.ErrCodeCommitNotFound, Message: "revision is required"}
	}
	return s.gitPort.ResolveRevision(ctx, repoID, revision)
}

// TagCreate creates a tag (annotated or lightweight, ADR-028). An empty target
// means HEAD; force maps to `git tag -f`.
func (s *GitService) TagCreate(ctx context.Context, repoID domain.RepositoryId, name, target string, annotated bool, message string, force bool) (*domain.Tag, error) {
	if s.gitPort == nil {
		return nil, domain.AppError{Code: domain.ErrCodeTagNotFound, Message: "git not configured"}
	}
	if strings.TrimSpace(name) == "" {
		return nil, domain.AppError{Code: domain.ErrCodeTagNotFound, Message: "tag name is required"}
	}
	t, err := s.gitPort.TagCreate(ctx, repoID, name, target, annotated, message, force)
	if err != nil {
		return nil, err
	}
	s.afterMutation(repoID)
	return t, nil
}

// TagDelete deletes a tag (ADR-028).
func (s *GitService) TagDelete(ctx context.Context, repoID domain.RepositoryId, ref domain.RefName) error {
	if s.gitPort == nil {
		return nil
	}
	name := strings.TrimSpace(ref.Raw)
	name = strings.TrimPrefix(name, "refs/tags/")
	if name == "" {
		return domain.AppError{Code: domain.ErrCodeTagNotFound, Message: "tag name is required"}
	}
	if err := s.gitPort.TagDelete(ctx, repoID, domain.RefName{Raw: name}); err != nil {
		return err
	}
	s.afterMutation(repoID)
	return nil
}

// StashList returns the stash entries (un-stubbed GetStashes, ADR-028).
func (s *GitService) StashList(ctx context.Context, repoID domain.RepositoryId) ([]domain.Stash, error) {
	if s.gitPort == nil {
		return nil, nil
	}
	return s.gitPort.StashList(ctx, repoID)
}

// StashApply applies stash entry index, retaining it; restoreIndex maps to
// `git stash apply --index` (ADR-028).
func (s *GitService) StashApply(ctx context.Context, repoID domain.RepositoryId, index int, restoreIndex bool) error {
	if s.gitPort == nil {
		return nil
	}
	if err := s.gitPort.StashApply(ctx, repoID, index, restoreIndex); err != nil {
		return err
	}
	s.afterMutation(repoID)
	return nil
}

// StashPop applies and drops stash entry index (ADR-028).
func (s *GitService) StashPop(ctx context.Context, repoID domain.RepositoryId, index int) error {
	if s.gitPort == nil {
		return nil
	}
	if err := s.gitPort.StashPop(ctx, repoID, index); err != nil {
		return err
	}
	s.afterMutation(repoID)
	return nil
}

// StashDrop removes stash entry index (ADR-028).
func (s *GitService) StashDrop(ctx context.Context, repoID domain.RepositoryId, index int) error {
	if s.gitPort == nil {
		return nil
	}
	if err := s.gitPort.StashDrop(ctx, repoID, index); err != nil {
		return err
	}
	s.afterMutation(repoID)
	return nil
}

// Fetch streams progress for a fetch from remote, followed by an optional
// terminal error.
func (s *GitService) Fetch(ctx context.Context, repoID domain.RepositoryId, remote string, opts domain.RemoteOpOptions) (<-chan domain.RemoteOpResult, error) {
	if s.gitPort == nil {
		return nil, domain.AppError{Code: domain.ErrCodeFetchFailed, Message: "git not configured"}
	}
	ch, err := s.gitPort.Fetch(ctx, repoID, remote, opts)
	if err != nil {
		return nil, err
	}
	return s.wrapRemoteOp(ctx, repoID, ch), nil
}

// Push streams progress for publishing branch to remote, followed by an
// optional terminal error.
func (s *GitService) Push(ctx context.Context, repoID domain.RepositoryId, remote, branch string, opts domain.RemoteOpOptions) (<-chan domain.RemoteOpResult, error) {
	if s.gitPort == nil {
		return nil, domain.AppError{Code: domain.ErrCodePushFailed, Message: "git not configured"}
	}
	ch, err := s.gitPort.Push(ctx, repoID, remote, branch, opts)
	if err != nil {
		return nil, err
	}
	return s.wrapRemoteOp(ctx, repoID, ch), nil
}

// Pull streams progress for integrating remote branch, followed by an optional
// terminal error.
func (s *GitService) Pull(ctx context.Context, repoID domain.RepositoryId, remote, branch string, opts domain.RemoteOpOptions) (<-chan domain.RemoteOpResult, error) {
	if s.gitPort == nil {
		return nil, domain.AppError{Code: domain.ErrCodePullFailed, Message: "git not configured"}
	}
	ch, err := s.gitPort.Pull(ctx, repoID, remote, branch, opts)
	if err != nil {
		return nil, err
	}
	return s.wrapRemoteOp(ctx, repoID, ch), nil
}

// wrapRemoteOp proxies a remote operation's result channel. The commit cache is
// invalidated and the watcher notified only when the operation succeeds — i.e.
// the channel closes cleanly with no terminal error. On a terminal error the
// item is forwarded unchanged and derived state is left untouched, so a failed
// push/pull does not trigger a refresh that hides the failure. It exits on
// context cancellation so neither goroutine leaks (risks.md R12).
func (s *GitService) wrapRemoteOp(ctx context.Context, repoID domain.RepositoryId, in <-chan domain.RemoteOpResult) <-chan domain.RemoteOpResult {
	out := make(chan domain.RemoteOpResult)
	go func() {
		defer close(out)
		for {
			select {
			case r, ok := <-in:
				if !ok {
					// Clean channel close: the operation succeeded; refresh
					// derived state.
					if s.cachePort != nil {
						s.cachePort.Invalidate(repoID)
					}
					s.notifyChange(repoID)
					return
				}
				if r.Err != nil {
					// Terminal failure: forward it and do NOT invalidate/notify.
					select {
					case out <- r:
					case <-ctx.Done():
					}
					return
				}
				select {
				case out <- r:
				case <-ctx.Done():
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}
