package git

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// TestCommitStatsRootAndLinear proves a root commit diffs against the empty tree
// and a linear commit against its first parent.
func TestCommitStatsRootAndLinear(t *testing.T) {
	dir := initRepo(t)
	root := gitRun(t, dir, "rev-parse", "HEAD~1")
	head := gitRun(t, dir, "rev-parse", "HEAD")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	stats, err := a.CommitStats(context.Background(), domain.RepositoryId("repo-1"), []string{root, head})
	if err != nil {
		t.Fatalf("CommitStats: %v", err)
	}
	if len(stats) != 2 {
		t.Fatalf("len(stats) = %d, want 2", len(stats))
	}
	// root adds a.txt ("one\n"): 1 addition, 1 file.
	if stats[0].Oid != root || stats[0].Additions != 1 || stats[0].Deletions != 0 || stats[0].FilesChanged != 1 {
		t.Errorf("root stats = %+v, want +1 -0 files 1", stats[0])
	}
	// head adds b.txt ("two\n"): 1 addition, 1 file.
	if stats[1].Oid != head || stats[1].Additions != 1 || stats[1].Deletions != 0 || stats[1].FilesChanged != 1 {
		t.Errorf("head stats = %+v, want +1 -0 files 1", stats[1])
	}
}

// TestCommitStatsMergeFirstParent proves a merge commit is diffed against its
// first parent by policy: only the side branch's change is counted.
func TestCommitStatsMergeFirstParent(t *testing.T) {
	dir := initRepo(t)
	mainBranch := gitRun(t, dir, "rev-parse", "--abbrev-ref", "HEAD")

	gitRun(t, dir, "checkout", "-q", "-b", "side")
	writeFile(t, filepath.Join(dir, "side.txt"), "side\n")
	gitRun(t, dir, "add", "side.txt")
	gitRun(t, dir, "commit", "-q", "-m", "side change")

	gitRun(t, dir, "checkout", "-q", mainBranch)
	writeFile(t, filepath.Join(dir, "main.txt"), "main\n")
	gitRun(t, dir, "add", "main.txt")
	gitRun(t, dir, "commit", "-q", "-m", "main change")

	gitRun(t, dir, "merge", "--no-ff", "-q", "-m", "merge side", "side")
	mergeOid := gitRun(t, dir, "rev-parse", "HEAD")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	stats, err := a.CommitStats(context.Background(), domain.RepositoryId("repo-1"), []string{mergeOid})
	if err != nil {
		t.Fatalf("CommitStats(merge): %v", err)
	}
	if len(stats) != 1 {
		t.Fatalf("len(stats) = %d, want 1", len(stats))
	}
	// Against the first parent only side.txt is new: +1 -0 files 1. Diffing
	// against all parents would also count main.txt.
	if stats[0].Additions != 1 || stats[0].Deletions != 0 || stats[0].FilesChanged != 1 {
		t.Errorf("merge stats = %+v, want +1 -0 files 1 (first parent)", stats[0])
	}
}

// TestCommitStatsBinary proves a binary change contributes a files-changed
// entry with zero additions/deletions (numstat reports `-`).
func TestCommitStatsBinary(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "img.bin"), "\x00\x01\x02binary")
	gitRun(t, dir, "add", "img.bin")
	gitRun(t, dir, "commit", "-q", "-m", "add binary")
	head := gitRun(t, dir, "rev-parse", "HEAD")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	stats, err := a.CommitStats(context.Background(), domain.RepositoryId("repo-1"), []string{head})
	if err != nil {
		t.Fatalf("CommitStats(binary): %v", err)
	}
	if stats[0].FilesChanged != 1 || stats[0].Additions != 0 || stats[0].Deletions != 0 {
		t.Errorf("binary stats = %+v, want files 1 +0 -0", stats[0])
	}
}

// TestCommitStatsUnknownOid proves an unknown oid yields COMMIT_NOT_FOUND.
func TestCommitStatsUnknownOid(t *testing.T) {
	dir := initRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	_, err := a.CommitStats(context.Background(), domain.RepositoryId("repo-1"), []string{"0000000000000000000000000000000000000000"})
	if err == nil {
		t.Fatal("CommitStats(unknown) succeeded, want COMMIT_NOT_FOUND")
	}
	assertAppCode(t, err, domain.ErrCodeCommitNotFound)
}
