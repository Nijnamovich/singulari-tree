package git

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/SingulariTree/go-core/internal/domain"
)

// initBareRemote creates a bare repository usable as a local file remote.
func initBareRemote(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitRun(t, dir, "init", "--bare", "-q")
	return dir
}

// drainProgress collects progress chunks until the channel closes, returning
// them together with the terminal error (nil when the operation succeeded) and
// failing on timeout.
func drainProgress(t *testing.T, ch <-chan domain.RemoteOpResult) ([]domain.Progress, error) {
	t.Helper()
	var out []domain.Progress
	var terminal error
	deadline := time.After(20 * time.Second)
	for {
		select {
		case r, ok := <-ch:
			if !ok {
				return out, terminal
			}
			if r.Err != nil {
				terminal = r.Err
				continue
			}
			if r.Progress != nil {
				out = append(out, *r.Progress)
			}
		case <-deadline:
			t.Fatal("timed out waiting for the result channel to close")
			return nil, nil
		}
	}
}

func assertAppCode(t *testing.T, err error, code string) {
	t.Helper()
	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want typed AppError with code %s", err, code)
	}
	if appErr.Code != code {
		t.Fatalf("err code = %q, want %q (err=%v)", appErr.Code, code, err)
	}
}

func TestBuildRemoteArgs(t *testing.T) {
	all := domain.RemoteOpOptions{Prune: true, Tags: true, Force: true, SetUpstream: true, RemoteBranch: "target", LocalBranch: "local", NoCommit: true, Log: true, NoFF: true, Rebase: true}

	cases := []struct {
		name string
		got  []string
		want []string
	}{
		{
			name: "fetch all flags",
			got:  buildFetchArgs("origin", all),
			want: []string{"fetch", "--progress", "--prune", "--tags", "--force", "origin"},
		},
		{
			name: "fetch empty remote",
			got:  buildFetchArgs("", domain.RemoteOpOptions{}),
			want: []string{"fetch", "--progress"},
		},
		{
			name: "push renamed branch with upstream",
			got:  buildPushArgs("origin", "main", all),
			want: []string{"push", "--progress", "--force", "--tags", "--set-upstream", "origin", "main:target"},
		},
		{
			name: "push same-name branch",
			got:  buildPushArgs("origin", "main", domain.RemoteOpOptions{}),
			want: []string{"push", "--progress", "origin", "main"},
		},
		{
			name: "pull all flags into local",
			got:  buildPullArgs("origin", "main", all),
			want: []string{"pull", "--progress", "--no-commit", "--log", "--no-ff", "--rebase", "origin", "main:local"},
		},
		{
			name: "pull no branch",
			got:  buildPullArgs("origin", "", domain.RemoteOpOptions{}),
			want: []string{"pull", "--progress", "origin"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if !reflect.DeepEqual(tc.got, tc.want) {
				t.Fatalf("args = %v, want %v", tc.got, tc.want)
			}
		})
	}
}

func TestParseProgressLine(t *testing.T) {
	cases := []struct {
		in      string
		percent uint32
	}{
		{"Receiving objects:  45% (450/1000)", 45},
		{"remote: Counting objects: 100% (5/5), done.", 100},
		{"Resolving deltas: 100%", 100},
		{"Writing objects: 3% (1/30)", 3},
		{"Writing objects: 250%", 100},
		{"From /tmp/remote", 0},
		{"Already up to date.", 0},
	}
	for _, tc := range cases {
		got := parseProgressLine(tc.in)
		if got.Percent != tc.percent {
			t.Errorf("parseProgressLine(%q).Percent = %d, want %d", tc.in, got.Percent, tc.percent)
		}
		if got.Percent > 100 {
			t.Errorf("parseProgressLine(%q).Percent = %d, want <= 100", tc.in, got.Percent)
		}
	}
}

