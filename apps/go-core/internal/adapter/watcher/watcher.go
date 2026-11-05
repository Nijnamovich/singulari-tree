package watcher

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/SingulariTree/go-core/internal/domain"
)

// DefaultPollInterval is the cadence used by the polling fallback when fsnotify
// cannot be initialized or watches cannot be attached on the current platform.
const DefaultPollInterval = time.Second

const (
	// channelBuffer bounds the per-subscription event channel. Delivery is
	// dropped (non-blocking) when the subscriber is not reading.
	channelBuffer = 16
	// maxWorktreeDepth bounds the recursive worktree walk so a pathological
	// tree cannot register an unbounded number of watches.
	maxWorktreeDepth = 8
	// maxRefsDepth bounds the recursive .git/refs walk.
	maxRefsDepth = 16
)

// Adapter is the fsnotify + polling fallback implementation of
// domain.WatcherPort (service-design.md §4).
//
// It attaches fsnotify watches on the git metadata (.git, .git/refs recursively,
// .git/index via its parent, HEAD) and the worktree (recursively, bounded depth,
// skipping .git/objects) and forwards raw domain.FsChangedEvent batches to the
// per-repository channel. When fsnotify cannot be initialized, or an essential
// watch cannot be attached, it transparently degrades to periodic polling that
// stats the watched set and emits on change.
//
// Debounce/coalescing does NOT live here — it lives in service.WatcherService,
// which coalesces bursts into one callback per repository per window. This
// adapter pushes raw events; it only dedupes paths within a single drained
// batch.
type Adapter struct {
	resolve func(domain.RepositoryId) (string, bool)

	mu   sync.RWMutex
	subs map[domain.RepositoryId]*subscription

	opts adapterOptions
}

type adapterOptions struct {
	pollInterval time.Duration
	forcePoll    bool
}

// subscription is the per-repository watch state.
type subscription struct {
	ch        chan domain.FsChangedEvent
	cancel    context.CancelFunc
	done      chan struct{}
	ready     chan struct{}
	closeOnce sync.Once
	// polling records whether this subscription is running the polling fallback
	// (true) or a real fsnotify watcher (false). It is set before ready is
	// closed and read afterwards, so tests can assert which path was taken.
	polling atomic.Bool
}

// closeChan idempotently closes the subscription channel.
func (s *subscription) closeChan() {
	s.closeOnce.Do(func() { close(s.ch) })
}

// NewFsnotifyAdapter creates a watcher adapter that resolves a RepositoryId to
// an absolute filesystem path via resolve before attaching watches. A nil
// resolver degrades to a no-op watcher (subscriptions are registered but no
// filesystem events are produced).
func NewFsnotifyAdapter(resolve func(domain.RepositoryId) (string, bool)) *Adapter {
	return newAdapter(resolve, adapterOptions{pollInterval: DefaultPollInterval})
}

// newAdapter is the internal constructor with injectable options (used by tests
// to force the polling fallback and shorten the poll interval).
func newAdapter(resolve func(domain.RepositoryId) (string, bool), opts adapterOptions) *Adapter {
	if opts.pollInterval <= 0 {
		opts.pollInterval = DefaultPollInterval
	}
	return &Adapter{
		resolve: resolve,
		subs:    make(map[domain.RepositoryId]*subscription),
		opts:    opts,
	}
}

// Watch registers a buffered channel for repoID and returns it immediately. The
// watch attachment (and any fallback decision) happens on the subscription
// goroutine, so registration never blocks on the filesystem. The goroutine
// exits on ctx cancellation, on Unwatch, or when the underlying fsnotify
// watcher closes.
func (a *Adapter) Watch(ctx context.Context, repoID domain.RepositoryId) (<-chan domain.FsChangedEvent, error) {
	ch := make(chan domain.FsChangedEvent, channelBuffer)
	subCtx, cancel := context.WithCancel(ctx)
	s := &subscription{
		ch:     ch,
		cancel: cancel,
		done:   make(chan struct{}),
		ready:  make(chan struct{}),
	}

	a.mu.Lock()
	old := a.subs[repoID]
	a.subs[repoID] = s
	a.mu.Unlock()

	// Re-subscribing replaces the previous subscription. Stop it deterministically
	// so its goroutine and channel are reclaimed before the new one starts.
	if old != nil {
		old.cancel()
		<-old.done
		old.closeChan()
	}

	var path string
	if a.resolve != nil {
		if p, ok := a.resolve(repoID); ok {
			path = p
		}
	}

	go a.run(subCtx, repoID, path, s)
	return ch, nil
}

