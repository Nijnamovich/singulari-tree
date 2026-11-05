package watcher

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/SingulariTree/go-core/internal/domain"
)

const eventTimeout = 5 * time.Second

// newTempRepo creates a temp directory with the minimal .git layout the adapter
// expects (HEAD, index, refs/heads, objects).
func newTempRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, sub := range []string{".git/refs/heads", ".git/objects"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", sub, err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatalf("write HEAD: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".git", "index"), []byte("index"), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	return dir
}

func staticResolver(root string) func(domain.RepositoryId) (string, bool) {
	return func(domain.RepositoryId) (string, bool) { return root, true }
}

func waitReady(t *testing.T, a *Adapter, id domain.RepositoryId) {
	t.Helper()
	ready := a.readyChan(id)
	if ready == nil {
		t.Fatalf("no subscription registered for %s", id)
	}
	select {
	case <-ready:
	case <-time.After(eventTimeout):
		t.Fatalf("watch for %s never became ready", id)
	}
}

func waitEvent(t *testing.T, ch <-chan domain.FsChangedEvent) domain.FsChangedEvent {
	t.Helper()
	select {
	case ev, ok := <-ch:
		if !ok {
			t.Fatal("event channel closed unexpectedly")
		}
		return ev
	case <-time.After(eventTimeout):
		t.Fatal("timed out waiting for a filesystem change event")
	}
	return domain.FsChangedEvent{}
}

// waitEventUntil reads events from ch until one satisfies pred, returning it. It
// exists because delivery order is not portable: registering a watch on Windows
// (ReadDirectoryChangesW) emits directory self-Write events, so the first batch
// can be `.git` / `.git\refs` metadata noise rather than the change under test,
// whereas on Linux (inotify) watch registration emits nothing. The predicate
// therefore matches on event content, not on batch position. It is bounded by
// eventTimeout so a genuinely missing event still fails.
func waitEventUntil(t *testing.T, ch <-chan domain.FsChangedEvent, pred func(domain.FsChangedEvent) bool) domain.FsChangedEvent {
	t.Helper()
	deadline := time.After(eventTimeout)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatal("event channel closed unexpectedly")
			}
			if pred(ev) {
				return ev
			}
			// Unrelated platform noise (e.g. a Windows directory self-Write
			// event): keep reading.
		case <-deadline:
			t.Fatal("timed out waiting for a matching filesystem change event")
		}
	}
}

func hasPath(ev domain.FsChangedEvent, want string) bool {
	for _, p := range ev.Paths {
		if p == want {
			return true
		}
	}
	return false
}