func TestCheckSafeArg(t *testing.T) {
	cases := []struct {
		in   string
		safe bool
	}{
		{"origin", true},
		{"", true},
		{"feature/x", true},
		{"-evil", false},
		{"a b", false},
		{"a\tb", false},
		{"a\nb", false},
		{"a\x00b", false},
	}
	for _, tc := range cases {
		if got := checkSafeArg(tc.in); got != tc.safe {
			t.Errorf("checkSafeArg(%q) = %v, want %v", tc.in, got, tc.safe)
		}
	}
}

func TestCheckSafeRef(t *testing.T) {
	cases := []struct {
		in   string
		safe bool
	}{
		{"main", true},
		{"feature/x", true},
		{"HEAD", true},
		{"v1.0", true},
		{"", true},
		{"+main", false}, // force-refspec prefix would silently force-update
		{"-evil", false},
		{"main:other", false},
		{"a b", false},
		{"a\tb", false},
		{"a\nb", false},
		{"a\x00b", false},
		{"a..b", false},
		{"a//b", false},
		{"refs/heads/", false},
		{"v1.", false},
		{"foo.lock", false},
		{"a@{b}", false},
		{"a~b", false},
		{"a^b", false},
		{"a*b", false},
		{"a[b", false},
		{"a\\b", false},
	}
	for _, tc := range cases {
		if got := checkSafeRef(tc.in); got != tc.safe {
			t.Errorf("checkSafeRef(%q) = %v, want %v", tc.in, got, tc.safe)
		}
	}
}

func TestFetchLocalRemoteStreamsAndUpdatesRef(t *testing.T) {
	src := initRepo(t)
	gitRun(t, src, "branch", "-M", "main")
	bare := initBareRemote(t)
	gitRun(t, src, "remote", "add", "origin", bare)
	gitRun(t, src, "push", "-q", "-u", "origin", "main")
	// Drop the remote-tracking ref so the fetch must recreate it.
	gitRun(t, src, "update-ref", "-d", "refs/remotes/origin/main")

	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: src})

	ch, err := a.Fetch(context.Background(), repoID, "origin", domain.RemoteOpOptions{})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	chunks, terminal := drainProgress(t, ch)
	if terminal != nil {
		t.Fatalf("Fetch terminal error: %v", terminal)
	}
	if len(chunks) == 0 {
		t.Fatal("Fetch produced no progress chunks")
	}
	for _, p := range chunks {
		if p.Percent > 100 {
			t.Errorf("chunk percent = %d, want <= 100", p.Percent)
		}
	}

	head := gitRun(t, src, "rev-parse", "HEAD")
	got := gitRun(t, src, "rev-parse", "refs/remotes/origin/main")
	if got != head {
		t.Errorf("refs/remotes/origin/main = %s, want HEAD %s", got, head)
	}
}

func TestPushLocalRemoteStreams(t *testing.T) {
	src := initRepo(t)
	gitRun(t, src, "branch", "-M", "main")
	bare := initBareRemote(t)
	gitRun(t, src, "remote", "add", "origin", bare)

	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: src})

	ch, err := a.Push(context.Background(), repoID, "origin", "main", domain.RemoteOpOptions{SetUpstream: true})
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	chunks, terminal := drainProgress(t, ch)
	if terminal != nil {
		t.Fatalf("Push terminal error: %v", terminal)
	}
	if len(chunks) == 0 {
		t.Fatal("Push produced no progress chunks")
	}

	head := gitRun(t, src, "rev-parse", "HEAD")
	if got := gitRun(t, bare, "rev-parse", "refs/heads/main"); got != head {
		t.Errorf("remote refs/heads/main = %s, want %s", got, head)
	}
}

