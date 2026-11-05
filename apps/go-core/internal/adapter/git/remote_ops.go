// Remote network operations (Fetch/Pull/Push) with streaming progress.
//
// Progress is parsed from git's stderr (git writes transfer progress there) and
// delivered over a channel of domain.RemoteOpResult. The command runs in a
// background goroutine that always terminates on process EOF, command error, or
// context cancellation (risks.md R12) and closes the channel when done. A
// non-zero git exit after the stream started is delivered as a terminal result
// carrying a typed domain.AppError, so a rejected push / failed pull is never
// mistaken for success.
//
// All invocations pass the repository path via `-C` and never build a shell
// string (ADR-007); remote/branch/refspec arguments are additionally validated
// to reject values that could be interpreted as options or break argument
// boundaries.
package git

import (
	"bufio"
	"context"
	"io"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/SingulariTree/go-core/internal/domain"
)

// maxProgressLineLen bounds a single stderr progress line so a malformed or
// hostile stream cannot grow the buffer without limit.
const maxProgressLineLen = 4096

// maxProgressTailLines bounds how many trailing stderr lines are retained to
// describe a terminal command failure.
const maxProgressTailLines = 4

// progressPercentRE extracts the first "NN%" occurrence from a progress line,
// e.g. "Receiving objects:  45% (450/1000)" or "Resolving deltas: 100%".
var progressPercentRE = regexp.MustCompile(`(\d{1,3})%`)

// remoteOpKind identifies which remote operation is streaming so failures map
// to the correct typed AppError code.
type remoteOpKind string

const (
	opFetch remoteOpKind = "fetch"
	opPush  remoteOpKind = "push"
	opPull  remoteOpKind = "pull"
)

// errCode returns the domain AppError code for this operation.
func (k remoteOpKind) errCode() string {
	switch k {
	case opPush:
		return domain.ErrCodePushFailed
	case opPull:
		return domain.ErrCodePullFailed
	default:
		return domain.ErrCodeFetchFailed
	}
}

// Fetch downloads objects for remote into local remote-tracking refs, streaming
// progress followed by an optional terminal error.
func (a *Adapter) Fetch(ctx context.Context, repoID domain.RepositoryId, remote string, opts domain.RemoteOpOptions) (<-chan domain.RemoteOpResult, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	if err := validateRemoteArgs(opFetch, remote, "", opts); err != nil {
		return nil, err
	}
	if err := a.ensureRemote(ctx, fsPath, remote, opFetch.errCode()); err != nil {
		return nil, err
	}
	return streamGitProgress(ctx, fsPath, opFetch, buildFetchArgs(remote, opts))
}

// Push publishes branch to remote, streaming progress followed by an optional
// terminal error. When opts.RemoteBranch is set and differs from branch, the
// target is `branch:remoteBranch` (previously-deferred push.remoteBranch).
func (a *Adapter) Push(ctx context.Context, repoID domain.RepositoryId, remote, branch string, opts domain.RemoteOpOptions) (<-chan domain.RemoteOpResult, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	if err := validateRemoteArgs(opPush, remote, branch, opts); err != nil {
		return nil, err
	}
	if err := a.ensureRemote(ctx, fsPath, remote, opPush.errCode()); err != nil {
		return nil, err
	}
	return streamGitProgress(ctx, fsPath, opPush, buildPushArgs(remote, branch, opts))
}

// Pull fetches and integrates remote branch, streaming progress followed by an
// optional terminal error. When opts.LocalBranch is set and differs from branch,
// the target is `branch:localBranch` (previously-deferred pull.intoLocal).
func (a *Adapter) Pull(ctx context.Context, repoID domain.RepositoryId, remote, branch string, opts domain.RemoteOpOptions) (<-chan domain.RemoteOpResult, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	if err := validateRemoteArgs(opPull, remote, branch, opts); err != nil {
		return nil, err
	}
	if err := a.ensureRemote(ctx, fsPath, remote, opPull.errCode()); err != nil {
		return nil, err
	}
	return streamGitProgress(ctx, fsPath, opPull, buildPullArgs(remote, branch, opts))
}

// buildFetchArgs assembles `git fetch --progress` plus the additive flags.
func buildFetchArgs(remote string, opts domain.RemoteOpOptions) []string {
	args := []string{"fetch", "--progress"}
	if opts.Prune {
		args = append(args, "--prune") // previously-deferred fetch.prune
	}
	if opts.Tags {
		args = append(args, "--tags") // previously-deferred fetch.tags
	}
	if opts.Force {
		args = append(args, "--force") // previously-deferred fetch.overwriteTags
	}
	if remote != "" {
		args = append(args, remote)
	}
	return args
}

