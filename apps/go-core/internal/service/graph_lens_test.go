package service

import (
	"context"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// recordingCache is a CachePort that records commit-window cache traffic so the
// lensed bypass can be asserted. Every read misses, so an un-lensed Commits call
// performs exactly one Get and one Put.
type recordingCache struct {
	mu   sync.Mutex
	gets int
	puts int
}

func (c *recordingCache) GetCommits(context.Context, domain.RepositoryId, int, int) ([]domain.Commit, int, bool) {
	c.mu.Lock()
	c.gets++
	c.mu.Unlock()
	return nil, 0, false
}

func (c *recordingCache) PutCommits(context.Context, domain.RepositoryId, int, int, []domain.Commit) error {
	c.mu.Lock()
	c.puts++
	c.mu.Unlock()
	return nil
}

func (c *recordingCache) GetCommitStats(context.Context, domain.RepositoryId, []string) ([]domain.CommitStats, bool) {
	return nil, false
}

func (c *recordingCache) PutCommitStats(context.Context, domain.RepositoryId, []domain.CommitStats) error {
	return nil
}

func (c *recordingCache) Invalidate(domain.RepositoryId) {}

func (c *recordingCache) traffic() (gets, puts int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gets, c.puts
}

// testLensKey canonicalizes refs independently of the production helper, so the
// fake lookup and the assertions do not lean on the code under test.
func testLensKey(refs []string) string {
	seen := map[string]struct{}{}
	keys := make([]string, 0, len(refs))
	for _, raw := range refs {
		ref := strings.TrimSpace(raw)
		if ref == "" {
			continue
		}
		if _, ok := seen[ref]; ok {
			continue
		}
		seen[ref] = struct{}{}
		keys = append(keys, ref)
	}
	sort.Strings(keys)
	return strings.Join(keys, "\x00")
}

// lensHistoryLister serves a distinct topological history per canonical ref set
// ("" is the HEAD walk) and records the refs of every List/LensOids call.
type lensHistoryLister struct {
	mu        sync.Mutex
	histories map[string][]domain.Commit
	lenses    map[string][]string
	listKeys  []string
	lensCalls int
}

func newLensHistoryLister(histories map[string][]domain.Commit, lenses map[string][]string) *lensHistoryLister {
	return &lensHistoryLister{histories: histories, lenses: lenses}
}

func (l *lensHistoryLister) List(_ context.Context, _ domain.RepositoryId, refs []string, offset, limit int) ([]domain.Commit, int, error) {
	key := testLensKey(refs)
	l.mu.Lock()
	l.listKeys = append(l.listKeys, key)
	all := l.histories[key]
	l.mu.Unlock()

	total := len(all)
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
	copy(out, all[offset:end])
	return out, total, nil
}

func (l *lensHistoryLister) LensOids(_ context.Context, _ domain.RepositoryId, refs []string) ([]string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lensCalls++
	return append([]string{}, l.lenses[testLensKey(refs)]...), nil
}

func (l *lensHistoryLister) listKeySnapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string{}, l.listKeys...)
}

func (l *lensHistoryLister) lensCallCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lensCalls
}

// TestCommitsLensedBypassesCache is the cache-bypass invariant: a lensed read
// never consults nor populates the (ref-less, offset-keyed) commit window cache,
// while an un-lensed read still performs both sides.
func TestCommitsLensedBypassesCache(t *testing.T) {
	ctx := context.Background()
	repo := domain.RepositoryId("repo")
	all := branchMergeCommits()
	cache := &recordingCache{}
	svc := NewGraphService(newFakeCommitLister(all), cache)

	commits, total, err := svc.Commits(ctx, repo, []string{"feature"}, 0, len(all))
	if err != nil {
		t.Fatalf("Commits(lensed): %v", err)
	}
	if len(commits) != len(all) || total != len(all) {
		t.Fatalf("lensed Commits = (%d, %d), want (%d, %d)", len(commits), total, len(all), len(all))
	}
	if gets, puts := cache.traffic(); gets != 0 || puts != 0 {
		t.Fatalf("lensed Commits cache traffic = (gets %d, puts %d), want (0, 0)", gets, puts)
	}

	if _, _, err := svc.Commits(ctx, repo, nil, 0, len(all)); err != nil {
		t.Fatalf("Commits(un-lensed): %v", err)
	}
	if gets, puts := cache.traffic(); gets != 1 || puts != 1 {
		t.Fatalf("un-lensed Commits cache traffic = (gets %d, puts %d), want (1, 1)", gets, puts)
	}
}

