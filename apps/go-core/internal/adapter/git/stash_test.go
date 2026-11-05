package git

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// TestStashPushDirtyTree proves StashPush saves tracked modifications into a
// new stash entry (with the caller's message) and leaves the working tree
// clean afterwards.
func TestStashPushDirtyTree(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	writeFile(t, filepath.Join(dir, "a.txt"), "modified\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	st, err := a.StashPush(context.Background(), domain.RepositoryId("repo-1"), "wip")
	if err != nil {
		t.Fatalf("StashPush: %v", err)
	}
	if st == nil {
		t.Fatal("StashPush returned nil stash")
	}
	if st.Oid.Hex == "" {
		t.Error("stash Oid.Hex is empty, want the resolved refs/stash oid")
	}
	if st.Message != "wip" {
		t.Errorf("stash Message = %q, want wip", st.Message)
	}
	if st.BranchName == nil || *st.BranchName != "main" {
		t.Errorf("stash BranchName = %v, want main", st.BranchName)
	}
	if got := gitRun(t, dir, "status", "--porcelain"); got != "" {
		t.Fatalf("working tree not clean after StashPush: %q", got)
	}
}

// TestStashPushDefaultMessage proves an empty message falls back to the
// built-in default rather than passing an empty -m value.
func TestStashPushDefaultMessage(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	writeFile(t, filepath.Join(dir, "a.txt"), "modified\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	st, err := a.StashPush(context.Background(), domain.RepositoryId("repo-1"), "   ")
	if err != nil {
		t.Fatalf("StashPush: %v", err)
	}
	if st.Message != defaultStashMessage {
		t.Errorf("stash Message = %q, want default %q", st.Message, defaultStashMessage)
	}
}

// TestStashPushCleanTreeFails proves a clean working tree yields a typed
// STASH_FAILED instead of silently resolving a stale refs/stash entry.
func TestStashPushCleanTreeFails(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	if _, err := a.StashPush(context.Background(), domain.RepositoryId("repo-1"), "wip"); err == nil {
		t.Fatal("StashPush on a clean tree succeeded, want STASH_FAILED")
	} else {
		assertAppCode(t, err, domain.ErrCodeStashFailed)
	}
}
