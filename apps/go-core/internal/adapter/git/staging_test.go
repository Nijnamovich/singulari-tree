package git

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// TestStageHunkRoundTrip proves staging a whole hunk moves it into the index and
// that unstaging/discarding restore the index/worktree.
func TestStageHunkRoundTrip(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "a.txt"), "one\nmore\n")

	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	if err := a.StageHunk(ctx, repoID, "a.txt", 0, nil); err != nil {
		t.Fatalf("StageHunk: %v", err)
	}
	if got := indexContent(t, dir, "a.txt"); got != "one\nmore" {
		t.Fatalf("index after stage = %q, want %q", got, "one\nmore")
	}

	if err := a.UnstageHunk(ctx, repoID, "a.txt", 0, nil); err != nil {
		t.Fatalf("UnstageHunk: %v", err)
	}
	if got := indexContent(t, dir, "a.txt"); got != "one" {
		t.Fatalf("index after unstage = %q, want %q", got, "one")
	}

	if err := a.DiscardHunk(ctx, repoID, "a.txt", 0, nil); err != nil {
		t.Fatalf("DiscardHunk: %v", err)
	}
	if fileContent(t, filepath.Join(dir, "a.txt")) != "one\n" {
		t.Fatalf("worktree after discard = %q, want %q", fileContent(t, filepath.Join(dir, "a.txt")), "one\n")
	}
}

// TestStageHunkLineLevel proves line-level selection stages only the selected
// added line, leaving the unselected additions/changes in the worktree.
func TestStageHunkLineLevel(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "line.txt"), "a\nb\nc\n")
	gitRun(t, dir, "add", "line.txt")
	gitRun(t, dir, "commit", "-q", "-m", "add line.txt")
	// Worktree diff (index a,b,c -> worktree a,X,Y,c):
	//   0 ctx a, 1 -b, 2 +X, 3 +Y, 4 ctx c
	writeFile(t, filepath.Join(dir, "line.txt"), "a\nX\nY\nc\n")

	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	// Select only the +X line (index 2).
	if err := a.StageHunk(ctx, repoID, "line.txt", 0, []uint32{2}); err != nil {
		t.Fatalf("StageHunk(line): %v", err)
	}
	if got := indexContent(t, dir, "line.txt"); got != "a\nb\nX\nc" {
		t.Fatalf("index after line stage = %q, want %q", got, "a\nb\nX\nc")
	}
	if got := fileContent(t, filepath.Join(dir, "line.txt")); got != "a\nX\nY\nc\n" {
		t.Fatalf("worktree changed by staging: %q", got)
	}

	// Unstage just the staged +X line again.
	if err := a.UnstageHunk(ctx, repoID, "line.txt", 0, []uint32{2}); err != nil {
		t.Fatalf("UnstageHunk(line): %v", err)
	}
	if got := indexContent(t, dir, "line.txt"); got != "a\nb\nc" {
		t.Fatalf("index after line unstage = %q, want %q", got, "a\nb\nc")
	}
}

// TestDiscardHunkLineLevel proves line-level discard reverts only the selected
// line in the worktree.
func TestDiscardHunkLineLevel(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "line.txt"), "a\nb\nc\n")
	gitRun(t, dir, "add", "line.txt")
	gitRun(t, dir, "commit", "-q", "-m", "add line.txt")
	// Worktree diff (index a,b,c -> worktree a,X,Y,b,c):
	//   0 ctx a, 1 +X, 2 +Y, 3 ctx b, 4 ctx c
	writeFile(t, filepath.Join(dir, "line.txt"), "a\nX\nY\nb\nc\n")

	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	// Discard only +X (index 1): worktree becomes a,Y,b,c.
	if err := a.DiscardHunk(ctx, repoID, "line.txt", 0, []uint32{1}); err != nil {
		t.Fatalf("DiscardHunk(line): %v", err)
	}
	if got := fileContent(t, filepath.Join(dir, "line.txt")); got != "a\nY\nb\nc\n" {
		t.Fatalf("worktree after line discard = %q, want %q", got, "a\nY\nb\nc\n")
	}
}

// TestUnstageHunkNewFile proves unstaging a whole hunk of a newly added file
// removes it from the index (the reverse of a `new file` patch).
func TestUnstageHunkNewFile(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "new.txt"), "a\nb\n")
	gitRun(t, dir, "add", "new.txt")

	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	if err := a.UnstageHunk(ctx, repoID, "new.txt", 0, nil); err != nil {
		t.Fatalf("UnstageHunk(new file): %v", err)
	}
	if got := gitRun(t, dir, "status", "--porcelain"); got != "?? new.txt" {
		t.Fatalf("status after unstage = %q, want %q", got, "?? new.txt")
	}
}

// TestStageHunkErrors proves hunk targeting of an untracked path and an
// out-of-range hunk index both fail with a typed error.
func TestStageHunkErrors(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "untracked.txt"), "x\n")

	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	if err := a.StageHunk(ctx, repoID, "untracked.txt", 0, nil); err == nil {
		t.Error("StageHunk(untracked) succeeded, want error")
	} else {
		assertAppCode(t, err, domain.ErrCodeStageFailed)
	}

	writeFile(t, filepath.Join(dir, "a.txt"), "changed\n")
	if err := a.StageHunk(ctx, repoID, "a.txt", 99, nil); err == nil {
		t.Error("StageHunk(bad hunk index) succeeded, want error")
	} else {
		assertAppCode(t, err, domain.ErrCodeStageFailed)
	}

	if err := a.StageHunk(ctx, repoID, "bad\x00path", 0, nil); err == nil {
		t.Error("StageHunk(invalid path) succeeded, want error")
	} else {
		assertAppCode(t, err, domain.ErrCodeStageFailed)
	}
}