// run attaches watches (or falls back to polling) and forwards events until the
// context is cancelled or the watcher closes. It always finalizes the
// subscription: removing it from the map, closing done and closing the channel.
func (a *Adapter) run(ctx context.Context, repoID domain.RepositoryId, root string, s *subscription) {
	defer a.finish(repoID, s)

	if root == "" {
		close(s.ready)
		<-ctx.Done()
		return
	}

	var fw *fsnotify.Watcher
	if !a.opts.forcePoll {
		if w, err := fsnotify.NewWatcher(); err == nil {
			if err := a.addWatches(w, root); err != nil {
				_ = w.Close()
			} else {
				fw = w
			}
		}
	}

	if fw == nil {
		s.polling.Store(true)
		// Capture the baseline before signalling readiness so a test (or any
		// watcher) that changes the tree immediately after ready is still
		// detected on the first poll tick.
		baseline := a.snapshot(root)
		close(s.ready)
		a.pollLoop(ctx, repoID, root, baseline)
		return
	}

	close(s.ready)
	a.fsnotifyLoop(ctx, repoID, fw)
	_ = fw.Close()
}

// finish removes the subscription from the map (only if it is still current)
// and tears down its channels exactly once.
func (a *Adapter) finish(repoID domain.RepositoryId, s *subscription) {
	a.mu.Lock()
	if cur, ok := a.subs[repoID]; ok && cur == s {
		delete(a.subs, repoID)
	}
	a.mu.Unlock()
	close(s.done)
	s.closeChan()
}

// fsnotifyLoop reads raw fsnotify events, dedupes the paths of each drained
// batch and forwards one FsChangedEvent per batch. It returns when ctx is done
// or the watcher's Events channel closes.
func (a *Adapter) fsnotifyLoop(ctx context.Context, repoID domain.RepositoryId, fw *fsnotify.Watcher) {
	var (
		paths []string
		seen  = make(map[string]struct{})
	)
	add := func(p string) {
		if _, dup := seen[p]; dup {
			return
		}
		seen[p] = struct{}{}
		paths = append(paths, p)
	}
	flush := func() {
		if len(paths) == 0 {
			return
		}
		a.tryEmit(domain.FsChangedEvent{RepoID: repoID, Paths: paths})
		// Drop the backing array so the emitted slice is never mutated by the
		// next batch (consumers may hold it past the send).
		paths = nil
		seen = make(map[string]struct{})
	}

	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-fw.Events:
			if !ok {
				return
			}
			add(ev.Name)
			// Drain any events already queued so a burst becomes one batch
			// (deduped). This is NOT debouncing; WatcherService coalesces.
		drain:
			for {
				select {
				case ev2, ok2 := <-fw.Events:
					if !ok2 {
						flush()
						return
					}
					add(ev2.Name)
				default:
					break drain
				}
			}
			flush()
		case _, ok := <-fw.Errors:
			if !ok {
				return
			}
			// Transient watch errors are ignored; the fsnotify watcher keeps
			// delivering events on the Events channel.
		}
	}
}

// pollLoop is the fallback when fsnotify is unavailable. It periodically
// snapshots the watched set (git metadata and worktree top level) and emits a
// change event when anything differs. A send that is dropped (channel full)
// leaves the baseline unadvanced so the change is retried on the next tick.
func (a *Adapter) pollLoop(ctx context.Context, repoID domain.RepositoryId, root string, baseline pollState) {
	prev := baseline
	ticker := time.NewTicker(a.opts.pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			next := a.snapshot(root)
			changed := diffPoll(prev, next)
			if len(changed) == 0 {
				continue
			}
			if a.tryEmit(domain.FsChangedEvent{RepoID: repoID, Paths: changed}) {
				prev = next
			}
		}
	}
}

