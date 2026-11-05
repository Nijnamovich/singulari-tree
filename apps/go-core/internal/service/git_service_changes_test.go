package service

import (
	"context"
	"testing"
	"time"

	"github.com/SingulariTree/go-core/internal/domain"
)

// stubGitPort records the hunk/discard/reset/stats calls GitService makes. The
// embedded interface satisfies the remaining methods (never called here).
type stubGitPort struct {
	domain.GitPort

	stageHunkCalls   int
	unstageHunkCalls int
	discardHunkCalls int
	discardPaths     []string
	resetTo          string
	resetMode        domain.ResetMode
	resetCalls       int

	statsResult []domain.CommitStats
	statsErr    error
	statsOids   []string
	statsCalls  int
}

func (s *stubGitPort) StageHunk(context.Context, domain.RepositoryId, string, uint32, []uint32) error {
	s.stageHunkCalls++
	return nil
}
func (s *stubGitPort) UnstageHunk(context.Context, domain.RepositoryId, string, uint32, []uint32) error {
	s.unstageHunkCalls++
	return nil
}
func (s *stubGitPort) DiscardHunk(context.Context, domain.RepositoryId, string, uint32, []uint32) error {
	s.discardHunkCalls++
	return nil
}
func (s *stubGitPort) Discard(_ context.Context, _ domain.RepositoryId, paths []string) error {
	s.discardPaths = paths
	return nil
}
func (s *stubGitPort) Reset(_ context.Context, _ domain.RepositoryId, to string, mode domain.ResetMode) error {
	s.resetCalls++
	s.resetTo, s.resetMode = to, mode
	return nil
}
func (s *stubGitPort) CommitStats(_ context.Context, _ domain.RepositoryId, oids []string) ([]domain.CommitStats, error) {
	s.statsCalls++
	s.statsOids = append([]string(nil), oids...)
	return s.statsResult, s.statsErr
}

// stubCachePort implements domain.CachePort, recording invalidations and
// serving a fixed stats map.
type stubCachePort struct {
	invalidations int
	stats         map[string]domain.CommitStats
	putStats      []domain.CommitStats
}

func (c *stubCachePort) GetCommits(context.Context, domain.RepositoryId, int, int) ([]domain.Commit, int, bool) {
	return nil, 0, false
}
func (c *stubCachePort) PutCommits(context.Context, domain.RepositoryId, int, int, []domain.Commit) error {
	return nil
}
func (c *stubCachePort) GetCommitStats(_ context.Context, _ domain.RepositoryId, oids []string) ([]domain.CommitStats, bool) {
	var out []domain.CommitStats
	for _, oid := range oids {
		if st, ok := c.stats[oid]; ok {
			out = append(out, st)
		}
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}
func (c *stubCachePort) PutCommitStats(_ context.Context, _ domain.RepositoryId, stats []domain.CommitStats) error {
	c.putStats = append(c.putStats, stats...)
	if c.stats == nil {
		c.stats = map[string]domain.CommitStats{}
	}
	for _, st := range stats {
		c.stats[st.Oid] = st
	}
	return nil
}
func (c *stubCachePort) Invalidate(domain.RepositoryId) { c.invalidations++ }

// TestGitServiceMutationOpsInvalidate proves every new mutation invalidates the
// cache and emits a watcher event on success.
func TestGitServiceMutationOpsInvalidate(t *testing.T) {
	const repoID = domain.RepositoryId("repo-1")

	ops := []struct {
		name string
		call func(*GitService, context.Context) error
	}{
		{"StageHunk", func(s *GitService, ctx context.Context) error {
			return s.StageHunk(ctx, repoID, "a.txt", 0, nil)
		}},
		{"UnstageHunk", func(s *GitService, ctx context.Context) error {
			return s.UnstageHunk(ctx, repoID, "a.txt", 0, nil)
		}},
		{"DiscardHunk", func(s *GitService, ctx context.Context) error {
			return s.DiscardHunk(ctx, repoID, "a.txt", 0, nil)
		}},
		{"Discard", func(s *GitService, ctx context.Context) error {
			return s.Discard(ctx, repoID, []string{"a.txt"})
		}},
		{"Reset", func(s *GitService, ctx context.Context) error {
			return s.Reset(ctx, repoID, "HEAD~1", domain.ResetModeSoft)
		}},
	}
	for _, tc := range ops {
		t.Run(tc.name, func(t *testing.T) {
			port := &stubGitPort{}
			cache := &stubCachePort{}
			sched := newFakeScheduler()
			watcher := newWatcherService(&fakeWatcherPort{}, 150*time.Millisecond, sched)
			var c collector
			watcher.OnChange(c.add)

			svc := NewGitService(port, cache, watcher)
			if err := tc.call(svc, context.Background()); err != nil {
				t.Fatalf("%s: %v", tc.name, err)
			}
			if cache.invalidations != 1 {
				t.Errorf("invalidations = %d, want 1", cache.invalidations)
			}
			sched.fireAll()
			got := c.snapshot()
			if len(got) != 1 || got[0].RepoID != repoID {
				t.Errorf("watcher events = %+v, want one for %s", got, repoID)
			}
		})
	}
}

// TestGitServiceCommitStatsCacheThrough proves cached oids are served from
// SQLite and only misses are computed and written back.
func TestGitServiceCommitStatsCacheThrough(t *testing.T) {
	cached := domain.CommitStats{Oid: "aaaa", Additions: 1, Deletions: 2, FilesChanged: 3}
	port := &stubGitPort{statsResult: []domain.CommitStats{{Oid: "bbbb", Additions: 4, Deletions: 5, FilesChanged: 6}}}
	cache := &stubCachePort{stats: map[string]domain.CommitStats{"aaaa": cached}}

	svc := NewGitService(port, cache, nil)
	got, err := svc.CommitStats(context.Background(), "repo-1", []string{"aaaa", "bbbb"})
	if err != nil {
		t.Fatalf("CommitStats: %v", err)
	}
	if port.statsCalls != 1 || len(port.statsOids) != 1 || port.statsOids[0] != "bbbb" {
		t.Errorf("git stats call = %d %v, want only bbbb", port.statsCalls, port.statsOids)
	}
	if len(cache.putStats) != 1 || cache.putStats[0].Oid != "bbbb" {
		t.Errorf("putStats = %+v, want bbbb written back", cache.putStats)
	}
	if len(got) != 2 || got[0].Oid != "aaaa" || got[1].Oid != "bbbb" {
		t.Errorf("stats = %+v, want [aaaa bbbb] in order", got)
	}
}

// TestGitServiceCommitStatsAllCached proves a fully cached request never calls
// git.
func TestGitServiceCommitStatsAllCached(t *testing.T) {
	cached := domain.CommitStats{Oid: "aaaa", Additions: 1}
	port := &stubGitPort{}
	cache := &stubCachePort{stats: map[string]domain.CommitStats{"aaaa": cached}}

	svc := NewGitService(port, cache, nil)
	got, err := svc.CommitStats(context.Background(), "repo-1", []string{"aaaa"})
	if err != nil {
		t.Fatalf("CommitStats: %v", err)
	}
	if port.statsCalls != 0 {
		t.Errorf("git stats called %d times, want 0 (all cached)", port.statsCalls)
	}
	if len(got) != 1 || got[0].Oid != "aaaa" {
		t.Errorf("stats = %+v, want [aaaa]", got)
	}
}