// TestPushNonFastForwardStreamsTerminalError is the regression test for the
// blocker: a rejected non-fast-forward push must emit a terminal PUSH_FAILED
// result, never a clean channel close that the renderer would read as success.
func TestPushNonFastForwardStreamsTerminalError(t *testing.T) {
	bare := initBareRemote(t)
	src := initRepo(t)
	gitRun(t, src, "branch", "-M", "main")
	gitRun(t, src, "remote", "add", "origin", bare)
	gitRun(t, src, "push", "-q", "-u", "origin", "main")
	// Point the bare repo's HEAD at main so the second clone lands on it.
	gitRun(t, bare, "symbolic-ref", "HEAD", "refs/heads/main")

	// A second clone advances the remote, so src diverges behind it.
	otherParent := t.TempDir()
	other := filepath.Join(otherParent, "clone")
	gitRun(t, otherParent, "clone", "-q", bare, "clone")
	gitRun(t, other, "config", "user.email", "bob@example.com")
	gitRun(t, other, "config", "user.name", "Bob")
	gitRun(t, other, "config", "commit.gpgsign", "false")
	writeFile(t, filepath.Join(other, "remote.txt"), "remote\n")
	gitRun(t, other, "add", ".")
	gitRun(t, other, "commit", "-q", "-m", "remote change")
	gitRun(t, other, "push", "-q", "origin", "main")

	// src now has its own divergent commit; the push must be rejected.
	writeFile(t, filepath.Join(src, "local.txt"), "local\n")
	gitRun(t, src, "add", ".")
	gitRun(t, src, "commit", "-q", "-m", "local change")

	a := NewAdapter(&fakeRepoPort{fsPath: src})
	ch, err := a.Push(context.Background(), domain.RepositoryId("repo-1"), "origin", "main", domain.RemoteOpOptions{})
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	chunks, terminal := drainProgress(t, ch)
	if len(chunks) == 0 {
		t.Fatal("Push produced no progress chunks before the failure")
	}
	if terminal == nil {
		t.Fatal("non-fast-forward push closed cleanly, want a terminal PUSH_FAILED error")
	}
	assertAppCode(t, terminal, domain.ErrCodePushFailed)
}

// TestPushRemoteBranchCreatesTargetRef proves the previously-deferred
// push.remoteBranch mapping actually targets a differently-named remote ref.
func TestPushRemoteBranchCreatesTargetRef(t *testing.T) {
	src := initRepo(t)
	gitRun(t, src, "branch", "-M", "main")
	bare := initBareRemote(t)
	gitRun(t, src, "remote", "add", "origin", bare)

	a := NewAdapter(&fakeRepoPort{fsPath: src})
	ch, err := a.Push(context.Background(), domain.RepositoryId("repo-1"), "origin", "main", domain.RemoteOpOptions{RemoteBranch: "renamed"})
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if _, terminal := drainProgress(t, ch); terminal != nil {
		t.Fatalf("Push terminal error: %v", terminal)
	}

	head := gitRun(t, src, "rev-parse", "HEAD")
	if got := gitRun(t, bare, "rev-parse", "refs/heads/renamed"); got != head {
		t.Errorf("remote refs/heads/renamed = %s, want HEAD %s", got, head)
	}
	if _, _, err := runGitAllowExit(context.Background(), bare, "rev-parse", "--verify", "refs/heads/main"); err == nil {
		t.Error("refs/heads/main exists but the push should have targeted only refs/heads/renamed")
	}
}

// TestPushRejectsForceRefspecBranch asserts the `+` force-refspec bypass is
// rejected with a typed error before any process is spawned.
func TestPushRejectsForceRefspecBranch(t *testing.T) {
	src := initRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: src})

	if _, err := a.Push(context.Background(), domain.RepositoryId("repo-1"), "origin", "+main", domain.RemoteOpOptions{}); err == nil {
		t.Fatal("Push(branch=+main) succeeded, want PUSH_FAILED")
	} else {
		assertAppCode(t, err, domain.ErrCodePushFailed)
	}

	// Same rejection for the remote_branch/local_branch refspec components.
	if err := validateRemoteArgs(opPush, "origin", "main", domain.RemoteOpOptions{RemoteBranch: "+evil"}); err == nil {
		t.Fatal("validateRemoteArgs(remote_branch=+evil) succeeded, want error")
	} else {
		assertAppCode(t, err, domain.ErrCodePushFailed)
	}
	if err := validateRemoteArgs(opPull, "origin", "main", domain.RemoteOpOptions{LocalBranch: "+evil"}); err == nil {
		t.Fatal("validateRemoteArgs(local_branch=+evil) succeeded, want error")
	} else {
		assertAppCode(t, err, domain.ErrCodePullFailed)
	}
}