// lensFixture is the topology used by the lane-keying tests. HEAD is linear
// (lanes [0,0,0]) while the lensed histories contain a merge, so a state leak
// between keys shows up immediately as a lane mismatch.
type lensFixture struct {
	head    []domain.Commit
	feature []domain.Commit
	other   []domain.Commit
}

func newLensFixture() lensFixture {
	return lensFixture{
		head: []domain.Commit{
			commit("h2", "h1"),
			commit("h1", "h0"),
			commit("h0"),
		},
		feature: []domain.Commit{
			commit("f3", "f1a", "f1b"),
			commit("f1a", "f0"),
			commit("f1b", "f0"),
			commit("f0"),
		},
		other: []domain.Commit{
			commit("o1", "o0"),
			commit("o0"),
		},
	}
}

func (f lensFixture) lister() *lensHistoryLister {
	return newLensHistoryLister(map[string][]domain.Commit{
		"":        f.head,
		"feature": f.feature,
		"other":   f.other,
	}, map[string][]string{
		"feature": {"f3", "f1a", "f1b", "f0"},
		"other":   {"o1", "o0"},
	})
}

// TestWindowLanesKeysStateByRefSet interleaves lens folds and asserts each ref
// set resumes its own layout: folding feature, then other, then feature again
// yields exactly the fresh feature fold, and the HEAD layout is never shifted by
// the detour.
func TestWindowLanesKeysStateByRefSet(t *testing.T) {
	ctx := context.Background()
	repo := domain.RepositoryId("repo")
	fx := newLensFixture()

	lister := fx.lister()
	svc := NewGraphService(lister, nil)

	// Anchor HEAD, then fold feature in two windows, detour through other, and
	// come back to feature.
	if _, err := svc.WindowLanes(ctx, repo, nil, fx.head[:1], 0); err != nil {
		t.Fatalf("WindowLanes(HEAD anchor): %v", err)
	}
	if _, err := svc.WindowLanes(ctx, repo, []string{"feature"}, fx.feature[:1], 0); err != nil {
		t.Fatalf("WindowLanes(feature head): %v", err)
	}
	featureTail, err := svc.WindowLanes(ctx, repo, []string{"feature"}, fx.feature[2:], 2)
	if err != nil {
		t.Fatalf("WindowLanes(feature tail): %v", err)
	}
	if _, err := svc.WindowLanes(ctx, repo, []string{"other"}, fx.other[:1], 0); err != nil {
		t.Fatalf("WindowLanes(other): %v", err)
	}
	featureAgain, err := svc.WindowLanes(ctx, repo, []string{"feature"}, fx.feature[:1], 0)
	if err != nil {
		t.Fatalf("WindowLanes(feature again): %v", err)
	}

	freshFeature := NewGraphService(fx.lister(), nil)
	fullFeature, err := freshFeature.WindowLanes(ctx, repo, []string{"feature"}, fx.feature, 0)
	if err != nil {
		t.Fatalf("WindowLanes(fresh feature): %v", err)
	}
	assertLanes(t, fullFeature, []int{0, 0, 1, 0}, []bool{true, true, true, false})

	if len(featureTail) != 2 || featureTail[0] != fullFeature[2] || featureTail[1] != fullFeature[3] {
		t.Fatalf("feature tail lanes = %v, want %v (catch-up must use the same refs)",
			laneIndexes(featureTail), laneIndexes(fullFeature[2:]))
	}
	if len(featureAgain) != 1 || featureAgain[0] != fullFeature[0] {
		t.Fatalf("feature re-fold lanes = %v, want %v (state keyed by ref set)",
			laneIndexes(featureAgain), laneIndexes(fullFeature[:1]))
	}

	// The HEAD state must still be the HEAD fold: continuing it at offset 1
	// yields the same columns as a fresh HEAD fold.
	headTail, err := svc.WindowLanes(ctx, repo, nil, fx.head[1:], 1)
	if err != nil {
		t.Fatalf("WindowLanes(HEAD tail): %v", err)
	}
	freshHead := NewGraphService(fx.lister(), nil)
	fullHead, err := freshHead.WindowLanes(ctx, repo, nil, fx.head, 0)
	if err != nil {
		t.Fatalf("WindowLanes(fresh HEAD): %v", err)
	}
	if len(headTail) != 2 || headTail[0] != fullHead[1] || headTail[1] != fullHead[2] {
		t.Fatalf("HEAD tail lanes = %v, want %v (lens detour must not shift HEAD)",
			laneIndexes(headTail), laneIndexes(fullHead[1:]))
	}

	// Every call made for the feature walk must have carried the feature refs,
	// including the anchor and catch-up reads.
	for _, key := range lister.listKeySnapshot() {
		switch key {
		case "", "feature", "other":
		default:
			t.Fatalf("List received an unexpected ref set %q", key)
		}
	}
}