// Emit delivers an event to the repository's subscriber channel, dropping it
// when the subscriber is not reading. It does NOT debounce; coalescing is
// WatcherService's job (see service.WatcherService.Emit).
func (a *Adapter) Emit(evt domain.FsChangedEvent) {
	a.tryEmit(evt)
}

// tryEmit performs the non-blocking send and reports whether the event was
// delivered. The read lock is held across the send so Unwatch's write lock
// cannot close the channel underneath a concurrent sender.
func (a *Adapter) tryEmit(evt domain.FsChangedEvent) bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	s, ok := a.subs[evt.RepoID]
	if !ok {
		return false
	}
	select {
	case s.ch <- evt:
		return true
	default:
		return false
	}
}

// Unwatch removes the subscription, stops its goroutine/watcher and closes its
// channel exactly once. It is idempotent and safe to call on unknown repos or
// after the context has already cancelled the subscription.
func (a *Adapter) Unwatch(repoID domain.RepositoryId) error {
	a.mu.Lock()
	s, ok := a.subs[repoID]
	if ok {
		delete(a.subs, repoID)
	}
	a.mu.Unlock()
	if !ok {
		return nil
	}
	s.cancel()
	<-s.done
	s.closeChan()
	return nil
}

// readyChan exposes the subscription readiness signal. It exists so tests in
// this package can wait until watches are attached (or the fallback is chosen)
// before touching the filesystem.
func (a *Adapter) readyChan(repoID domain.RepositoryId) <-chan struct{} {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if s, ok := a.subs[repoID]; ok {
		return s.ready
	}
	return nil
}

// modeFor reports whether the subscription for repoID is running the polling
// fallback and whether such a subscription exists.
func (a *Adapter) modeFor(repoID domain.RepositoryId) (polling bool, ok bool) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	s, found := a.subs[repoID]
	if !found {
		return false, false
	}
	return s.polling.Load(), true
}

// resolveGitDirs returns the repository's git directory and its common
// directory, handling the `.git`-as-gitfile case used by linked worktrees and
// submodules. When `.git` is a file it contains `gitdir: <path>` (resolved
// relative to the worktree root); the common directory is read from
// `<gitDir>/commondir` when present (resolved relative to gitDir), falling back
// to gitDir itself for an ordinary repository.
func resolveGitDirs(root string) (gitDir, commonDir string) {
	gitDir = filepath.Join(root, ".git")
	if info, err := os.Stat(gitDir); err == nil && !info.IsDir() {
		if resolved, ok := readPointerFile(gitDir, root); ok {
			gitDir = resolved
		}
	}
	commonDir = gitDir
	if resolved, ok := readPointerFile(filepath.Join(gitDir, "commondir"), gitDir); ok {
		commonDir = resolved
	}
	return gitDir, commonDir
}

// readPointerFile reads a one-line pointer file (`.git` gitfile or
// `<gitDir>/commondir`). A `gitdir: ` prefix is stripped when present; an
// absolute path is returned as-is and a relative path is resolved against base.
func readPointerFile(path, base string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	value := strings.TrimSpace(string(data))
	value = strings.TrimSpace(strings.TrimPrefix(value, "gitdir:"))
	if value == "" {
		return "", false
	}
	if !filepath.IsAbs(value) {
		value = filepath.Join(base, value)
	}
	return filepath.Clean(value), true
}