func TestRemoteOpUnknownRemoteMapsTypedError(t *testing.T) {
	src := initRepo(t)
	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: src})
	ctx := context.Background()

	if _, err := a.Fetch(ctx, repoID, "bogus", domain.RemoteOpOptions{}); err != nil {
		assertAppCode(t, err, domain.ErrCodeFetchFailed)
	} else {
		t.Fatal("Fetch(bogus) succeeded, want FETCH_FAILED")
	}

	if _, err := a.Push(ctx, repoID, "bogus", "main", domain.RemoteOpOptions{}); err != nil {
		assertAppCode(t, err, domain.ErrCodePushFailed)
	} else {
		t.Fatal("Push(bogus) succeeded, want PUSH_FAILED")
	}

	if _, err := a.Pull(ctx, repoID, "bogus", "main", domain.RemoteOpOptions{}); err != nil {
		assertAppCode(t, err, domain.ErrCodePullFailed)
	} else {
		t.Fatal("Pull(bogus) succeeded, want PULL_FAILED")
	}

	// Unsafe argument must be rejected before any process is spawned.
	if _, err := a.Fetch(ctx, repoID, "-evil", domain.RemoteOpOptions{}); err != nil {
		assertAppCode(t, err, domain.ErrCodeFetchFailed)
	} else {
		t.Fatal("Fetch(-evil) succeeded, want FETCH_FAILED")
	}
}

// TestFetchContextCancellationClosesChannel drives the R12 path: a fetch that
// blocks in the ssh transport is cancelled and the progress channel must close
// so the goroutine does not leak.
func TestFetchContextCancellationClosesChannel(t *testing.T) {
	src := initRepo(t)
	gitRun(t, src, "branch", "-M", "main")
	gitRun(t, src, "remote", "add", "origin", "ssh://git@example.invalid/repo.git")
	// Git runs this shim in place of ssh, through its own transport shell
	// wrapper (`sh -c '<shim> "$@"' <shim> <host> <upload-pack cmd>`, the form
	// GIT_TRACE shows) that inherits the cwd git was given — the repo, via
	// `git -C <repo>`. `sleep 5` keeps the fetch in flight past the 300ms
	// deadline, so cancellation happens mid-transport. On cancellation
	// exec.CommandContext kills only git itself; the transport tree outlives it
	// as an orphan and keeps the repo as its cwd. A shim-side `cd /` cannot move
	// the surviving wrapper's own cwd — the `cd` runs in a forked subshell, so
	// only the leaf chain reaches the msys root — and Windows refuses to delete
	// a directory that is any live process's cwd, so t.TempDir's RemoveAll would
	// fail with "being used by another process". The shim's `cd /` prefix is
	// retained deliberately as defense-in-depth (it does move the leaf chain off
	// the repo), but the cleanup guarantee is the adapter tearing down the
	// spawned process tree on cancellation (process_tree_windows.go). The R12
	// assertion — the progress channel must close on cancellation — is unchanged.
	t.Setenv("GIT_SSH_COMMAND", "cd / && exec sh -c 'exec sleep 5' --")

	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: src})

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	ch, err := a.Fetch(ctx, repoID, "origin", domain.RemoteOpOptions{})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}

	done := make(chan struct{})
	go func() {
		for range ch {
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("progress channel did not close after context cancellation (goroutine leak, R12)")
	}
}