// TestWindowLanesRefOrderDoesNotMintState proves the lane key is the canonical
// set: reordered, duplicated or blank-padded refs reuse the same state instead
// of folding a second copy.
func TestWindowLanesRefOrderDoesNotMintState(t *testing.T) {
	ctx := context.Background()
	repo := domain.RepositoryId("repo")
	fx := newLensFixture()
	svc := NewGraphService(fx.lister(), nil)

	first, err := svc.WindowLanes(ctx, repo, []string{"feature"}, fx.feature, 0)
	if err != nil {
		t.Fatalf("WindowLanes(feature): %v", err)
	}
	if len(svc.states) != 1 {
		t.Fatalf("states after feature fold = %d, want 1", len(svc.states))
	}

	second, err := svc.WindowLanes(ctx, repo, []string{" feature ", "feature", ""}, fx.feature, 0)
	if err != nil {
		t.Fatalf("WindowLanes(padded feature): %v", err)
	}
	if len(first) != len(second) {
		t.Fatalf("lane lengths differ: %d vs %d", len(first), len(second))
	}
	for i := range first {
		if first[i] != second[i] {
			t.Fatalf("lane[%d] = %+v, want %+v (ref order must not change the fold)", i, second[i], first[i])
		}
	}
	if len(svc.states) != 1 {
		t.Fatalf("states after padded refs = %d, want 1 (ref order must not mint a state)", len(svc.states))
	}
}

// TestLensOidsCachedPerRefSetAndInvalidated proves the membership set is memoized
// per (repo, ref set), that empty refs never touch the port, and that Invalidate
// drops the memo (and every lane state) for that repo only.
func TestLensOidsCachedPerRefSetAndInvalidated(t *testing.T) {
	ctx := context.Background()
	repo := domain.RepositoryId("repo")
	otherRepo := domain.RepositoryId("other-repo")
	fx := newLensFixture()
	lister := fx.lister()
	svc := NewGraphService(lister, nil)

	oids, err := svc.LensOids(ctx, repo, []string{"feature"})
	if err != nil {
		t.Fatalf("LensOids(feature): %v", err)
	}
	if len(oids) != 4 {
		t.Fatalf("LensOids(feature) = %v, want 4 oids", oids)
	}
	if got := lister.lensCallCount(); got != 1 {
		t.Fatalf("LensOids port calls = %d, want 1", got)
	}

	again, err := svc.LensOids(ctx, repo, []string{"feature", " feature "})
	if err != nil {
		t.Fatalf("LensOids(feature, repeated): %v", err)
	}
	if len(again) != len(oids) {
		t.Fatalf("LensOids(repeated) = %v, want %v", again, oids)
	}
	if got := lister.lensCallCount(); got != 1 {
		t.Fatalf("LensOids port calls after repeat = %d, want 1 (cache hit)", got)
	}

	empty, err := svc.LensOids(ctx, repo, nil)
	if err != nil {
		t.Fatalf("LensOids(nil): %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("LensOids(nil) = %v, want empty", empty)
	}
	if got := lister.lensCallCount(); got != 1 {
		t.Fatalf("LensOids(nil) port calls = %d, want 1 (no walk for no refs)", got)
	}

	// Populate both lane state and lens cache for two repos, then sweep one.
	if _, err := svc.WindowLanes(ctx, repo, []string{"feature"}, fx.feature, 0); err != nil {
		t.Fatalf("WindowLanes(feature): %v", err)
	}
	if _, err := svc.WindowLanes(ctx, repo, nil, fx.head, 0); err != nil {
		t.Fatalf("WindowLanes(HEAD): %v", err)
	}
	if _, err := svc.WindowLanes(ctx, otherRepo, nil, fx.head, 0); err != nil {
		t.Fatalf("WindowLanes(other repo): %v", err)
	}

	svc.Invalidate(repo)

	if len(svc.states) != 1 {
		t.Fatalf("states after Invalidate = %d, want 1 (the other repo's HEAD state)", len(svc.states))
	}
	if len(svc.lenses) != 0 {
		t.Fatalf("lens cache after Invalidate = %d entries, want 0", len(svc.lenses))
	}
	if _, err := svc.LensOids(ctx, repo, []string{"feature"}); err != nil {
		t.Fatalf("LensOids after Invalidate: %v", err)
	}
	if got := lister.lensCallCount(); got != 2 {
		t.Fatalf("LensOids port calls after Invalidate = %d, want 2 (memo dropped)", got)
	}
}