// TestAdapter_RealFsnotifyDetectsChange exercises the real fsnotify path. It is
// skipped in short mode and when fsnotify is unavailable or had to fall back to
// polling on this platform.
func TestAdapter_RealFsnotifyDetectsChange(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping fsnotify integration test in short mode")
	}
	if _, err := fsnotify.NewWatcher(); err != nil {
		t.Skipf("fsnotify unavailable on this platform: %v", err)
	}

	dir := newTempRepo(t)
	a := NewFsnotifyAdapter(staticResolver(dir))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch, err := a.Watch(ctx, "repo-real")
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}
	waitReady(t, a, "repo-real")
	if polling, _ := a.modeFor("repo-real"); polling {
		t.Skip("fsnotify watches could not be attached; adapter fell back to polling")
	}

	file := filepath.Join(dir, "hello.txt")
	if err := os.WriteFile(file, []byte("hi"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	// Wait for a batch that actually contains the file. On Windows, watch
	// registration emits .git / .git\refs directory self-Write events that can
	// precede the real change, so asserting on the first delivered batch would
	// be flaky; assert that an event containing the file eventually arrives.
	ev := waitEventUntil(t, ch, func(ev domain.FsChangedEvent) bool { return hasPath(ev, file) })
	if ev.RepoID != "repo-real" {
		t.Errorf("event RepoID = %q, want repo-real", ev.RepoID)
	}
	if !hasPath(ev, file) {
		t.Errorf("event paths = %v, want to contain %s", ev.Paths, file)
	}
}

// TestAdapter_PollingFallbackDetectsChange forces the fallback path and asserts
// a top-level worktree change is detected.
func TestAdapter_PollingFallbackDetectsChange(t *testing.T) {
	dir := newTempRepo(t)
	a := newAdapter(staticResolver(dir), adapterOptions{
		forcePoll:    true,
		pollInterval: 20 * time.Millisecond,
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch, err := a.Watch(ctx, "repo-poll")
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}
	waitReady(t, a, "repo-poll")
	if polling, _ := a.modeFor("repo-poll"); !polling {
		t.Fatal("expected the polling fallback to be active")
	}

	file := filepath.Join(dir, "created.txt")
	if err := os.WriteFile(file, []byte("new"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	ev := waitEvent(t, ch)
	if ev.RepoID != "repo-poll" {
		t.Errorf("event RepoID = %q, want repo-poll", ev.RepoID)
	}
	if !hasPath(ev, file) {
		t.Errorf("event paths = %v, want to contain %s", ev.Paths, file)
	}
}

// TestAdapter_UnwatchClosesOnceAndAllowsRewatch asserts Unwatch closes the
// channel exactly once, is idempotent and that a later Watch works again.
func TestAdapter_UnwatchClosesOnceAndAllowsRewatch(t *testing.T) {
	dir := newTempRepo(t)
	a := NewFsnotifyAdapter(staticResolver(dir))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch, err := a.Watch(ctx, "repo-uw")
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}
	waitReady(t, a, "repo-uw")

	// Drain events already buffered before unwatching. On Windows, registering
	// the .git / .git\refs watches emits directory self-Write events
	// (ReadDirectoryChangesW) that land in this buffered channel; Unwatch closes
	// the channel without draining it, and a closed Go channel still yields any
	// already-buffered values with ok == true, so without this drain the single
	// receive below could read a stale self-event instead of observing the close.
	// (TestAdapter_NilResolverIsNoOp drains for the same reason.)
drain:
	for {
		select {
		case <-ch:
		default:
			break drain
		}
	}

	if err := a.Unwatch("repo-uw"); err != nil {
		t.Fatalf("Unwatch: %v", err)
	}
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("channel still delivers events after Unwatch")
		}
	case <-time.After(eventTimeout):
		t.Fatal("channel was not closed by Unwatch")
	}
	if err := a.Unwatch("repo-uw"); err != nil {
		t.Fatalf("second Unwatch: %v", err)
	}

	// Re-subscribing after Unwatch must work and still detect changes.
	ch2, err := a.Watch(ctx, "repo-uw")
	if err != nil {
		t.Fatalf("re-Watch: %v", err)
	}
	waitReady(t, a, "repo-uw")

	file := filepath.Join(dir, "again.txt")
	if err := os.WriteFile(file, []byte("again"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	if !hasPath(waitEventUntil(t, ch2, func(ev domain.FsChangedEvent) bool { return hasPath(ev, file) }), file) {
		t.Errorf("re-watch did not report %s", file)
	}
}

// TestAdapter_NilResolverIsNoOp asserts a nil resolver degrades to a registered
// but silent subscription that can still be unwatched.
func TestAdapter_NilResolverIsNoOp(t *testing.T) {
	a := NewFsnotifyAdapter(nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch, err := a.Watch(ctx, "repo-none")
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}
	waitReady(t, a, "repo-none")

	a.Emit(domain.FsChangedEvent{RepoID: "repo-none", Paths: []string{"x"}})
	if ev := waitEvent(t, ch); !hasPath(ev, "x") {
		t.Errorf("Emit paths = %v, want x", ev.Paths)
	}

	if err := a.Unwatch("repo-none"); err != nil {
		t.Fatalf("Unwatch: %v", err)
	}
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("channel still open after Unwatch")
		}
	case <-time.After(eventTimeout):
		t.Fatal("channel not closed")
	}
}

// TestAdapter_WatchReplacesExistingSubscription asserts a second Watch for the
// same repo stops and closes the previous subscription.
func TestAdapter_WatchReplacesExistingSubscription(t *testing.T) {
	a := NewFsnotifyAdapter(nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch1, err := a.Watch(ctx, "repo-dup")
	if err != nil {
		t.Fatalf("first Watch: %v", err)
	}
	waitReady(t, a, "repo-dup")

	ch2, err := a.Watch(ctx, "repo-dup")
	if err != nil {
		t.Fatalf("second Watch: %v", err)
	}
	waitReady(t, a, "repo-dup")

	select {
	case _, ok := <-ch1:
		if ok {
			t.Fatal("previous subscription channel was not closed")
		}
	default:
		t.Fatal("previous subscription channel still open after replacement")
	}

	a.Emit(domain.FsChangedEvent{RepoID: "repo-dup", Paths: []string{"p"}})
	if ev := waitEvent(t, ch2); !hasPath(ev, "p") {
		t.Errorf("replacement paths = %v, want p", ev.Paths)
	}
	if err := a.Unwatch("repo-dup"); err != nil {
		t.Fatalf("Unwatch: %v", err)
	}
}

// TestAdapter_EmitUnknownRepoDoesNotPanic guards the drop path.
func TestAdapter_EmitUnknownRepoDoesNotPanic(t *testing.T) {
	a := NewFsnotifyAdapter(nil)
	a.Emit(domain.FsChangedEvent{RepoID: "nope"})
}

// TestResolveGitDirsGitfile proves the `.git`-as-gitfile case (linked
// worktree/submodule) resolves the real git dir, and that commondir is honoured.
func TestResolveGitDirsGitfile(t *testing.T) {
	t.Run("gitfile", func(t *testing.T) {
		root := t.TempDir()
		gitStore := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir: "+gitStore+"\n"), 0o644); err != nil {
			t.Fatalf("write gitfile: %v", err)
		}
		gitDir, commonDir := resolveGitDirs(root)
		if gitDir != gitStore || commonDir != gitStore {
			t.Fatalf("resolveGitDirs = (%q, %q), want (%q, %q)", gitDir, commonDir, gitStore, gitStore)
		}
	})

	t.Run("relative gitfile + commondir", func(t *testing.T) {
		root := t.TempDir()
		gitStore := filepath.Join(root, ".git-modules", "wt")
		if err := os.MkdirAll(gitStore, 0o755); err != nil {
			t.Fatalf("mkdir gitStore: %v", err)
		}
		if err := os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir: .git-modules/wt\n"), 0o644); err != nil {
			t.Fatalf("write gitfile: %v", err)
		}
		if err := os.WriteFile(filepath.Join(gitStore, "commondir"), []byte("../..\n"), 0o644); err != nil {
			t.Fatalf("write commondir: %v", err)
		}
		// The relative commondir resolves against gitStore, not root.
		wantCommon := filepath.Clean(filepath.Join(gitStore, "..", ".."))
		gitDir, commonDir := resolveGitDirs(root)
		if gitDir != gitStore {
			t.Errorf("gitDir = %q, want %q", gitDir, gitStore)
		}
		if commonDir != wantCommon {
			t.Errorf("commonDir = %q, want %q", commonDir, wantCommon)
		}
	})
}

