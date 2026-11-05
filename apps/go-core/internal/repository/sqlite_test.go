package repository

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := OpenSQLite(filepath.Join(t.TempDir(), "cache.db"))
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := ApplyMigrations(context.Background(), db); err != nil {
		t.Fatalf("ApplyMigrations: %v", err)
	}
	return db
}

// TestBuildDSN pins the path→DSN conversion, including the Windows drive-letter
// case whose mishandling caused "invalid uri authority: C:\..." (see #windows).
func TestBuildDSN(t *testing.T) {
	tests := []struct {
		name string
		path string
		want string
	}{
		{
			name: "memory",
			path: ":memory:",
			want: "file::memory:?" + dsnPragmas,
		},
		{
			name: "posix absolute",
			path: "/tmp/singularitree/cache.db",
			want: "file:///tmp/singularitree/cache.db?" + dsnPragmas,
		},
		{
			name: "posix with spaces",
			path: "/tmp/a b/cache.db",
			want: "file:///tmp/a%20b/cache.db?" + dsnPragmas,
		},
		{
			name: "windows backslashes",
			path: `C:\Users\RUNNER~1\AppData\Local\Temp\sig\cache.db`,
			want: "file:///C:/Users/RUNNER~1/AppData/Local/Temp/sig/cache.db?" + dsnPragmas,
		},
		{
			name: "windows forward slashes",
			path: "D:/tmp/singularitree/cache.db",
			want: "file:///D:/tmp/singularitree/cache.db?" + dsnPragmas,
		},
		{
			name: "already a file uri",
			path: "file:/tmp/singularitree/cache.db",
			want: "file:/tmp/singularitree/cache.db?" + dsnPragmas,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := buildDSN(tt.path); got != tt.want {
				t.Errorf("buildDSN(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}

func TestOpenSQLiteAndMigrations(t *testing.T) {
	db := openTestDB(t)

	// Re-applying must be idempotent.
	if err := ApplyMigrations(context.Background(), db); err != nil {
		t.Fatalf("ApplyMigrations (second run): %v", err)
	}

	for _, table := range []string{"repos", "commit_cache", "file_status", "stash_cache"} {
		var name string
		err := db.QueryRow(
			`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table,
		).Scan(&name)
		if errors.Is(err, sql.ErrNoRows) {
			t.Errorf("table %q not created", table)
		} else if err != nil {
			t.Errorf("query table %q: %v", table, err)
		}
	}
}

func TestOpenSQLiteInMemory(t *testing.T) {
	db, err := OpenSQLite(":memory:")
	if err != nil {
		t.Fatalf("OpenSQLite(:memory:): %v", err)
	}
	defer db.Close()

	if err := ApplyMigrations(context.Background(), db); err != nil {
		t.Fatalf("ApplyMigrations: %v", err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM repos`).Scan(&n); err != nil {
		t.Fatalf("count repos: %v", err)
	}
	if n != 0 {
		t.Fatalf("repos count = %d, want 0", n)
	}
}

func TestRepoStoreRoundTrip(t *testing.T) {
	ctx := context.Background()
	store := NewRepoStore(openTestDB(t))

	pathA := t.TempDir()
	pathB := t.TempDir()

	repoA, err := store.Open(ctx, pathA)
	if err != nil {
		t.Fatalf("Open(A): %v", err)
	}
	if repoA.ID == "" {
		t.Fatal("Open(A) returned empty id")
	}
	if !filepath.IsAbs(repoA.FsPath) {
		t.Errorf("FsPath %q is not absolute", repoA.FsPath)
	}
	if repoA.Name != filepath.Base(pathA) {
		t.Errorf("Name = %q, want %q", repoA.Name, filepath.Base(pathA))
	}
	if repoA.CommonDir != filepath.Join(repoA.FsPath, ".git") {
		t.Errorf("CommonDir = %q, want default .git", repoA.CommonDir)
	}

	// Idempotent re-open: same id, preserved created_at, refreshed last_opened_at.
	reopened, err := store.Open(ctx, pathA)
	if err != nil {
		t.Fatalf("Open(A) again: %v", err)
	}
	if reopened.ID != repoA.ID {
		t.Errorf("id changed on reopen: %q -> %q", repoA.ID, reopened.ID)
	}
	if !reopened.CreatedAt.Equal(repoA.CreatedAt) {
		t.Errorf("created_at changed on reopen: %v -> %v", repoA.CreatedAt, reopened.CreatedAt)
	}
	if reopened.LastOpenedAt.Before(repoA.LastOpenedAt) {
		t.Errorf("last_opened_at went backwards: %v -> %v", repoA.LastOpenedAt, reopened.LastOpenedAt)
	}

	// Second repo opened after A should sort first (last_opened_at DESC).
	repoB, err := store.Open(ctx, pathB)
	if err != nil {
		t.Fatalf("Open(B): %v", err)
	}

	list, err := store.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("List len = %d, want 2", len(list))
	}
	if list[0].ID != repoB.ID {
		t.Errorf("List[0] = %q, want most recent B %q", list[0].ID, repoB.ID)
	}

	got, err := store.Get(ctx, repoA.ID)
	if err != nil {
		t.Fatalf("Get(A): %v", err)
	}
	if got.FsPath != repoA.FsPath {
		t.Errorf("Get(A).FsPath = %q, want %q", got.FsPath, repoA.FsPath)
	}

	if err := store.Remove(ctx, repoA.ID); err != nil {
		t.Fatalf("Remove(A): %v", err)
	}
	if _, err := store.Get(ctx, repoA.ID); err == nil {
		t.Fatal("Get(A) after Remove succeeded, want error")
	} else {
		var appErr domain.AppError
		if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeRepoNotFound {
			t.Errorf("Get(A) after Remove err = %v, want REPO_NOT_FOUND", err)
		}
	}

	if err := store.Remove(ctx, domain.RepositoryId("does-not-exist")); err == nil {
		t.Fatal("Remove(unknown) succeeded, want error")
	}

	list, err = store.List(ctx)
	if err != nil {
		t.Fatalf("List after Remove: %v", err)
	}
	if len(list) != 1 || list[0].ID != repoB.ID {
		t.Fatalf("List after Remove = %+v, want only B", list)
	}

	// Post-removal ordering regression: a later-opened repo sorts ahead of the
	// survivor, and removing that newer head leaves the survivor's position
	// pinned (relative order of the remaining rows is unaffected by the delete).
	repoC, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("Open(C): %v", err)
	}
	list, err = store.List(ctx)
	if err != nil {
		t.Fatalf("List with C: %v", err)
	}
	if len(list) != 2 || list[0].ID != repoC.ID || list[1].ID != repoB.ID {
		t.Fatalf("List with C = %+v, want [C, B]", list)
	}
	if err := store.Remove(ctx, repoC.ID); err != nil {
		t.Fatalf("Remove(C): %v", err)
	}
	list, err = store.List(ctx)
	if err != nil {
		t.Fatalf("List after Remove(C): %v", err)
	}
	if len(list) != 1 || list[0].ID != repoB.ID {
		t.Fatalf("List after Remove(C) = %+v, want only B", list)
	}
}

// TestRepoStoreListTieBreaksByInsertionOrder pins the deterministic tiebreaker
// for two repos sharing an identical last_opened_at (on Windows the wall clock
// can be too coarse to distinguish two rapid opens): the later-inserted row must
// sort first. Without the rowid DESC term SQLite leaves the order unspecified.
func TestRepoStoreListTieBreaksByInsertionOrder(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	store := NewRepoStore(db)

	repoA, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("Open(A): %v", err)
	}
	repoB, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("Open(B): %v", err)
	}

	// Force the exact tie a coarse clock would produce.
	const tied = "2026-01-01T00:00:00Z"
	if _, err := db.ExecContext(ctx, `UPDATE repos SET last_opened_at = ?`, tied); err != nil {
		t.Fatalf("tie last_opened_at: %v", err)
	}

	list, err := store.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("List len = %d, want 2", len(list))
	}
	if list[0].ID != repoB.ID || list[1].ID != repoA.ID {
		t.Errorf("List = [%q, %q], want later-inserted B first [%q, %q]",
			list[0].ID, list[1].ID, repoB.ID, repoA.ID)
	}
}

// TestRepoStoreRemoveCascades verifies that removing a repository also deletes
// its child rows via ON DELETE CASCADE (PRAGMA foreign_keys=ON, ADR-006).
func TestRepoStoreRemoveCascades(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	store := NewRepoStore(db)

	repo, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	id := string(repo.ID)

	// One row in each child table so removal must cascade across all three.
	if _, err := db.ExecContext(ctx,
		`INSERT INTO commit_cache
		 (repo_id, oid, parents, author_name, author_email, author_when,
		  committer_name, committer_email, committer_when, message, tree_oid, committed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, "abc123", "[]", "Alice", "alice@example.com", "2024-01-01T00:00:00Z",
		"Alice", "alice@example.com", "2024-01-01T00:00:00Z", "msg", "tree1", "2024-01-01T00:00:00Z",
	); err != nil {
		t.Fatalf("insert commit_cache: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO file_status (repo_id, path, staged, unstaged, is_staged, is_conflicted)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		id, "a.txt", "M", " ", 1, 0,
	); err != nil {
		t.Fatalf("insert file_status: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO stash_cache (repo_id, stash_index, oid, message, branch_name, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		id, 0, "deadbeef", "wip", "main", "2024-01-01T00:00:00Z",
	); err != nil {
		t.Fatalf("insert stash_cache: %v", err)
	}

	if err := store.Remove(ctx, repo.ID); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	for _, table := range []string{"commit_cache", "file_status", "stash_cache", "repos"} {
		var n int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		if n != 0 {
			t.Errorf("%s count = %d, want 0 (cascade failed)", table, n)
		}
	}
}
