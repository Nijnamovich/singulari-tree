package repository

import (
	"context"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// TestCommitStatsCacheRoundTrip exercises the SQLite-backed commit_stats cache:
// upsert, partial read, miss on unknown oids and Invalidate dropping stats
// alongside commit_cache (ADR-0023).
func TestCommitStatsCacheRoundTrip(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	repo, err := NewRepoStore(db).Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("RepoStore.Open: %v", err)
	}

	cache := NewCommitCache(db)
	stats := []domain.CommitStats{
		{Oid: "aaaa", Additions: 1, Deletions: 2, FilesChanged: 3},
		{Oid: "bbbb", Additions: 4, Deletions: 5, FilesChanged: 6},
	}
	if err := cache.PutCommitStats(ctx, repo.ID, stats); err != nil {
		t.Fatalf("PutCommitStats: %v", err)
	}

	got, ok := cache.GetCommitStats(ctx, repo.ID, []string{"aaaa", "bbbb"})
	if !ok || len(got) != 2 {
		t.Fatalf("GetCommitStats = %+v ok=%v, want both", got, ok)
	}

	// Partial read: only the cached oid is returned.
	partial, ok := cache.GetCommitStats(ctx, repo.ID, []string{"aaaa", "cccc"})
	if !ok || len(partial) != 1 || partial[0].Oid != "aaaa" {
		t.Fatalf("partial = %+v ok=%v, want [aaaa]", partial, ok)
	}

	// Unknown repo / oid is a miss.
	if _, ok := cache.GetCommitStats(ctx, "other", []string{"aaaa"}); ok {
		t.Error("GetCommitStats(other repo) = hit, want miss")
	}

	// Upsert updates in place without duplicating.
	stats[0].Additions = 100
	if err := cache.PutCommitStats(ctx, repo.ID, stats[:1]); err != nil {
		t.Fatalf("PutCommitStats (upsert): %v", err)
	}
	got, _ = cache.GetCommitStats(ctx, repo.ID, []string{"aaaa"})
	if len(got) != 1 || got[0].Additions != 100 {
		t.Fatalf("after upsert = %+v, want additions 100", got)
	}

	// Invalidate drops stats together with the commit cache.
	cache.Invalidate(repo.ID)
	if _, ok := cache.GetCommitStats(ctx, repo.ID, []string{"aaaa"}); ok {
		t.Fatal("GetCommitStats after Invalidate = hit, want miss")
	}
}
