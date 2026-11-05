package git

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// TestParseStashList is a pure-helper test for the `git stash list` parser.
func TestParseStashList(t *testing.T) {
	oid0 := strings.Repeat("a", 40)
	oid1 := strings.Repeat("b", 40)
	out := "stash@{0}" + unitSep + oid0 + unitSep + "On main: wip one\n" +
		"stash@{1}" + unitSep + oid1 + unitSep + "WIP on feature/x: deadbeef first commit\n"

	got := parseStashList(out)
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2 (%+v)", len(got), got)
	}
	if got[0].Index != 0 || got[0].Oid.Hex != oid0 || got[0].Message != "wip one" {
		t.Errorf("got[0] = %+v, want index 0/oid a*/message 'wip one'", got[0])
	}
	if got[0].BranchName == nil || *got[0].BranchName != "main" {
		t.Errorf("got[0].BranchName = %v, want main", got[0].BranchName)
	}
	if got[1].Index != 1 || got[1].Message != "deadbeef first commit" {
		t.Errorf("got[1] = %+v, want index 1/message 'deadbeef first commit'", got[1])
	}
	if got[1].BranchName == nil || *got[1].BranchName != "feature/x" {
		t.Errorf("got[1].BranchName = %v, want feature/x", got[1].BranchName)
	}
}

// TestStashLifecycle covers list -> apply (retain) -> pop (drop) end to end.
func TestStashLifecycle(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	writeFile(t, filepath.Join(dir, "a.txt"), "modified\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	if _, err := a.StashPush(ctx, repoID, "wip"); err != nil {
		t.Fatalf("StashPush: %v", err)
	}

	stashes, err := a.StashList(ctx, repoID)
	if err != nil {
		t.Fatalf("StashList: %v", err)
	}
	if len(stashes) != 1 {
		t.Fatalf("len(stashes) = %d, want 1 (%+v)", len(stashes), stashes)
	}
	if stashes[0].Index != 0 || stashes[0].Message != "wip" || stashes[0].Oid.Hex == "" {
		t.Errorf("stash = %+v, want index 0/message wip/non-empty oid", stashes[0])
	}
	if stashes[0].BranchName == nil || *stashes[0].BranchName != "main" {
		t.Errorf("BranchName = %v, want main", stashes[0].BranchName)
	}

	// Apply restores the working tree and retains the entry.
	if err := a.StashApply(ctx, repoID, 0, false); err != nil {
		t.Fatalf("StashApply: %v", err)
	}
	if got := readFile(t, filepath.Join(dir, "a.txt")); got != "modified\n" {
		t.Errorf("a.txt = %q, want restored modification", got)
	}
	if stashes, _ := a.StashList(ctx, repoID); len(stashes) != 1 {
		t.Errorf("after apply len = %d, want 1 (apply retains the stash)", len(stashes))
	}

	// Clean, then pop: restores and drops.
	if _, err := runGit(ctx, dir, "checkout", "--", "a.txt"); err != nil {
		t.Fatalf("checkout -- a.txt: %v", err)
	}
	if err := a.StashPop(ctx, repoID, 0); err != nil {
		t.Fatalf("StashPop: %v", err)
	}
	if got := readFile(t, filepath.Join(dir, "a.txt")); got != "modified\n" {
		t.Errorf("a.txt after pop = %q, want restored modification", got)
	}
	if stashes, _ := a.StashList(ctx, repoID); len(stashes) != 0 {
		t.Errorf("after pop len = %d, want 0", len(stashes))
	}
}

// TestStashApplyRestoreIndex proves restoreIndex maps to `git stash apply
// --index`.
func TestStashApplyRestoreIndex(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	writeFile(t, filepath.Join(dir, "a.txt"), "modified\n")
	gitRun(t, dir, "add", "a.txt")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	if _, err := a.StashPush(ctx, repoID, "staged wip"); err != nil {
		t.Fatalf("StashPush: %v", err)
	}
	if err := a.StashApply(ctx, repoID, 0, true); err != nil {
		t.Fatalf("StashApply(restoreIndex): %v", err)
	}
	// --index restores the staged state.
	if got := gitRun(t, dir, "diff", "--cached", "--name-only"); !strings.Contains(got, "a.txt") {
		t.Errorf("staged files = %q, want a.txt restored to the index", got)
	}
}

// TestStashDropAndOutOfRange covers dropping and the typed STASH_FAILED for an
// absent/out-of-range entry.
func TestStashDropAndOutOfRange(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	writeFile(t, filepath.Join(dir, "a.txt"), "modified\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	if _, err := a.StashPush(ctx, repoID, "wip"); err != nil {
		t.Fatalf("StashPush: %v", err)
	}
	if err := a.StashDrop(ctx, repoID, 0); err != nil {
		t.Fatalf("StashDrop: %v", err)
	}
	if stashes, _ := a.StashList(ctx, repoID); len(stashes) != 0 {
		t.Errorf("after drop len = %d, want 0", len(stashes))
	}

	err := a.StashDrop(ctx, repoID, 0)
	assertAppCode(t, err, domain.ErrCodeStashFailed)

	err = a.StashApply(ctx, repoID, 5, false)
	assertAppCode(t, err, domain.ErrCodeStashFailed)

	err = a.StashApply(ctx, repoID, -1, false)
	assertAppCode(t, err, domain.ErrCodeStashFailed)
}