// buildPushArgs assembles `git push --progress` plus the additive flags.
func buildPushArgs(remote, branch string, opts domain.RemoteOpOptions) []string {
	args := []string{"push", "--progress"}
	if opts.Force {
		args = append(args, "--force") // previously-deferred push.force
	}
	if opts.Tags {
		args = append(args, "--tags") // previously-deferred push.tags
	}
	if opts.SetUpstream {
		args = append(args, "--set-upstream") // previously-deferred push.track
	}
	if remote != "" {
		args = append(args, remote)
	}
	if branch != "" {
		target := branch
		if opts.RemoteBranch != "" && opts.RemoteBranch != branch {
			target = branch + ":" + opts.RemoteBranch // previously-deferred push.remoteBranch
		}
		args = append(args, target)
	}
	return args
}

// buildPullArgs assembles `git pull --progress` plus the additive flags.
func buildPullArgs(remote, branch string, opts domain.RemoteOpOptions) []string {
	args := []string{"pull", "--progress"}
	if opts.NoCommit {
		args = append(args, "--no-commit") // previously-deferred pull.commitMerged
	}
	if opts.Log {
		args = append(args, "--log") // previously-deferred pull.includeMergedMessages
	}
	if opts.NoFF {
		args = append(args, "--no-ff") // previously-deferred pull.noFF
	}
	if opts.Rebase {
		args = append(args, "--rebase") // previously-deferred pull.rebase
	}
	if remote != "" {
		args = append(args, remote)
	}
	if branch != "" {
		target := branch
		if opts.LocalBranch != "" && opts.LocalBranch != branch {
			target = branch + ":" + opts.LocalBranch // previously-deferred pull.intoLocal
		}
		args = append(args, target)
	}
	return args
}

