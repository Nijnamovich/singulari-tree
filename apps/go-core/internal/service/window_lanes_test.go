package service

import (
	"context"
	"reflect"
	"strconv"
	"sync"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// branchMergeCommits is the branch+merge topology from graph_service_test.go:
//
//	  m
//	 / \
//	a   b
//	 \ /
//	base
//
// Pure lanes are [0,0,1,0] with Continues [true,true,true,false].
func branchMergeCommits() []domain.Commit {
	return []domain.Commit{
		commit("m", "a", "b"),
		commit("a", "base"),
		commit("b", "base"),
		commit("base"),
	}
}

// fakeCommitLister serves windows from a fixed topological history and counts
// List calls. It is safe for concurrent use.
type fakeCommitLister struct {
	mu    sync.Mutex
	all   []domain.Commit
	calls int
}

func newFakeCommitLister(all []domain.Commit) *fakeCommitLister {
	return &fakeCommitLister{all: all}
}

func (f *fakeCommitLister) List(_ context.Context, _ domain.RepositoryId, _ []string, offset, limit int) ([]domain.Commit, int, error) {
	f.mu.Lock()
	f.calls++
	total := len(f.all)
	f.mu.Unlock()

	if offset < 0 {
		offset = 0
	}
	if offset >= total {
		return nil, total, nil
	}
	end := total
	if limit > 0 && offset+limit < total {
		end = offset + limit
	}
	out := make([]domain.Commit, end-offset)
	copy(out, f.all[offset:end])
	return out, total, nil
}

// LensOids satisfies domain.CommitLister. The fixture lister models the HEAD
// walk only, so a lens has no membership; tests that need a lens use lensLister.
func (f *fakeCommitLister) LensOids(context.Context, domain.RepositoryId, []string) ([]string, error) {
	return []string{}, nil
}

func (f *fakeCommitLister) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func laneIndexes(lanes []domain.Lane) []int {
	out := make([]int, len(lanes))
	for i := range lanes {
		out[i] = lanes[i].Index
	}
	return out
}

// TestWindowLanesContinuityAcrossWindows drives the same history in windows of
// several sizes and asserts the concatenated lanes equal both the one-shot
// stateful pass and the pure window-local Lanes pass.
func TestWindowLanesContinuityAcrossWindows(t *testing.T) {
	ctx := context.Background()
	repo := domain.RepositoryId("repo")
	all := branchMergeCommits()

	oneShot := NewGraphService(newFakeCommitLister(all), nil)
	want, err := oneShot.WindowLanes(ctx, repo, nil, all, 0)
	if err != nil {
		t.Fatalf("WindowLanes(one-shot): %v", err)
	}
	if !reflect.DeepEqual(want, lanesOf(t, all)) {
		t.Fatalf("one-shot stateful lanes = %v, pure Lanes = %v", want, lanesOf(t, all))
	}
	assertLanes(t, want, []int{0, 0, 1, 0}, []bool{true, true, true, false})

	for _, w := range []int{1, 2, 3} {
		t.Run("window_"+strconv.Itoa(w), func(t *testing.T) {
			svc := NewGraphService(newFakeCommitLister(all), nil)
			var got []domain.Lane
			for off := 0; off < len(all); off += w {
				end := off + w
				if end > len(all) {
					end = len(all)
				}
				lanes, err := svc.WindowLanes(ctx, repo, nil, all[off:end], off)
				if err != nil {
					t.Fatalf("WindowLanes(offset=%d): %v", off, err)
				}
				got = append(got, lanes...)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("windowed lanes (w=%d) = %v, want %v", w, laneIndexes(got), laneIndexes(want))
			}
		})
	}
}

// TestWindowLanesOutOfOrderWindow requests the second window before the first
// and asserts the lanes still match the in-order pass (the prefix is caught up
// by re-listing history from HEAD).
func TestWindowLanesOutOfOrderWindow(t *testing.T) {
	ctx := context.Background()
	repo := domain.RepositoryId("repo")
	all := branchMergeCommits()
	const k = 2

	want := NewGraphService(newFakeCommitLister(all), nil)
	full, err := want.WindowLanes(ctx, repo, nil, all, 0)
	if err != nil {
		t.Fatalf("WindowLanes(full): %v", err)
	}

	svc := NewGraphService(newFakeCommitLister(all), nil)
	second, err := svc.WindowLanes(ctx, repo, nil, all[k:], k)
	if err != nil {
		t.Fatalf("WindowLanes(second): %v", err)
	}
	first, err := svc.WindowLanes(ctx, repo, nil, all[0:k], 0)
	if err != nil {
		t.Fatalf("WindowLanes(first): %v", err)
	}

	got := append(append([]domain.Lane{}, first...), second...)
	if !reflect.DeepEqual(got, full) {
		t.Fatalf("out-of-order lanes = %v, want %v", laneIndexes(got), laneIndexes(full))
	}
}

// TestWindowLanesCatchUpSkipsPrefix requests a window whose prefix was never
// requested (offset 3 first) and asserts catch-up yields the same columns.
func TestWindowLanesCatchUpSkipsPrefix(t *testing.T) {
	ctx := context.Background()
	repo := domain.RepositoryId("repo")
	all := branchMergeCommits()

	want := NewGraphService(newFakeCommitLister(all), nil)
	full, err := want.WindowLanes(ctx, repo, nil, all, 0)
	if err != nil {
		t.Fatalf("WindowLanes(full): %v", err)
	}

	svc := NewGraphService(newFakeCommitLister(all), nil)
	// Anchor at offset 0 with a single commit, then jump to offset 3: the two
	// commits in between must be fetched and folded as catch-up.
	if _, err := svc.WindowLanes(ctx, repo, nil, all[0:1], 0); err != nil {
		t.Fatalf("WindowLanes(anchor): %v", err)
	}
	tail, err := svc.WindowLanes(ctx, repo, nil, all[3:], 3)
	if err != nil {
		t.Fatalf("WindowLanes(tail): %v", err)
	}
	if !reflect.DeepEqual(tail, full[3:]) {
		t.Fatalf("catch-up tail lanes = %v, want %v", laneIndexes(tail), laneIndexes(full[3:]))
	}
}

// TestWindowLanesInvalidateRecomputes asserts that after Invalidate the same
// windows produce identical lanes.
func TestWindowLanesInvalidateRecomputes(t *testing.T) {
	ctx := context.Background()
	repo := domain.RepositoryId("repo")
	all := branchMergeCommits()

	svc := NewGraphService(newFakeCommitLister(all), nil)
	before, err := svc.WindowLanes(ctx, repo, nil, all, 0)
	if err != nil {
		t.Fatalf("WindowLanes(before): %v", err)
	}

	svc.Invalidate(repo)

	after, err := svc.WindowLanes(ctx, repo, nil, all, 0)
	if err != nil {
		t.Fatalf("WindowLanes(after): %v", err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("lanes changed after Invalidate: before=%v after=%v", laneIndexes(before), laneIndexes(after))
	}
}

// TestWindowLanesFallsBackWithoutGitPort asserts the nil-port path matches the
// pure Lanes (existing tests pass nil).
func TestWindowLanesFallsBackWithoutGitPort(t *testing.T) {
	ctx := context.Background()
	all := branchMergeCommits()
	svc := NewGraphService(nil, nil)

	got, err := svc.WindowLanes(ctx, domain.RepositoryId("repo"), nil, all, 2)
	if err != nil {
		t.Fatalf("WindowLanes: %v", err)
	}
	if !reflect.DeepEqual(got, lanesOf(t, all)) {
		t.Fatalf("nil-port WindowLanes = %v, want pure Lanes %v", laneIndexes(got), laneIndexes(lanesOf(t, all)))
	}
}

// TestWindowLanesConcurrentSafe hammers WindowLanes and Invalidate from many
// goroutines; it must be clean under -race and never panic.
func TestWindowLanesConcurrentSafe(t *testing.T) {
	ctx := context.Background()
	repo := domain.RepositoryId("repo")
	all := synthCommits(256)
	svc := NewGraphService(newFakeCommitLister(all), nil)

	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 40; i++ {
				off := (g*7 + i*3) % len(all)
				size := 1 + (i % 5)
				end := off + size
				if end > len(all) {
					end = len(all)
				}
				if _, err := svc.WindowLanes(ctx, repo, nil, all[off:end], off); err != nil {
					t.Errorf("WindowLanes(offset=%d): %v", off, err)
					return
				}
				if i%10 == 0 {
					svc.Invalidate(repo)
				}
			}
		}(g)
	}
	wg.Wait()
}
