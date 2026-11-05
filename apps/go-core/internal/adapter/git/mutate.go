package git

import (
	"bytes"
	"context"
	"strings"
	"unicode"

	"github.com/SingulariTree/go-core/internal/domain"
)

// literalPathsArgs returns the git arguments that make a staging command read
// its path list from stdin literally.
//
// Paths are passed through git's NUL-separated pathspec-from-file mechanism
// (`--pathspec-from-file=- --pathspec-file-nul`) instead of as positional
// pathspec arguments because positional pathspecs are still subject to git's
// glob/colon magic: `--` blocks option injection but not pathspec magic, so a
// worktree file literally named "*.txt" would also stage every other *.txt
// file, and a name like ":top" (top-level magic) could never be addressed.
//
// --literal-pathspecs is required in addition to the from-file mechanism: on
// its own, a pathspec read from the file is still glob-expanded by git (e.g.
// an entry "*.txt" matches a.txt too). The two together make every entry an
// exact path (no glob or colon magic) while a NUL-delimited stdin list keeps
// the boundary unambiguous for any path byte except NUL.
//
// cmd is the staging subcommand (add/restore/rm); --literal-pathspecs is a
// global option and must precede it.
func literalPathsArgs(cmd string, extra ...string) []string {
	args := []string{"--literal-pathspecs", cmd}
	args = append(args, extra...)
	return append(args, "--pathspec-from-file=-", "--pathspec-file-nul")
}

// pathspecFromFile renders paths as the NUL-terminated list consumed by git's
// --pathspec-from-file=- --pathspec-file-nul mechanism. Every path receives a
// trailing NUL, including the last, so no boundary ambiguity remains.
func pathspecFromFile(paths []string) []byte {
	var buf bytes.Buffer
	for _, p := range paths {
		buf.WriteString(p)
		buf.WriteByte(0)
	}
	return buf.Bytes()
}

// Stage adds the given paths to the index. An empty or nil path list is a
// no-op. Paths travel literally (see literalPathsArgs): no glob or colon
// pathspec magic is applied. Control characters (including NUL) are still
// rejected up front so a caller cannot inject options or confuse the list. Any
// git failure yields a typed STAGE_FAILED with a short summary and bounded raw
// detail.
func (a *Adapter) Stage(ctx context.Context, repoID domain.RepositoryId, paths []string) error {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return err
	}
	if len(paths) == 0 {
		return nil
	}
	for _, p := range paths {
		if !validPathArg(p) {
			return stageFailed("invalid path")
		}
	}
	if _, err := runGitStdin(ctx, fsPath, pathspecFromFile(paths), literalPathsArgs("add")...); err != nil {
		return stageFailedFromGit(err.Error(), "git add failed")
	}
	return nil
}

// Unstage removes the given paths from the index. It prefers
// `git restore --staged`; on an unborn HEAD (where restore has no source to
// reset against) it falls back to `git rm --cached -r -q`. Paths travel
// literally (see literalPathsArgs): no glob or colon pathspec magic is applied.
// An empty path list is a no-op. There is no UNSTAGE_FAILED code, so failures
// reuse the typed STAGE_FAILED code with a short summary and bounded raw detail.
func (a *Adapter) Unstage(ctx context.Context, repoID domain.RepositoryId, paths []string) error {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return err
	}
	if len(paths) == 0 {
		return nil
	}
	for _, p := range paths {
		if !validPathArg(p) {
			return stageFailed("invalid path")
		}
	}

	// An unborn HEAD has no commit for `git restore --staged` to reset against.
	if _, err := runGit(ctx, fsPath, "rev-parse", "--verify", "--quiet", "HEAD"); err != nil {
		if _, rmErr := runGitStdin(ctx, fsPath, pathspecFromFile(paths),
			literalPathsArgs("rm", "--cached", "-r", "-q")...); rmErr != nil {
			return stageFailedFromGit(rmErr.Error(), "git rm failed")
		}
		return nil
	}

	if _, err := runGitStdin(ctx, fsPath, pathspecFromFile(paths),
		literalPathsArgs("restore", "--staged")...); err != nil {
		return stageFailedFromGit(err.Error(), "git restore failed")
	}
	return nil
}

