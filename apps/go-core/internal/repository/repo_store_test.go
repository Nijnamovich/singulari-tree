package repository

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// absPath mirrors the store's own normalization (filepath.Abs(filepath.Clean))
// so fixtures compare against exactly the value the store persists.
func absPath(t *testing.T, path string) string {
	t.Helper()
	abs, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		t.Fatalf("abs(%q): %v", path, err)
	}
	return abs
}

// TestRepoStoreRelocateUpdatesPathPreservesIDAndCreatedAt pins the core promise
// of relocation: the registration id and created_at survive, the path,
// common_dir and name are repointed, and exactly one row remains.
func TestRepoStoreRelocateUpdatesPathPreservesIDAndCreatedAt(t *testing.T) {
	ctx := context.Background()
	store := NewRepoStore(openTestDB(t))

	pathA := t.TempDir()
	pathB := t.TempDir()

	// The two folders must have different basenames for the name repoint below
	// to be meaningful (t.TempDir mints unique leaf directories).
	if filepath.Base(pathA) == filepath.Base(pathB) {
		t.Fatalf("fixtures collide: both basenames are %q", filepath.Base(pathA))
	}

	repo, err := store.Open(ctx, pathA)
	if err != nil {
		t.Fatalf("Open(A): %v", err)
	}
	if repo.CommonDir != filepath.Join(repo.FsPath, ".git") {
		t.Fatalf("CommonDir(A) = %q, want default .git", repo.CommonDir)
	}
	if want := filepath.Base(repo.FsPath); repo.Name != want {
		t.Fatalf("Name(A) = %q, want %q", repo.Name, want)
	}

	moved, err := store.Relocate(ctx, repo.ID, pathB)
	if err != nil {
		t.Fatalf("Relocate: %v", err)
	}

	wantPath := absPath(t, pathB)
	if moved.ID != repo.ID {
		t.Errorf("id changed on relocate: %q -> %q", repo.ID, moved.ID)
	}
	if !moved.CreatedAt.Equal(repo.CreatedAt) {
		t.Errorf("created_at changed on relocate: %v -> %v", repo.CreatedAt, moved.CreatedAt)
	}
	if moved.FsPath != wantPath {
		t.Errorf("FsPath = %q, want %q", moved.FsPath, wantPath)
	}
	if moved.CommonDir != filepath.Join(wantPath, ".git") {
		t.Errorf("CommonDir = %q, want refreshed %q", moved.CommonDir, filepath.Join(wantPath, ".git"))
	}
	// The display name follows the new path's basename, exactly as Open derives
	// it for a fresh registration; a stale name would surface the old folder in
	// the drawer/nav-rail/tab while the path line already shows the new one.
	if moved.Name != filepath.Base(wantPath) {
		t.Errorf("Name = %q, want repointed basename %q", moved.Name, filepath.Base(wantPath))
	}

	// Durable: a fresh read returns the repointed path and name, and no extra
	// row exists.
	got, err := store.Get(ctx, repo.ID)
	if err != nil {
		t.Fatalf("Get after Relocate: %v", err)
	}
	if got.FsPath != wantPath {
		t.Errorf("Get.FsPath = %q, want %q", got.FsPath, wantPath)
	}
	if got.Name != filepath.Base(wantPath) {
		t.Errorf("Get.Name = %q, want %q", got.Name, filepath.Base(wantPath))
	}
	list, err := store.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 || list[0].ID != repo.ID {
		t.Fatalf("List = %+v, want only the relocated repo", list)
	}
}

// TestRepoStoreRelocateNoOpRefreshesCommonDir proves a same-path relocate is
// allowed and still recomputes common_dir and name rather than short-circuiting.
// Recomputing name from an already-correct value must be a no-op (idempotent),
// not a corruption.
func TestRepoStoreRelocateNoOpRefreshesCommonDir(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	store := NewRepoStore(db)

	repo, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	// Simulate stale state: common_dir no longer matches the path.
	if _, err := db.ExecContext(ctx,
		`UPDATE repos SET common_dir = ? WHERE id = ?`, "/stale/common", string(repo.ID),
	); err != nil {
		t.Fatalf("poison common_dir: %v", err)
	}

	moved, err := store.Relocate(ctx, repo.ID, repo.FsPath)
	if err != nil {
		t.Fatalf("Relocate (no-op): %v", err)
	}
	if want := filepath.Join(absPath(t, repo.FsPath), ".git"); moved.CommonDir != want {
		t.Errorf("CommonDir = %q, want refreshed %q", moved.CommonDir, want)
	}
	if !moved.CreatedAt.Equal(repo.CreatedAt) {
		t.Errorf("created_at changed on no-op relocate: %v -> %v", repo.CreatedAt, moved.CreatedAt)
	}
	// The name was already the correct basename; the no-op recompute must leave
	// it exactly as-is.
	if want := filepath.Base(absPath(t, repo.FsPath)); moved.Name != want {
		t.Errorf("Name = %q, want unchanged/refreshed %q", moved.Name, want)
	}
}

func TestRepoStoreRelocateUnknownID(t *testing.T) {
	ctx := context.Background()
	store := NewRepoStore(openTestDB(t))

	_, err := store.Relocate(ctx, domain.RepositoryId("does-not-exist"), t.TempDir())

	var appErr domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeRepoNotFound {
		t.Fatalf("err = %v, want REPO_NOT_FOUND", err)
	}
}

