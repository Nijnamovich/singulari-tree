package service

import (
	"context"
	"testing"

	"github.com/SingulariTree/go-core/internal/repository"
)

// TestCommitsWriteThroughPopulatesSQLite asserts that GraphService.Commits
// writes fetched windows through to the SQLite CommitCache, and that a second
// identical read is served from L1 (proving the LRU key fix).
func TestCommitsWriteThroughPopulatesSQLite(t *testing.T) {
	ctx := context.Background()

	db, err := repository.OpenSQLite(":memory:")
	if err != nil {
		t.Fatalf("OpenSQLite(:memory:): %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := repository.ApplyMigrations(ctx, db); err != nil {
		t.Fatalf("ApplyMigrations: %v", err)
	}

	// commit_cache.repo_id has an FK to repos(id); track a repo first.
	repo, err := repository.NewRepoStore(db).Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("RepoStore.Open: %v", err)
	}

	all := branchMergeCommits()
	lister := newFakeCommitLister(all)
	cache := NewCacheServiceWithStore(10, repository.NewCommitCache(db))
	svc := NewGraphService(lister, cache)

	commits, total, err := svc.Commits(ctx, repo.ID, nil, 0, len(all))
	if err != nil {
		t.Fatalf("Commits: %v", err)
	}
	if len(commits) != len(all) {
		t.Fatalf("Commits len = %d, want %d", len(commits), len(all))
	}
	if total != len(all) {
		t.Fatalf("Commits total = %d, want %d", total, len(all))
	}

	var rows int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM commit_cache WHERE repo_id = ?`, string(repo.ID),
	).Scan(&rows); err != nil {
		t.Fatalf("count commit_cache: %v", err)
	}
	if rows != len(all) {
		t.Fatalf("commit_cache rows = %d, want %d (write-through did not populate)", rows, len(all))
	}

	// Second read must hit L1: the Git lister is not called again.
	before := lister.callCount()
	again, total2, err := svc.Commits(ctx, repo.ID, nil, 0, len(all))
	if err != nil {
		t.Fatalf("Commits (second): %v", err)
	}
	if lister.callCount() != before {
		t.Fatalf("second Commits called git lister (%d -> %d), want L1 hit with 0 extra calls",
			before, lister.callCount())
	}
	if total2 != total {
		t.Fatalf("second total = %d, want %d", total2, total)
	}
	if len(again) != len(commits) {
		t.Fatalf("second len = %d, want %d", len(again), len(commits))
	}
	for i := range again {
		if again[i].Oid.Hex != commits[i].Oid.Hex {
			t.Fatalf("second[%d].Oid = %q, want %q", i, again[i].Oid.Hex, commits[i].Oid.Hex)
		}
	}
}