// checkSafeArg reports whether value is safe to pass as a bare git argument:
// non-empty values must not start with '-' (which git would parse as an option)
// and must not contain whitespace, control characters or NUL. It is used for the
// remote value, which may be a URL or filesystem path.
func checkSafeArg(value string) bool {
	if value == "" {
		return true
	}
	if strings.HasPrefix(value, "-") {
		return false
	}
	for _, r := range value {
		if r == 0 || unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// invalidRefChars are characters git forbids in a ref/branch name (see
// `git check-ref-format`). Backslash is included; ':' would also break the
// `branch:remote_branch` refspec mapping.
const invalidRefChars = "~^:?*[\\"

// checkSafeRef reports whether value is a safe, syntactically plausible
// branch/ref name to pass as a bare git argument. Beyond the generic argument
// check it rejects a leading '+' — git treats `+<ref>` as a forced ref update,
// which would silently turn a non-force push/pull into a force one — and the
// ref-syntax characters git disallows.
func checkSafeRef(value string) bool {
	if value == "" {
		return true
	}
	if strings.HasPrefix(value, "-") || strings.HasPrefix(value, "+") {
		return false
	}
	for _, r := range value {
		if r == 0 || unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	if strings.ContainsAny(value, invalidRefChars) ||
		strings.Contains(value, "..") ||
		strings.Contains(value, "//") ||
		strings.Contains(value, "@{") ||
		strings.HasPrefix(value, "/") ||
		strings.HasSuffix(value, "/") ||
		strings.HasSuffix(value, ".") ||
		strings.HasSuffix(value, ".lock") {
		return false
	}
	return true
}

// validateRemoteArgs rejects unsafe/nonsensical argument combinations for a
// remote operation before any process is spawned. Branch-like values get the
// stricter checkSafeRef validation; the remote value (which may be a URL/path)
// keeps the generic option-injection check.
func validateRemoteArgs(op remoteOpKind, remote, branch string, opts domain.RemoteOpOptions) error {
	for _, f := range []struct {
		name  string
		value string
		ref   bool
	}{
		{"remote", remote, false},
		{"branch", branch, true},
		{"remote_branch", opts.RemoteBranch, true},
		{"local_branch", opts.LocalBranch, true},
	} {
		ok := checkSafeArg(f.value)
		if f.ref {
			ok = checkSafeRef(f.value)
		}
		if !ok {
			return domain.AppError{
				Code:    op.errCode(),
				Message: "invalid " + f.name + " value",
			}.WithDetail("field", f.name)
		}
	}
	if op == opPush && branch == "" && opts.RemoteBranch != "" {
		return domain.AppError{
			Code:    op.errCode(),
			Message: "remote_branch requires a local branch",
		}
	}
	return nil
}

// looksLikeRemoteName reports whether s is plausibly a configured remote name
// (as opposed to a URL or filesystem path). Only names are preflighted against
// `git remote get-url`; URLs/paths are passed straight to git.
func looksLikeRemoteName(s string) bool {
	return s != "" && !strings.ContainsAny(s, "/:\\")
}

// ensureRemote verifies that a named remote exists, mapping an unknown remote to
// a typed AppError so the failure is surfaced synchronously instead of only as a
// mid-stream git message.
func (a *Adapter) ensureRemote(ctx context.Context, fsPath, remote, code string) error {
	if !looksLikeRemoteName(remote) {
		return nil
	}
	if _, _, err := runGitAllowExit(ctx, fsPath, "remote", "get-url", remote); err != nil {
		return domain.AppError{
			Code:    code,
			Message: "unknown remote " + remote,
		}.WithDetail("remote", remote)
	}
	return nil
}

// streamGitProgress starts `git -C dir <args...>` with --progress and returns a
// channel of parsed RemoteOpResult items. The command's stderr is read in a
// background goroutine that terminates on EOF, process error or context
// cancellation, always closing the channel (R12). A start chunk is emitted so
// consumers observe at least one event even for no-op operations. A non-zero
// exit status after the stream started is delivered as a terminal result with a
// typed AppError; a context cancellation closes the channel silently.
func streamGitProgress(ctx context.Context, dir string, op remoteOpKind, args []string) (<-chan domain.RemoteOpResult, error) {
	full := append([]string{"-C", dir}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Env = gitCommandEnv()
	// Bound how long Wait may block on I/O. exec.CommandContext kills only git
	// itself; a grandchild that inherited git's stderr write end (e.g. a
	// GIT_SSH_COMMAND transport helper) can keep the pipe open after the kill,
	// which would otherwise leave Wait pending well past the deadline. WaitDelay
	// forces the process pipes closed shortly after cancellation (R12).
	cmd.WaitDelay = 2 * time.Second
	// On cancellation, kill the direct child AND its transport tree. The default
	// Cancel kills only git; git's transport helper (GIT_SSH_COMMAND) runs under a
	// shell wrapper that inherits the repo as its cwd, and Windows refuses to
	// delete a directory held as any live process's cwd — an orphaned transport
	// would keep the repo undeletable. See process_tree_windows.go.
	cmd.Cancel = func() error { return cancelProcessTree(cmd.Process) }
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, domain.AppError{Code: op.errCode(), Message: err.Error()}
	}
	if err := cmd.Start(); err != nil {
		return nil, domain.AppError{Code: op.errCode(), Message: err.Error()}
	}

	ch := make(chan domain.RemoteOpResult, 16)
	go func() {
		// close() is registered first so, LIFO, the process is reaped and any
		// terminal result delivered before the channel closes.
		defer close(ch)

		if !sendResult(ctx, ch, domain.RemoteOpResult{Progress: &domain.Progress{Percent: 0, Message: "git " + string(op) + " started"}}) {
			_ = cmd.Wait()
			return
		}
		// Drain stderr to EOF first (Wait must not race the pipe reader), then
		// reap the process to obtain its exit status. readProgressLines returns
		// the tail of git's stderr so a post-spawn failure can be reported. The
		// pipe is wrapped in a ctx-aware reader so a read blocked on an orphaned
		// grandchild aborts as soon as the context is cancelled (R12).
		tail := readProgressLines(ctx, &ctxReader{ctx: ctx, r: stderr}, ch)
		waitErr := cmd.Wait()

		// A killed process is a cancellation, not an operation failure: stop
		// silently (R12).
		if ctx.Err() != nil {
			return
		}
		if waitErr != nil {
			msg := strings.TrimSpace(tail)
			if msg == "" {
				msg = waitErr.Error()
			}
			_ = sendResult(ctx, ch, domain.RemoteOpResult{Err: domain.AppError{
				Code:    op.errCode(),
				Message: msg,
			}})
		}
	}()
	return ch, nil
}

// ctxReader wraps the process's stderr pipe so that a Read blocked on an
// orphaned writer is abandoned as soon as ctx is cancelled. exec.CommandContext
// kills only git itself; a grandchild that inherited the pipe's write end (the
// GIT_SSH_COMMAND transport helper, for instance) can keep it open past
// cancellation, which previously left the progress goroutine blocked in Read
// until that grandchild exited on its own (R12 — streaming cleanup).
//
// Each Read hands the underlying blocking read to a short-lived worker
// goroutine that writes into a buffer it exclusively owns and delivers the
// result over a channel buffered to capacity 1, so the worker can never block
// the caller (and never races on the caller's buffer). On cancellation Read
// returns ctx.Err() immediately and no further worker is spawned; the parked
// worker stays bound to the pipe and exits once the pipe is closed, which
// cmd.Wait always does after reaping the process (cmd.WaitDelay bounds that
// wait), so the goroutine cannot leak.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

// readResult carries one underlying read back to ctxReader.Read's caller.
type readResult struct {
	data []byte
	err  error
}

// Read implements io.Reader for ctxReader.
func (c *ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	done := make(chan readResult, 1) // buffered: the worker never blocks on send
	go func() {
		buf := make([]byte, len(p))
		n, err := c.r.Read(buf)
		done <- readResult{data: buf[:n], err: err}
	}()
	select {
	case res := <-done:
		return copy(p, res.data), res.err
	case <-c.ctx.Done():
		return 0, c.ctx.Err()
	}
}

// readProgressLines decodes stderr incrementally, splitting on both '\n' and
// '\r' (git redraws transfer progress with carriage returns) and emitting one
// Progress per line until EOF or context cancellation. It returns a short tail
// of the most relevant stderr text (preferring the first fatal/error/rejected
// line) for use as a terminal error message.
func readProgressLines(ctx context.Context, r io.Reader, ch chan<- domain.RemoteOpResult) string {
	br := bufio.NewReaderSize(r, 32*1024)
	line := make([]byte, 0, 128)
	var tail []string
	var errLine string
	record := func(raw string) {
		s := strings.TrimSpace(strings.TrimRight(raw, "\r"))
		if s == "" {
			return
		}
		if errLine == "" && (strings.HasPrefix(s, "fatal:") || strings.HasPrefix(s, "error:") || strings.Contains(s, "rejected")) {
			errLine = s
		}
		tail = append(tail, s)
		if len(tail) > maxProgressTailLines {
			tail = tail[len(tail)-maxProgressTailLines:]
		}
	}
	flush := func() bool {
		if len(line) == 0 {
			return true
		}
		raw := string(line)
		line = line[:0]
		record(raw)
		p := parseProgressLine(raw)
		return sendResult(ctx, ch, domain.RemoteOpResult{Progress: &p})
	}
	for {
		// Abort promptly once the context is cancelled: the wrapped reader also
		// unblocks a pending byte read, but checking here avoids emitting any
		// further progress after cancellation (R12).
		if ctx.Err() != nil {
			return stderrTail(errLine, tail)
		}
		b, err := br.ReadByte()
		if err != nil {
			break
		}
		if b == '\n' || b == '\r' {
			if !flush() {
				return stderrTail(errLine, tail)
			}
			continue
		}
		if len(line) < maxProgressLineLen {
			line = append(line, b)
		}
	}
	if ctx.Err() != nil {
		return stderrTail(errLine, tail)
	}
	flush()
	return stderrTail(errLine, tail)
}

// stderrTail returns the message describing a failed git process: the first
// fatal/error/rejected line when present, otherwise the last few stderr lines.
func stderrTail(errLine string, tail []string) string {
	if errLine != "" {
		return errLine
	}
	return strings.Join(tail, "\n")
}

// sendResult delivers one stream item unless the context is cancelled first.
func sendResult(ctx context.Context, ch chan<- domain.RemoteOpResult, r domain.RemoteOpResult) bool {
	select {
	case ch <- r:
		return true
	case <-ctx.Done():
		return false
	}
}

// parseProgressLine extracts the percentage (clamped to 0..100) from a git
// stderr line; lines without a percentage are emitted as message-only chunks.
func parseProgressLine(raw string) domain.Progress {
	line := strings.TrimSpace(strings.TrimRight(raw, "\r"))
	p := domain.Progress{Message: line}
	if m := progressPercentRE.FindStringSubmatch(line); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil {
			if n < 0 {
				n = 0
			}
			if n > 100 {
				n = 100
			}
			p.Percent = uint32(n)
		}
	}
	return p
}