// Commit creates a commit from the staged changes with the given message and
// returns the full commit read back from git. The message is always passed as
// the value of `-m`, so content (including a leading '-') is safe. When author
// is non-nil it is passed as `--author="Name <email>"`; name and email are
// rejected when empty or containing control characters/newlines. The user's
// commit-signing configuration is never overridden. Failures yield a typed
// COMMIT_FAILED with a short summary and bounded raw detail.
func (a *Adapter) Commit(ctx context.Context, repoID domain.RepositoryId, message string, author *domain.Signature) (*domain.Commit, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(message) == "" {
		return nil, commitFailed("empty commit message")
	}

	args := []string{"commit", "-m", message}
	if author != nil {
		if !validIdentity(author.Name) || !validIdentity(author.Email) {
			return nil, commitFailed("invalid author identity")
		}
		args = append(args, "--author="+formatSignature(*author))
	}

	if _, err := runGit(ctx, fsPath, args...); err != nil {
		return nil, commitFailedFromGit(err.Error())
	}

	headOut, err := runGit(ctx, fsPath, "rev-parse", "HEAD")
	if err != nil {
		return nil, commitFailedFromGit(err.Error())
	}
	oid, err := domain.NewOid(strings.TrimSpace(headOut))
	if err != nil {
		return nil, commitFailed("could not resolve commit oid")
	}
	c, err := a.Get(ctx, repoID, oid)
	if err != nil {
		return nil, commitFailedFromGit(err.Error())
	}
	return c, nil
}

// validPathArg reports whether a path is safe to pass to git: non-empty and
// free of NUL/control characters. Whitespace inside a path is allowed (each
// path is one NUL-terminated entry); pathspec-from-file keeps a leading '-'
// from being read as an option and path magic disabled keeps it a plain path.
func validPathArg(p string) bool {
	return p != "" && !hasControlChars(p)
}

// validIdentity reports whether an author name/email is usable: non-empty and
// free of NUL/control characters (including newlines, which would forge extra
// header lines).
func validIdentity(s string) bool {
	return s != "" && !hasControlChars(s)
}

// hasControlChars reports whether s contains NUL or any control character.
func hasControlChars(s string) bool {
	for _, r := range s {
		if r == 0 || unicode.IsControl(r) {
			return true
		}
	}
	return false
}

// formatSignature renders a signature as git's `Name <email>` author value.
func formatSignature(s domain.Signature) string {
	return s.Name + " <" + s.Email + ">"
}

// stageFailed builds a typed STAGE_FAILED error with a trimmed, bounded message.
func stageFailed(message string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeStageFailed,
		Message: truncateValidUTF8(strings.TrimSpace(message), maxCheckoutErrLen),
	}
}

// stageFailedFromGit builds the STAGE_FAILED error for a failed staging git
// command: a short summary (using fallback when git emitted no error:/fatal:
// line) plus the bounded raw text for diagnostics.
func stageFailedFromGit(rawErr, fallback string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeStageFailed,
		Message: shortGitSummaryWithFallback(rawErr, fallback),
		Details: map[string]string{"raw": boundCheckoutRaw(rawErr)},
	}
}

// commitFailed builds a typed COMMIT_FAILED error with a trimmed, bounded message.
func commitFailed(message string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeCommitFailed,
		Message: truncateValidUTF8(strings.TrimSpace(message), maxCheckoutErrLen),
	}
}

// commitFailedFromGit builds the COMMIT_FAILED error for a failed `git commit`
// or oid resolution: a short summary plus the bounded raw text.
func commitFailedFromGit(rawErr string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeCommitFailed,
		Message: shortGitSummaryWithFallback(rawErr, "git commit failed"),
		Details: map[string]string{"raw": boundCheckoutRaw(rawErr)},
	}
}
