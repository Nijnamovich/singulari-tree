package git

import (
	"context"
	"errors"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// TestBranchCreate covers creating a branch from an explicit start point, from
// a bare ref, with checkout, and from a raw oid start point (ADR-028).
func TestBranchCreate(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	head := gitRun(t, dir, "rev-parse", "HEAD")
	parent := gitRun(t, dir, "rev-parse", "HEAD~1")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	// Create from a ref, without checkout.
	b, err := a.BranchCreate(ctx, repoID, "feature/login", "main", false)
	if err != nil {
		t.Fatalf("BranchCreate: %v", err)
	}
	if b.Name != "feature/login" || b.RefName.Raw != "refs/heads/feature/login" {
		t.Errorf("branch = %+v, want feature/login", b)
	}
	if b.IsCurrent {
		t.Errorf("IsCurrent = true, want false (main stays checked out)")
	}
	if b.Tip.Hex != head {
		t.Errorf("tip = %s, want HEAD %s", b.Tip.Hex, head)
	}

	// Create with checkout switches HEAD.
	b2, err := a.BranchCreate(ctx, repoID, "feature/checkout", "main", true)
	if err != nil {
		t.Fatalf("BranchCreate(checkout): %v", err)
	}
	if !b2.IsCurrent {
		t.Errorf("IsCurrent = false, want true after checkout")
	}
	if got := gitRun(t, dir, "symbolic-ref", "--short", "HEAD"); got != "feature/checkout" {
		t.Errorf("HEAD = %q, want feature/checkout", got)
	}

	// Empty start point means HEAD (the checked-out branch tip).
	if _, err := a.BranchCreate(ctx, repoID, "from-head", "", false); err != nil {
		t.Fatalf("BranchCreate(empty startPoint): %v", err)
	}
	if got := gitRun(t, dir, "rev-parse", "--verify", "refs/heads/from-head"); got != head {
		t.Errorf("from-head tip = %q, want %q", got, head)
	}

	// A raw oid is a valid start point (unrelated history).
	if _, err := a.BranchCreate(ctx, repoID, "old-tip", parent, false); err != nil {
		t.Fatalf("BranchCreate(parent oid): %v", err)
	}
	if got := gitRun(t, dir, "rev-parse", "--verify", "refs/heads/old-tip"); got != parent {
		t.Errorf("old-tip tip = %q, want %q", got, parent)
	}
}

// TestBranchCreateErrors covers the collision and invalid-input paths.
func TestBranchCreateErrors(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	gitRun(t, dir, "branch", "existing")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	_, err := a.BranchCreate(ctx, repoID, "existing", "main", false)
	assertAppCode(t, err, domain.ErrCodeBranchExists)

	// Invalid names are rejected before any git call.
	for _, name := range []string{"", "-bad", "has space"} {
		if _, err := a.BranchCreate(ctx, repoID, name, "main", false); err == nil {
			t.Errorf("BranchCreate(%q) succeeded, want error", name)
		} else {
			assertAppCode(t, err, domain.ErrCodeBranchNotFound)
		}
	}

	// An unresolvable start point is a typed branch error, not a silent pass.
	if _, err := a.BranchCreate(ctx, repoID, "newone", "no-such-ref", false); err == nil {
		t.Fatal("BranchCreate(bad startPoint) succeeded, want error")
	} else {
		assertAppCode(t, err, domain.ErrCodeBranchNotFound)
	}
}

// TestBranchRename covers renaming a non-current and the current branch plus
// the missing/existing error paths.
func TestBranchRename(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	gitRun(t, dir, "branch", "feature")
	head := gitRun(t, dir, "rev-parse", "HEAD")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	b, err := a.BranchRename(ctx, repoID, "feature", "topic")
	if err != nil {
		t.Fatalf("BranchRename: %v", err)
	}
	if b.Name != "topic" || b.RefName.Raw != "refs/heads/topic" || b.IsCurrent {
		t.Errorf("renamed = %+v, want non-current topic", b)
	}
	if b.Tip.Hex != head {
		t.Errorf("tip = %s, want %s", b.Tip.Hex, head)
	}
	if got := gitRun(t, dir, "for-each-ref", "--format=%(refname:short)", "refs/heads/feature"); got != "" {
		t.Errorf("old branch still present: %q", got)
	}

	// Renaming the current branch keeps IsCurrent true.
	b2, err := a.BranchRename(ctx, repoID, "main", "primary")
	if err != nil {
		t.Fatalf("BranchRename(current): %v", err)
	}
	if !b2.IsCurrent {
		t.Errorf("renamed current IsCurrent = false, want true")
	}
	if got := gitRun(t, dir, "symbolic-ref", "--short", "HEAD"); got != "primary" {
		t.Errorf("HEAD = %q, want primary", got)
	}

	// Missing source.
	_, err = a.BranchRename(ctx, repoID, "nope", "x")
	assertAppCode(t, err, domain.ErrCodeBranchNotFound)

	// Existing target.
	_, err = a.BranchRename(ctx, repoID, "topic", "primary")
	assertAppCode(t, err, domain.ErrCodeBranchExists)
}

// TestBranchDelete covers deleting a merged branch, the unmerged refusal
// without force, the forced delete, and the missing-branch path.
func TestBranchDelete(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	gitRun(t, dir, "branch", "merged")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	if err := a.BranchDelete(ctx, repoID, domain.RefName{Raw: "merged"}, false); err != nil {
		t.Fatalf("BranchDelete(merged): %v", err)
	}
	if got := gitRun(t, dir, "for-each-ref", "--format=%(refname:short)", "refs/heads/merged"); got != "" {
		t.Errorf("merged branch still present: %q", got)
	}

	// Unmerged branch: -d refuses, -D forces.
	gitRun(t, dir, "checkout", "-q", "-b", "wip")
	writeFile(t, dir+"/c.txt", "three\n")
	gitRun(t, dir, "add", "c.txt")
	gitRun(t, dir, "commit", "-q", "-m", "wip commit")
	gitRun(t, dir, "checkout", "-q", "main")

	err := a.BranchDelete(ctx, repoID, domain.RefName{Raw: "wip"}, false)
	if err == nil {
		t.Fatal("BranchDelete(unmerged) succeeded, want error")
	}
	assertAppCode(t, err, domain.ErrCodeBranchNotFound)

	if err := a.BranchDelete(ctx, repoID, domain.RefName{Raw: "refs/heads/wip"}, true); err != nil {
		t.Fatalf("BranchDelete(unmerged, force): %v", err)
	}
	if got := gitRun(t, dir, "for-each-ref", "--format=%(refname:short)", "refs/heads/wip"); got != "" {
		t.Errorf("wip branch still present after force delete: %q", got)
	}

	// Missing branch.
	err = a.BranchDelete(ctx, repoID, domain.RefName{Raw: "ghost"}, true)
	assertAppCode(t, err, domain.ErrCodeBranchNotFound)
}

// TestBranchDeleteCurrent covers the refusal to delete the branch that is
// currently checked out: git refuses even with force (-D), and the adapter
// surfaces it as the generic BRANCH_NOT_FOUND carrying the git refusal summary.
func TestBranchDeleteCurrent(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	// Deleting the checked-out branch is refused by git even with force.
	err := a.BranchDelete(ctx, repoID, domain.RefName{Raw: "main"}, true)
	if err == nil {
		t.Fatal("BranchDelete(current, force) succeeded, want error")
	}
	assertAppCode(t, err, domain.ErrCodeBranchNotFound)

	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want typed AppError", err)
	}
	if appErr.Message == "" {
		t.Errorf("AppError.Message is empty, want the git refusal summary")
	}

	// The checked-out branch must survive the refused delete.
	if got := gitRun(t, dir, "symbolic-ref", "--short", "HEAD"); got != "main" {
		t.Errorf("HEAD = %q, want main", got)
	}
	if got := gitRun(t, dir, "for-each-ref", "--format=%(refname:short)", "refs/heads/main"); got != "main" {
		t.Errorf("current branch gone after refused delete: %q", got)
	}
}
