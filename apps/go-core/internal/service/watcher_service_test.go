package service

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/SingulariTree/go-core/internal/domain"
)

// fakeScheduler is a deterministic timerScheduler: timers only fire when the
// test calls fireAll, so debounce behaviour can be asserted without sleeping.
type fakeScheduler struct {
	mu     sync.Mutex
	nextID int
	timers map[int]*fakeTimer
}

type fakeTimer struct {
	sched   *fakeScheduler
	id      int
	stopped bool
	fired   bool
	fn      func()
}

func newFakeScheduler() *fakeScheduler {
	return &fakeScheduler{timers: make(map[int]*fakeTimer)}
}

func (fs *fakeScheduler) afterFunc(_ time.Duration, fn func()) timerHandle {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	id := fs.nextID
	fs.nextID++
	t := &fakeTimer{sched: fs, id: id, fn: fn}
	fs.timers[id] = t
	return t
}

func (t *fakeTimer) Stop() bool {
	t.sched.mu.Lock()
	defer t.sched.mu.Unlock()
	if t.stopped || t.fired {
		return false
	}
	t.stopped = true
	return true
}

// fireAll simulates expiry of every currently-armed timer.
func (fs *fakeScheduler) fireAll() {
	fs.mu.Lock()
	armed := make([]*fakeTimer, 0, len(fs.timers))
	for _, t := range fs.timers {
		armed = append(armed, t)
	}
	fs.timers = make(map[int]*fakeTimer)
	fs.mu.Unlock()

	for _, t := range armed {
		t.sched.mu.Lock()
		if t.stopped || t.fired {
			t.sched.mu.Unlock()
			continue
		}
		t.fired = true
		fn := t.fn
		t.sched.mu.Unlock()
		fn()
	}
}

// collector records callback invocations in a race-safe way.
type collector struct {
	mu  sync.Mutex
	got []domain.FsChangedEvent
}

func (c *collector) add(ev domain.FsChangedEvent) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.got = append(c.got, ev)
}

func (c *collector) snapshot() []domain.FsChangedEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]domain.FsChangedEvent, len(c.got))
	copy(out, c.got)
	return out
}

// TestEmitCoalescesBurstIntoOneCallback proves that N rapid emits for one repo
// produce exactly ONE callback, carrying the LAST event payload.
func TestEmitCoalescesBurstIntoOneCallback(t *testing.T) {
	sched := newFakeScheduler()
	svc := newWatcherService(nil, 150*time.Millisecond, sched)

	var c collector
	svc.OnChange(c.add)

	repo := domain.RepositoryId("repo-1")
	for i := 0; i < 5; i++ {
		svc.Emit(domain.FsChangedEvent{RepoID: repo, Paths: []string{fmt.Sprintf("f%d", i)}})
	}

	// Nothing fires synchronously: Emit must not invoke callbacks itself.
	if got := c.snapshot(); len(got) != 0 {
		t.Fatalf("callbacks before window elapsed = %d, want 0", len(got))
	}

	sched.fireAll()

	got := c.snapshot()
	if len(got) != 1 {
		t.Fatalf("callbacks after burst = %d, want 1 (coalescing failed)", len(got))
	}
	if len(got[0].Paths) != 1 || got[0].Paths[0] != "f4" {
		t.Fatalf("payload Paths = %v, want last event [f4]", got[0].Paths)
	}
	if got[0].RepoID != repo {
		t.Fatalf("payload RepoID = %q, want %q", got[0].RepoID, repo)
	}
}

// TestEmitCoalescesPerRepository proves windows are tracked independently: two
// repos emitted in the same burst each get exactly one callback.
func TestEmitCoalescesPerRepository(t *testing.T) {
	sched := newFakeScheduler()
	svc := newWatcherService(nil, 150*time.Millisecond, sched)

	var c collector
	svc.OnChange(c.add)

	repoA := domain.RepositoryId("repo-a")
	repoB := domain.RepositoryId("repo-b")
	for i := 0; i < 3; i++ {
		svc.Emit(domain.FsChangedEvent{RepoID: repoA, Paths: []string{fmt.Sprintf("a%d", i)}})
	}
	svc.Emit(domain.FsChangedEvent{RepoID: repoB, Paths: []string{"b0"}})
	svc.Emit(domain.FsChangedEvent{RepoID: repoB, Paths: []string{"b1"}})

	sched.fireAll()

	got := c.snapshot()
	if len(got) != 2 {
		t.Fatalf("callbacks = %d, want 2 (one per repo)", len(got))
	}
	byRepo := map[domain.RepositoryId]string{}
	for _, ev := range got {
		byRepo[ev.RepoID] = ev.Paths[0]
	}
	if byRepo[repoA] != "a2" {
		t.Fatalf("repo-a payload = %q, want a2", byRepo[repoA])
	}
	if byRepo[repoB] != "b1" {
		t.Fatalf("repo-b payload = %q, want b1", byRepo[repoB])
	}
}