// addWatches attaches the essential watches (worktree root, git dir and common
// dir) and best-effort recursive watches on the refs trees and the worktree.
// Only failures on the essential paths trigger the polling fallback; failures
// on individual subdirectories are skipped. A `.git`-as-gitfile (linked
// worktree/submodule) is resolved to the real git dir and common dir so its
// refs/HEAD are watched instead of silently skipped.
func (a *Adapter) addWatches(fw *fsnotify.Watcher, root string) error {
	if err := fw.Add(root); err != nil {
		return err
	}
	gitDir, commonDir := resolveGitDirs(root)
	for _, dir := range []string{gitDir, commonDir} {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			if err := fw.Add(dir); err != nil {
				return err
			}
		}
	}
	// Watching the git dir covers HEAD and index; the refs tree usually lives in
	// the common dir (shared across linked worktrees).
	a.addTree(fw, filepath.Join(commonDir, "refs"), 0, maxRefsDepth, skipDirNamedObjects)
	// Worktree root already added above; addTree is idempotent for the root and
	// skips nested .git directories and objects.
	a.addTree(fw, root, 0, maxWorktreeDepth, skipDotGitAndObjects)
	return nil
}

// addTree recursively adds directory watches under dir, bounded by maxDepth and
// skipping directories selected by skip. Errors are ignored: a subdirectory
// that cannot be watched should not disable watching for the whole repository.
func (a *Adapter) addTree(fw *fsnotify.Watcher, dir string, depth, maxDepth int, skip func(string) bool) {
	if depth > maxDepth {
		return
	}
	if skip != nil && skip(dir) {
		return
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return
	}
	_ = fw.Add(dir)
	if depth == maxDepth {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		child := filepath.Join(dir, e.Name())
		if skip != nil && skip(child) {
			continue
		}
		a.addTree(fw, child, depth+1, maxDepth, skip)
	}
}

func skipDirNamedObjects(path string) bool {
	return filepath.Base(path) == "objects"
}

func skipDotGitAndObjects(path string) bool {
	base := filepath.Base(path)
	return base == ".git" || base == "objects"
}

// pollStat is the cheap fingerprint of a watched path.
type pollStat struct {
	size    int64
	modUnix int64
}

// pollState maps absolute path -> fingerprint.
type pollState map[string]pollStat

// snapshot fingerprints the git metadata (index, HEAD, refs) and the worktree
// top-level entries. Missing paths are simply absent from the result.
func (a *Adapter) snapshot(root string) pollState {
	state := make(pollState)
	// Resolve the git dir and common dir so a `.git`-as-gitfile worktree still
	// has its real HEAD/index/refs fingerprinted.
	gitDir, commonDir := resolveGitDirs(root)

	statInto(state, filepath.Join(gitDir, "index"))
	statInto(state, filepath.Join(gitDir, "HEAD"))
	statInto(state, filepath.Join(commonDir, "packed-refs"))
	walkRefsInto(state, filepath.Join(commonDir, "refs"), maxRefsDepth)

	// Worktree top level: names captured via ReadDir, plus the stat of the root
	// itself so add/remove of entries is observed.
	statInto(state, root)
	if entries, err := os.ReadDir(root); err == nil {
		for _, e := range entries {
			if e.Name() == ".git" {
				continue
			}
			statInto(state, filepath.Join(root, e.Name()))
		}
	}
	return state
}

func statInto(state pollState, path string) {
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	state[path] = pollStat{size: info.Size(), modUnix: info.ModTime().UnixNano()}
}

// walkRefsInto fingerprints every file and directory under the refs tree.
func walkRefsInto(state pollState, dir string, maxDepth int) {
	walkRefs(state, dir, 0, maxDepth)
}

func walkRefs(state pollState, dir string, depth, maxDepth int) {
	if depth > maxDepth {
		return
	}
	info, err := os.Stat(dir)
	if err != nil {
		return
	}
	state[dir] = pollStat{size: info.Size(), modUnix: info.ModTime().UnixNano()}
	if !info.IsDir() || depth == maxDepth {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		walkRefs(state, filepath.Join(dir, e.Name()), depth+1, maxDepth)
	}
}

// diffPoll returns the sorted set of paths whose fingerprint was added,
// removed or changed between prev and next.
func diffPoll(prev, next pollState) []string {
	var changed []string
	for path, cur := range next {
		old, ok := prev[path]
		if !ok || old != cur {
			changed = append(changed, path)
		}
	}
	for path := range prev {
		if _, ok := next[path]; !ok {
			changed = append(changed, path)
		}
	}
	sort.Strings(changed)
	return changed
}