// TestAdapter_PollingGitfileWatchesRealGitDir proves a `.git`-as-gitfile repo
// still emits change events for its real git dir (the fix for the silently
// skipped case).
func TestAdapter_PollingGitfileWatchesRealGitDir(t *testing.T) {
	root := t.TempDir()
	gitStore := t.TempDir()
	if err := os.MkdirAll(filepath.Join(gitStore, "refs", "heads"), 0o755); err != nil {
		t.Fatalf("mkdir refs: %v", err)
	}
	headFile := filepath.Join(gitStore, "HEAD")
	if err := os.WriteFile(headFile, []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatalf("write HEAD: %v", err)
	}
	if err := os.WriteFile(filepath.Join(gitStore, "index"), []byte("index"), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir: "+gitStore+"\n"), 0o644); err != nil {
		t.Fatalf("write gitfile: %v", err)
	}

	a := newAdapter(staticResolver(root), adapterOptions{forcePoll: true, pollInterval: 20 * time.Millisecond})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := a.Watch(ctx, "repo-gitfile")
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}
	waitReady(t, a, "repo-gitfile")

	// Change HEAD in the real git dir (different size -> detected by polling).
	if err := os.WriteFile(headFile, []byte("ref: refs/heads/other\n"), 0o644); err != nil {
		t.Fatalf("rewrite HEAD: %v", err)
	}
	ev := waitEvent(t, ch)
	if !hasPath(ev, headFile) {
		t.Errorf("event paths = %v, want to contain %s", ev.Paths, headFile)
	}
}
