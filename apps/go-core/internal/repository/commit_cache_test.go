package repository

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/SingulariTree/go-core/internal/domain"
)

func oid40(c byte) domain.Oid {
	return domain.Oid{Hex: strings.Repeat(string(c), 40), Kind: "SHA1"}
}

// TestCommitCacheRoundTrip exercises the SQLite-backed CachePort: write-through
// upsert, windowed read ordered by committed_at, parent serialization and
// Invalidate.
func TestCommitCacheRoundTrip(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	repo, err := NewRepoStore(db).Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("RepoStore.Open: %v", err)
	}

	cache := NewCommitCache(db)
	base := time.Date(2020, 1, 1, 12, 0, 0, 0, time.UTC)
	mk := func(c byte, parent *domain.Oid, at time.Time) domain.Commit {
		var parents []domain.Oid
		if parent != nil {
			parents = []domain.Oid{*parent}
		}
		return domain.Commit{
			Oid:         oid40(c),
			Parents:     parents,
			Author:      domain.Signature{Name: "A", Email: "a@example.com", When: at},
			Committer:   domain.Signature{Name: "C", Email: "c@example.com", When: at},
			Message:     "msg " + string(c),
			TreeOid:     oid40('t'),
			CommittedAt: at,
		}
	}

	newest := mk('a', nil, base)
	older := mk('b', nil, base.Add(-time.Hour))
	if err := cache.PutCommits(ctx, repo.ID, 0, 2, []domain.Commit{newest, older}); err != nil {
		t.Fatalf("PutCommits: %v", err)
	}

	got, total, ok := cache.GetCommits(ctx, repo.ID, 0, 10)
	if !ok {
		t.Fatal("GetCommits after PutCommits: miss")
	}
	if total != 2 {
		t.Fatalf("total = %d, want 2", total)
	}
	if len(got) != 2 {
		t.Fatalf("window len = %d, want 2", len(got))
	}
	if got[0].Oid.Hex != newest.Oid.Hex {
		t.Errorf("got[0] = %s, want newest %s (committed_at DESC)", got[0].Oid.Short(), newest.Oid.Short())
	}

	// Window offset.
	page, _, ok := cache.GetCommits(ctx, repo.ID, 1, 10)
	if !ok || len(page) != 1 || page[0].Oid.Hex != older.Oid.Hex {
		t.Fatalf("offset window = %+v ok=%v, want [older]", page, ok)
	}

	// Upsert must not duplicate rows.
	newest.Message = "updated"
	if err := cache.PutCommits(ctx, repo.ID, 0, 2, []domain.Commit{newest}); err != nil {
		t.Fatalf("PutCommits (upsert): %v", err)
	}
	got, total, _ = cache.GetCommits(ctx, repo.ID, 0, 10)
	if total != 2 || len(got) != 2 {
		t.Fatalf("after upsert total=%d len=%d, want 2/2", total, len(got))
	}

	// Parents serialize as space-separated hex and round-trip.
	child := mk('c', &older.Oid, base.Add(time.Hour))
	if err := cache.PutCommits(ctx, repo.ID, 0, 3, []domain.Commit{child}); err != nil {
		t.Fatalf("PutCommits (child): %v", err)
	}
	got, _, _ = cache.GetCommits(ctx, repo.ID, 0, 10)
	if len(got) == 0 || got[0].Oid.Hex != child.Oid.Hex {
		t.Fatalf("child not first after insert: %+v", got)
	}
	if len(got[0].Parents) != 1 || got[0].Parents[0].Hex != older.Oid.Hex {
		t.Fatalf("child parents = %+v, want [%s]", got[0].Parents, older.Oid.Hex)
	}

	// Invalidate empties the repo's cache.
	cache.Invalidate(repo.ID)
	if _, _, ok := cache.GetCommits(ctx, repo.ID, 0, 10); ok {
		t.Fatal("GetCommits after Invalidate: hit, want miss")
	}
}