func TestRepoStoreRelocateBlankPath(t *testing.T) {
	ctx := context.Background()
	store := NewRepoStore(openTestDB(t))

	repo, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	_, err = store.Relocate(ctx, repo.ID, "   ")

	var appErr domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeRepoPathMissing {
		t.Fatalf("err = %v, want REPO_PATH_MISSING for a blank path", err)
	}
}

// TestRepoStoreRelocateDuplicateTarget proves targeting a path already tracked
// by a different repository is the typed REPO_PATH_IN_USE envelope (detected
// before the UNIQUE constraint would fire), and leaves the source untouched.
func TestRepoStoreRelocateDuplicateTarget(t *testing.T) {
	ctx := context.Background()
	store := NewRepoStore(openTestDB(t))

	pathA := t.TempDir()
	pathB := t.TempDir()
	repoA, err := store.Open(ctx, pathA)
	if err != nil {
		t.Fatalf("Open(A): %v", err)
	}
	if _, err := store.Open(ctx, pathB); err != nil {
		t.Fatalf("Open(B): %v", err)
	}

	_, err = store.Relocate(ctx, repoA.ID, pathB)

	var appErr domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeRepoPathInUse {
		t.Fatalf("err = %v, want REPO_PATH_IN_USE", err)
	}

	gotA, err := store.Get(ctx, repoA.ID)
	if err != nil {
		t.Fatalf("Get(A) after failed Relocate: %v", err)
	}
	if want := absPath(t, pathA); gotA.FsPath != want {
		t.Errorf("A.FsPath = %q, want unchanged %q", gotA.FsPath, want)
	}
}

// TestRepoStoreRelocateConflictGuarantee pins the guarantee that Relocate's
// conflict check and UPDATE are atomic and always surface the typed
// REPO_PATH_IN_USE envelope for a duplicate target.
//
// A literal mid-statement race — an Open committing the target path between the
// check and the UPDATE of the same call — is not deterministically reproducible
// from an in-process test without instrumenting the store (the transaction now
// holds the read snapshot across both statements, so an interleaved commit can
// only surface as SQLITE_BUSY_SNAPSHOT, never as a silent overwrite). This test
// therefore exercises the transaction round-trip as directly as the setup
// allows, using a *second* connection to the same database as the stand-in for
// the concurrent writer:
//   - a duplicate target already committed by that second connection is rejected
//     with REPO_PATH_IN_USE and leaves the source untouched;
//   - an unknown id is REPO_NOT_FOUND (checked before the conflict path);
//   - a fresh path relocates successfully, preserving id/created_at and
//     refreshing common_dir.
//
// It is the single transaction that closes the check→update window the previous
// two-statement implementation left open.
func TestRepoStoreRelocateConflictGuarantee(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "cache.db")

	db, err := OpenSQLite(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := ApplyMigrations(ctx, db); err != nil {
		t.Fatalf("ApplyMigrations: %v", err)
	}
	store := NewRepoStore(db)

	// A second connection stands in for the concurrent writer the promise is
	// about; it commits a conflicting target via the real Open path.
	db2, err := OpenSQLite(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLite (second connection): %v", err)
	}
	t.Cleanup(func() { _ = db2.Close() })
	store2 := NewRepoStore(db2)

	pathA := t.TempDir()
	repoA, err := store.Open(ctx, pathA)
	if err != nil {
		t.Fatalf("Open(A): %v", err)
	}

	target := t.TempDir()
	if _, err := store2.Open(ctx, target); err != nil {
		t.Fatalf("Open(target) via second connection: %v", err)
	}

	// Duplicate-target rejection: typed, and A stays put.
	_, err = store.Relocate(ctx, repoA.ID, target)
	var appErr domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeRepoPathInUse {
		t.Fatalf("Relocate(duplicate target) err = %v, want REPO_PATH_IN_USE", err)
	}
	gotA, err := store.Get(ctx, repoA.ID)
	if err != nil {
		t.Fatalf("Get(A) after rejected Relocate: %v", err)
	}
	if want := absPath(t, pathA); gotA.FsPath != want {
		t.Errorf("A.FsPath = %q, want unchanged %q", gotA.FsPath, want)
	}

	// Unknown-id rejection is resolved before any conflict handling.
	appErr = domain.AppError{}
	_, err = store.Relocate(ctx, domain.RepositoryId("does-not-exist"), t.TempDir())
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeRepoNotFound {
		t.Fatalf("Relocate(unknown id) err = %v, want REPO_NOT_FOUND", err)
	}

	// Successful round-trip: a fresh path relocates, preserving id/created_at.
	fresh := t.TempDir()
	moved, err := store.Relocate(ctx, repoA.ID, fresh)
	if err != nil {
		t.Fatalf("Relocate(fresh): %v", err)
	}
	wantFresh := absPath(t, fresh)
	if moved.ID != repoA.ID {
		t.Errorf("id changed on relocate: %q -> %q", repoA.ID, moved.ID)
	}
	if !moved.CreatedAt.Equal(repoA.CreatedAt) {
		t.Errorf("created_at changed on relocate: %v -> %v", repoA.CreatedAt, moved.CreatedAt)
	}
	if moved.FsPath != wantFresh {
		t.Errorf("FsPath = %q, want %q", moved.FsPath, wantFresh)
	}
	if moved.CommonDir != filepath.Join(wantFresh, ".git") {
		t.Errorf("CommonDir = %q, want refreshed %q", moved.CommonDir, filepath.Join(wantFresh, ".git"))
	}
}
