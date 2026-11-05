package git

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/SingulariTree/go-core/internal/domain"
)

// Reason tokens carried in Details["reason"] for the typed cherry-pick/revert
// failures. The renderer switches on them to offer the matching remedy.
const (
	sequencerReasonInvalidSource = "invalid-source"
	sequencerReasonMergeCommit   = "merge-commit"
	sequencerReasonInProgress    = "in-progress"
	sequencerReasonEmpty         = "empty"
	sequencerReasonOverwrite     = "overwrite-local-changes"
)

// sequencerSpec names the per-operation error envelope shared by cherry-pick
// and revert: the FAILED code, the CONFLICT AppError, the command that clears
// the sequencer after an empty pick/revert, and the generic summary fallback.
type sequencerSpec struct {
	failedCode  string
	conflictErr domain.AppError
	skipArgs    []string
	fallback    string
}

// sequencerFailed builds the operation's FAILED error with a short, bounded
// message and the rejection token in Details["reason"].
func sequencerFailed(code, message, reason string) domain.AppError {
	return domain.AppError{
		Code:    code,
		Message: truncateValidUTF8(strings.TrimSpace(message), maxCheckoutErrLen),
		Details: map[string]string{"reason": reason},
	}
}

// sequencerFailedFromGit builds the FAILED error for an unclassified mutation
// failure: a short summary plus the bounded raw text for diagnostics.
func sequencerFailedFromGit(code, rawErr, fallback string) domain.AppError {
	return domain.AppError{
		Code:    code,
		Message: shortGitSummaryWithFallback(rawErr, fallback),
		Details: map[string]string{"raw": boundCheckoutRaw(rawErr)},
	}
}