// TestEmitFiresAgainAfterWindow proves the debounce resets: after a burst has
// flushed, a new event starts a fresh window and fires a second callback.
func TestEmitFiresAgainAfterWindow(t *testing.T) {
	sched := newFakeScheduler()
	svc := newWatcherService(nil, 150*time.Millisecond, sched)

	var c collector
	svc.OnChange(c.add)
	repo := domain.RepositoryId("repo-1")

	svc.Emit(domain.FsChangedEvent{RepoID: repo, Paths: []string{"first"}})
	sched.fireAll()
	svc.Emit(domain.FsChangedEvent{RepoID: repo, Paths: []string{"second"}})
	sched.fireAll()

	got := c.snapshot()
	if len(got) != 2 {
		t.Fatalf("callbacks = %d, want 2 (one per window)", len(got))
	}
	if got[0].Paths[0] != "first" || got[1].Paths[0] != "second" {
		t.Fatalf("payloads = %q,%q want first,second", got[0].Paths[0], got[1].Paths[0])
	}
}

// TestEmitConcurrentBurstCoalesces exercises Emit from many goroutines (as
// fsnotify would) under -race and asserts a single callback per repo.
func TestEmitConcurrentBurstCoalesces(t *testing.T) {
	sched := newFakeScheduler()
	svc := newWatcherService(nil, time.Second, sched)

	var c collector
	svc.OnChange(c.add)

	repo := domain.RepositoryId("repo-1")
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			svc.Emit(domain.FsChangedEvent{RepoID: repo, Paths: []string{fmt.Sprintf("f%d", i)}})
		}(i)
	}
	wg.Wait()

	sched.fireAll()

	if got := c.snapshot(); len(got) != 1 {
		t.Fatalf("concurrent burst callbacks = %d, want 1", len(got))
	}
}

// TestWatcherServiceWindowDefaults pins the constructor contract.
func TestWatcherServiceWindowDefaults(t *testing.T) {
	if svc := NewWatcherService(nil); svc.window != DefaultDebounceWindow {
		t.Fatalf("NewWatcherService window = %v, want %v", svc.window, DefaultDebounceWindow)
	}
	if svc := NewWatcherServiceWithWindow(nil, 5*time.Millisecond); svc.window != 5*time.Millisecond {
		t.Fatalf("WithWindow(5ms) window = %v, want 5ms", svc.window)
	}
	if svc := NewWatcherServiceWithWindow(nil, 0); svc.window != DefaultDebounceWindow {
		t.Fatalf("WithWindow(0) window = %v, want default %v", svc.window, DefaultDebounceWindow)
	}
}

// fakeWatcherPort is a domain.WatcherPort whose event channel the test owns, so
// delivery and closure can be driven deterministically.
type fakeWatcherPort struct {
	ch chan domain.FsChangedEvent
}

func (f *fakeWatcherPort) Watch(context.Context, domain.RepositoryId) (<-chan domain.FsChangedEvent, error) {
	return f.ch, nil
}

func (f *fakeWatcherPort) Unwatch(domain.RepositoryId) error { return nil }

// TestWatchForwardsAndFeedsEmit proves Watch both forwards port events to the
// caller and feeds them into Emit, so a registered OnChange callback fires.
func TestWatchForwardsAndFeedsEmit(t *testing.T) {
	sched := newFakeScheduler()
	port := &fakeWatcherPort{ch: make(chan domain.FsChangedEvent, 4)}
	svc := newWatcherService(port, 150*time.Millisecond, sched)

	var c collector
	svc.OnChange(c.add)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out, err := svc.Watch(ctx, domain.RepositoryId("repo-1"))
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}

	want := domain.FsChangedEvent{RepoID: "repo-1", Paths: []string{"a.txt"}}
	port.ch <- want

	select {
	case got := <-out:
		if got.RepoID != want.RepoID || len(got.Paths) != 1 || got.Paths[0] != "a.txt" {
			t.Fatalf("forwarded event = %+v, want %+v", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for forwarded event")
	}

	// The event reached Emit: firing the debounce window yields exactly one
	// callback carrying it (this is the invalidation path main.go wires).
	if got := c.snapshot(); len(got) != 0 {
		t.Fatalf("callback fired before window elapsed = %d, want 0", len(got))
	}
	sched.fireAll()
	got := c.snapshot()
	if len(got) != 1 {
		t.Fatalf("callbacks after window = %d, want 1", len(got))
	}
	if got[0].RepoID != want.RepoID || len(got[0].Paths) != 1 || got[0].Paths[0] != "a.txt" {
		t.Fatalf("callback event = %+v, want %+v", got[0], want)
	}
}

// TestWatchClosesForwardedChannelWhenPortCloses proves the pump exits and the
// forwarded channel closes when the port channel closes.
func TestWatchClosesForwardedChannelWhenPortCloses(t *testing.T) {
	port := &fakeWatcherPort{ch: make(chan domain.FsChangedEvent)}
	svc := NewWatcherService(port)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out, err := svc.Watch(ctx, domain.RepositoryId("repo-1"))
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}

	close(port.ch)

	select {
	case _, ok := <-out:
		if ok {
			t.Fatal("forwarded channel delivered a value after port close, want closed")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out: pump did not close forwarded channel on port close")
	}
}

// TestWatchPumpExitsOnContextCancel proves ctx cancellation ends the pump even
// when the port never closes its channel.
func TestWatchPumpExitsOnContextCancel(t *testing.T) {
	port := &fakeWatcherPort{ch: make(chan domain.FsChangedEvent)}
	svc := NewWatcherService(port)

	ctx, cancel := context.WithCancel(context.Background())
	out, err := svc.Watch(ctx, domain.RepositoryId("repo-1"))
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}

	cancel()

	select {
	case _, ok := <-out:
		if ok {
			t.Fatal("forwarded channel delivered a value after ctx cancel, want closed")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out: pump did not exit on ctx cancellation")
	}
}
