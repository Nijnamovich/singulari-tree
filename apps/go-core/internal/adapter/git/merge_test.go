package git

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// TestMergeFastForwardAndNoFF covers clean merges: the default strategy
// fast-forwards a linear feature branch, while NO_FF forces a merge commit.
func TestMergeFastForwardAndNoFF(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")

	gitRun(t, dir, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(dir, "c.txt"), "three\n")
	gitRun(t, dir, "add", "c.txt")
	gitRun(t, dir, "commit", "-q", "-m", "feature commit")
	featureTip := gitRun(t, dir, "rev-parse", "HEAD")
	gitRun(t, dir, "checkout", "-q", "main")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	res, err := a.Merge(ctx, repoID, "feature", domain.MergeStrategyMerge, false, "")
	if err != nil {
		t.Fatalf("Merge(fast-forward): %v", err)
	}
	if res.HasConflict {
		t.Errorf("HasConflict = true, want false")
	}
	if got := gitRun(t, dir, "rev-parse", "HEAD"); got != featureTip {
		t.Errorf("HEAD = %q, want fast-forwarded %q", got, featureTip)
	}
	if res.Oid.Hex != featureTip {
		t.Errorf("result.Oid = %q, want %q", res.Oid.Hex, featureTip)
	}

	// A second feature branch with a further commit: NO_FF creates a merge.
	gitRun(t, dir, "checkout", "-q", "-b", "feature2")
	writeFile(t, filepath.Join(dir, "d.txt"), "four\n")
	gitRun(t, dir, "add", "d.txt")
	gitRun(t, dir, "commit", "-q", "-m", "feature2 commit")
	gitRun(t, dir, "checkout", "-q", "main")
	before := gitRun(t, dir, "rev-parse", "HEAD")

	if _, err := a.Merge(ctx, repoID, "feature2", domain.MergeStrategyNoFF, false, ""); err != nil {
		t.Fatalf("Merge(no-ff): %v", err)
	}
	after := gitRun(t, dir, "rev-parse", "HEAD")
	if after == before {
		t.Fatal("HEAD did not advance across a --no-ff merge")
	}
	if parents := gitRun(t, dir, "rev-list", "--parents", "-n", "1", "HEAD"); len(strings.Fields(parents)) != 3 {
		t.Errorf("merge commit = %q, want two parents", parents)
	}
}

// TestMergeSquash stages without committing.
func TestMergeSquash(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")

	gitRun(t, dir, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(dir, "c.txt"), "three\n")
	gitRun(t, dir, "add", "c.txt")
	gitRun(t, dir, "commit", "-q", "-m", "feature commit")
	gitRun(t, dir, "checkout", "-q", "main")
	before := gitRun(t, dir, "rev-parse", "HEAD")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	if _, err := a.Merge(context.Background(), domain.RepositoryId("repo-1"), "feature", domain.MergeStrategySquash, false, ""); err != nil {
		t.Fatalf("Merge(squash): %v", err)
	}
	if got := gitRun(t, dir, "rev-parse", "HEAD"); got != before {
		t.Errorf("HEAD = %q, want unchanged %q (squash does not commit)", got, before)
	}
	if got := gitRun(t, dir, "diff", "--cached", "--name-only"); got != "c.txt" {
		t.Errorf("staged files = %q, want c.txt", got)
	}
}