// hasControlChar reports whether s contains a control character. Revisions are
// single tokens; a control character can only be an attempt to smuggle text
// past the one-arg git invocation, so it is rejected before rev-parse.
func hasControlChar(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

// isSequencerConflict reports whether a failed cherry-pick/revert produced
// conflict markers rather than a plain failure. It reuses the merge detection
// (CONFLICT lines / "fix conflicts" advice) and adds git's per-commit
// "could not apply/revert" line.
func isSequencerConflict(stdout, rawErr string) bool {
	if isMergeConflict(stdout, rawErr) {
		return true
	}
	for _, s := range []string{stdout, rawErr} {
		if strings.Contains(s, "could not apply") || strings.Contains(s, "could not revert") {
			return true
		}
	}
	return false
}

// sequencerBusy reports whether another sequencer operation is already in
// progress: an in-flight CHERRY_PICK_HEAD, REVERT_HEAD or MERGE_HEAD, or an
// on-disk rebase-merge/rebase-apply directory. Starting a pick/revert on top of
// one would corrupt the sequencer state, so it is refused up front.
func (a *Adapter) sequencerBusy(ctx context.Context, fsPath string) bool {
	for _, name := range []string{"CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_HEAD"} {
		if out, _, err := runGitAllowExit(ctx, fsPath, "rev-parse", "--verify", "--quiet", name); err == nil {
			if strings.TrimSpace(out) != "" {
				return true
			}
		}
	}
	for _, name := range []string{"rebase-merge", "rebase-apply"} {
		if p := sequencerGitPath(ctx, fsPath, name); p != "" {
			if _, err := os.Stat(p); err == nil {
				return true
			}
		}
	}
	return false
}

// sequencerGitPath resolves a path inside the repository's git dir. It prefers
// git's absolute form; on a git that does not support --path-format it falls
// back to the relative output, which is relative to the repository because the
// command runs with -C fsPath.
func sequencerGitPath(ctx context.Context, fsPath, name string) string {
	if out, err := runGit(ctx, fsPath, "rev-parse", "--path-format=absolute", "--git-path", name); err == nil {
		return strings.TrimSpace(out)
	}
	out, err := runGit(ctx, fsPath, "rev-parse", "--git-path", name)
	if err != nil {
		return ""
	}
	p := strings.TrimSpace(out)
	if p != "" && !filepath.IsAbs(p) {
		p = filepath.Join(fsPath, p)
	}
	return p
}

// resolveSequencerTarget runs the ordered pre-flight validation shared by
// cherry-pick and revert and returns the commit oid the mutation may run on.
//
// The order is load-bearing and identical for both operations:
//
//  1. reject an unusable source (empty, leading '-', control character);
//  2. resolve it to a commit (COMMIT_NOT_FOUND when that fails) — only the
//     resolved full oid ever reaches the mutating command, never the raw user
//     string, so a revision cannot smuggle an option or a range;
//  3. reject merge commits (no -m/-m 1 parent selection in v1);
//  4. refuse a detached HEAD (there is no branch to advance);
//  5. refuse a busy sequencer (another pick/revert/merge/rebase in progress).
func (a *Adapter) resolveSequencerTarget(ctx context.Context, fsPath, source, opName, failedCode string) (domain.Oid, error) {
	source = strings.TrimSpace(source)
	if source == "" {
		return domain.Oid{}, sequencerFailed(failedCode, opName+" source is required", sequencerReasonInvalidSource)
	}
	if strings.HasPrefix(source, "-") || hasControlChar(source) {
		return domain.Oid{}, sequencerFailed(failedCode, "invalid "+opName+" source", sequencerReasonInvalidSource)
	}

	out, err := runGit(ctx, fsPath, "rev-parse", "--verify", "--quiet", source+"^{commit}")
	if err != nil {
		return domain.Oid{}, domain.ErrCommitNotFound.WithDetail("source", source)
	}
	oid, oerr := domain.NewOid(strings.TrimSpace(out))
	if oerr != nil {
		return domain.Oid{}, domain.ErrCommitNotFound.WithDetail("source", source)
	}

	parents, perr := runGit(ctx, fsPath, "rev-list", "--parents", "-n", "1", oid.Hex)
	if perr != nil {
		return domain.Oid{}, sequencerFailedFromGit(failedCode, perr.Error(), "git "+opName+" failed")
	}
	if len(strings.Fields(parents)) > 2 {
		return domain.Oid{}, sequencerFailed(failedCode, "cannot "+opName+" a merge commit", sequencerReasonMergeCommit)
	}

	if _, derr := runGit(ctx, fsPath, "symbolic-ref", "--short", "-q", "HEAD"); derr != nil {
		return domain.Oid{}, domain.AppError{
			Code:    domain.ErrCodeDetachedHead,
			Message: "cannot " + opName + " on a detached HEAD",
		}
	}

	if a.sequencerBusy(ctx, fsPath) {
		return domain.Oid{}, sequencerFailed(failedCode, "another operation is already in progress", sequencerReasonInProgress)
	}
	return oid, nil
}

// sequencerFailure classifies a non-zero cherry-pick/revert exit. Priority:
//
//   - conflict: the tree stays conflicted (CHERRY_PICK_HEAD/REVERT_HEAD kept)
//     and the result carries HasConflict plus the typed CONFLICT error;
//   - empty: an already-applied pick/revert leaves the sequencer armed, so it
//     is cleared first (--skip) and only then reported as FAILED with
//     reason=empty. Without that skip the repository would stay stuck;
//   - overwrite: local changes would be overwritten, reason carries the remedy;
//   - anything else: the FAILED code with a short git summary and raw text.
func (a *Adapter) sequencerFailure(ctx context.Context, fsPath, stdout, rawErr string, spec sequencerSpec) (*domain.SequencerResult, error) {
	combined := stdout + "\n" + rawErr
	if isSequencerConflict(stdout, rawErr) {
		return &domain.SequencerResult{
				Oid:         a.headOidDomain(ctx, fsPath),
				HasConflict: true,
			},
			spec.conflictErr.WithDetail("raw", boundCheckoutRaw(rawErr))
	}
	if strings.Contains(combined, "is now empty") || strings.Contains(combined, "nothing to commit") {
		// Clear the sequencer before reporting: --skip is a no-op (and its
		// error is ignored) when git already left no sequencer state behind.
		_, _, _ = runGitAllowExit(ctx, fsPath, spec.skipArgs...)
		return nil, sequencerFailed(spec.failedCode, "nothing to commit", sequencerReasonEmpty).
			WithDetail("raw", boundCheckoutRaw(rawErr))
	}
	if strings.Contains(combined, "would be overwritten") {
		return nil, domain.AppError{
			Code:    spec.failedCode,
			Message: "local changes would be overwritten; commit or stash them first",
			Details: map[string]string{
				"reason": sequencerReasonOverwrite,
				"raw":    boundCheckoutRaw(rawErr),
			},
		}
	}
	return nil, sequencerFailedFromGit(spec.failedCode, rawErr, spec.fallback)
}

// CherryPick applies source on top of HEAD via `git cherry-pick`. recordOrigin
// adds -x (the "(cherry picked from commit <sha>)" line) and noCommit adds
// --no-commit, leaving the change staged without committing.
//
// A conflict exits non-zero with CONFLICT output: the tree is left conflicted
// and the method returns a SequencerResult with HasConflict:true together with
// a typed CHERRY_PICK_CONFLICT error. Any other failure yields
// CHERRY_PICK_FAILED. A --no-commit pick that exits 0 is additionally checked
// against the index: nothing staged relative to HEAD means the pick was empty
// and is reported as CHERRY_PICK_FAILED with reason=empty. The ordered
// validation is documented on resolveSequencerTarget.
func (a *Adapter) CherryPick(ctx context.Context, repoID domain.RepositoryId, source string, recordOrigin, noCommit bool) (*domain.SequencerResult, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	oid, err := a.resolveSequencerTarget(ctx, fsPath, source, "cherry-pick", domain.ErrCodeCherryPickFailed)
	if err != nil {
		return nil, err
	}

	args := []string{"cherry-pick"}
	if noCommit {
		args = append(args, "--no-commit")
	}
	if recordOrigin {
		args = append(args, "-x")
	}
	args = append(args, oid.Hex)

	out, _, err := runGitAllowExit(ctx, fsPath, args...)
	if err != nil {
		return a.sequencerFailure(ctx, fsPath, out, err.Error(), sequencerSpec{
			failedCode:  domain.ErrCodeCherryPickFailed,
			conflictErr: domain.ErrCherryPickConflict,
			skipArgs:    []string{"cherry-pick", "--skip"},
			fallback:    "git cherry-pick failed",
		})
	}
	// A --no-commit pick of an already-applied change can exit 0 with nothing
	// staged, so sequencerFailure's "is now empty" branch never runs and the
	// dialog would close as if something had been applied. Emptiness is
	// therefore read from the index relative to HEAD: `git diff --cached
	// --quiet` exits 0 when nothing is staged and 1 when staged changes exist.
	// This path leaves no sequencer state armed (a --no-commit pick never
	// records CHERRY_PICK_HEAD), so unlike sequencerFailure's non-zero branch no
	// --skip is needed. The check is deliberately limited to noCommit: a
	// committing pick that exits 0 always produced a commit.
	if noCommit {
		_, code, diffErr := runGitAllowExit(ctx, fsPath, "diff", "--cached", "--quiet")
		if code != 1 {
			if diffErr != nil {
				return nil, sequencerFailedFromGit(domain.ErrCodeCherryPickFailed, diffErr.Error(), "git cherry-pick failed")
			}
			return nil, sequencerFailed(domain.ErrCodeCherryPickFailed, "nothing to commit", sequencerReasonEmpty)
		}
	}
	return &domain.SequencerResult{Oid: a.headOidDomain(ctx, fsPath)}, nil
}

// Revert undoes source on top of HEAD via `git revert --no-edit`. A conflict
// exits non-zero with CONFLICT output and leaves the tree conflicted, returning
// a SequencerResult with HasConflict:true together with a typed
// REVERT_CONFLICT error; any other failure yields REVERT_FAILED. The ordered
// validation is documented on resolveSequencerTarget.
func (a *Adapter) Revert(ctx context.Context, repoID domain.RepositoryId, source string) (*domain.SequencerResult, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	oid, err := a.resolveSequencerTarget(ctx, fsPath, source, "revert", domain.ErrCodeRevertFailed)
	if err != nil {
		return nil, err
	}

	out, _, err := runGitAllowExit(ctx, fsPath, "revert", "--no-edit", oid.Hex)
	if err != nil {
		return a.sequencerFailure(ctx, fsPath, out, err.Error(), sequencerSpec{
			failedCode:  domain.ErrCodeRevertFailed,
			conflictErr: domain.ErrRevertConflict,
			skipArgs:    []string{"revert", "--skip"},
			fallback:    "git revert failed",
		})
	}
	return &domain.SequencerResult{Oid: a.headOidDomain(ctx, fsPath)}, nil
}

// ResolveRevision resolves revision to its commit for the cherry-pick/revert
// preview. It is read-only and never mutates the repository. An unusable string
// (empty, leading '-', control character) is INVALID_OID; a plausible revision
// that does not resolve is COMMIT_NOT_FOUND.
func (a *Adapter) ResolveRevision(ctx context.Context, repoID domain.RepositoryId, revision string) (*domain.Commit, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	revision = strings.TrimSpace(revision)
	if revision == "" || strings.HasPrefix(revision, "-") || hasControlChar(revision) {
		return nil, domain.ErrInvalidOid.WithDetail("revision", revision)
	}

	out, err := runGit(ctx, fsPath, "rev-parse", "--verify", "--quiet", revision+"^{commit}")
	if err != nil {
		return nil, domain.ErrCommitNotFound.WithDetail("revision", revision)
	}
	oid, oerr := domain.NewOid(strings.TrimSpace(out))
	if oerr != nil {
		return nil, domain.ErrCommitNotFound.WithDetail("revision", revision)
	}
	return a.Get(ctx, repoID, oid)
}