// TestMergeConflictLeavesTreeConflicted proves a conflicting merge returns a
// result with HasConflict, a typed MERGE_CONFLICT error, and leaves the tree
// conflicted so Status surfaces is_conflicted (ADR-028).
func TestMergeConflictLeavesTreeConflicted(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")

	gitRun(t, dir, "checkout", "-q", "-b", "other")
	writeFile(t, filepath.Join(dir, "a.txt"), "other\n")
	gitRun(t, dir, "add", "a.txt")
	gitRun(t, dir, "commit", "-q", "-m", "other change")

	gitRun(t, dir, "checkout", "-q", "main")
	writeFile(t, filepath.Join(dir, "a.txt"), "main\n")
	gitRun(t, dir, "add", "a.txt")
	gitRun(t, dir, "commit", "-q", "-m", "main change")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()

	res, err := a.Merge(ctx, domain.RepositoryId("repo-1"), "other", domain.MergeStrategyMerge, false, "")
	if err == nil {
		t.Fatal("Merge(conflicting) returned nil error, want MERGE_CONFLICT")
	}
	assertAppCode(t, err, domain.ErrCodeMergeConflict)
	if res == nil || !res.HasConflict {
		t.Fatalf("result = %+v, want HasConflict true", res)
	}

	// The merge is still in progress and a.txt is conflicted.
	if _, err := runGit(ctx, dir, "rev-parse", "--verify", "MERGE_HEAD"); err != nil {
		t.Errorf("MERGE_HEAD missing: the tree was not left conflicted: %v", err)
	}
	statuses, err := a.Status(ctx, domain.RepositoryId("repo-1"))
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	var conflicted bool
	for _, s := range statuses {
		if s.IsConflicted {
			conflicted = true
		}
	}
	if !conflicted {
		t.Errorf("Status = %+v, want at least one IsConflicted entry", statuses)
	}
}

// TestMergeFFOnlyDivergedFails proves a non-conflict failure maps to
// MERGE_FAILED (not MERGE_CONFLICT) and leaves the tree clean.
func TestMergeFFOnlyDivergedFails(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")

	gitRun(t, dir, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(dir, "c.txt"), "three\n")
	gitRun(t, dir, "add", "c.txt")
	gitRun(t, dir, "commit", "-q", "-m", "feature commit")

	gitRun(t, dir, "checkout", "-q", "main")
	writeFile(t, filepath.Join(dir, "d.txt"), "four\n")
	gitRun(t, dir, "add", "d.txt")
	gitRun(t, dir, "commit", "-q", "-m", "main commit")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	_, err := a.Merge(context.Background(), domain.RepositoryId("repo-1"), "feature", domain.MergeStrategyFFOnly, false, "")
	if err == nil {
		t.Fatal("Merge(ff-only, diverged) succeeded, want MERGE_FAILED")
	}
	assertAppCode(t, err, domain.ErrCodeMergeFailed)
	if got := gitRun(t, dir, "status", "--porcelain"); got != "" {
		t.Errorf("working tree dirty after a failed merge: %q", got)
	}
}

// TestMergeRejectsUnspecifiedStrategy proves the zero strategy is rejected.
func TestMergeRejectsUnspecifiedStrategy(t *testing.T) {
	dir := initRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	_, err := a.Merge(context.Background(), domain.RepositoryId("repo-1"), "main", domain.MergeStrategyUnspecified, false, "")
	assertAppCode(t, err, domain.ErrCodeMergeFailed)
}

// TestMergeNoCommitCustomMessage covers the --no-commit and -m pass-through.
func TestMergeNoCommitCustomMessage(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")

	gitRun(t, dir, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(dir, "c.txt"), "three\n")
	gitRun(t, dir, "add", "c.txt")
	gitRun(t, dir, "commit", "-q", "-m", "feature commit")
	gitRun(t, dir, "checkout", "-q", "main")
	before := gitRun(t, dir, "rev-parse", "HEAD")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	if _, err := a.Merge(context.Background(), domain.RepositoryId("repo-1"), "feature", domain.MergeStrategyNoFF, true, "merge it"); err != nil {
		t.Fatalf("Merge(no-commit): %v", err)
	}
	if got := gitRun(t, dir, "rev-parse", "HEAD"); got != before {
		t.Errorf("HEAD = %q, want unchanged %q (no-commit must not commit)", got, before)
	}
	// The merge is staged and ready to commit.
	if got := gitRun(t, dir, "status", "--porcelain"); got == "" {
		t.Error("no staged merge changes after --no-commit")
	}
}
