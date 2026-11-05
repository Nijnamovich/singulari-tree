package grpc_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	googlegrpc "google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	singularitreev1 "github.com/SingulariTree/go-core/gen/go/singularitree/v1"
)

// writeFixture writes a file into a fixture repository.
func writeFixture(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

// TestBranchCRUDRPCs covers CreateBranch / RenameBranch / DeleteBranch through
// the real gRPC stack (ADR-028).
func TestBranchCRUDRPCs(t *testing.T) {
	addr := startServer(t)
	fixture := initFixtureRepo(t)
	gitRun(t, fixture, "branch", "-M", "main")

	client, closeConn := newGitCoreClient(t, addr)
	defer closeConn()
	ctx := authed(context.Background())

	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}
	repoID := repo.GetId()

	created, err := client.CreateBranch(ctx, &singularitreev1.CreateBranchRequest{
		RepoId: repoID, Name: "feature/login", StartPoint: "main", Checkout: false,
	})
	if err != nil {
		t.Fatalf("CreateBranch: %v", err)
	}
	if created.GetName() != "feature/login" || created.GetRefName() != "refs/heads/feature/login" {
		t.Errorf("created = %+v", created)
	}
	if created.GetIsCurrent() {
		t.Errorf("created.IsCurrent = true, want false")
	}

	// Collision maps to AlreadyExists.
	_, err = client.CreateBranch(ctx, &singularitreev1.CreateBranchRequest{RepoId: repoID, Name: "feature/login", StartPoint: "main"})
	if status.Code(err) != codes.AlreadyExists {
		t.Errorf("CreateBranch(duplicate) code = %v, want AlreadyExists", status.Code(err))
	}

	renamed, err := client.RenameBranch(ctx, &singularitreev1.RenameBranchRequest{
		RepoId: repoID, OldName: "feature/login", NewName: "feature/auth",
	})
	if err != nil {
		t.Fatalf("RenameBranch: %v", err)
	}
	if renamed.GetName() != "feature/auth" {
		t.Errorf("renamed = %+v", renamed)
	}

	if _, err := client.DeleteBranch(ctx, &singularitreev1.DeleteBranchRequest{RepoId: repoID, Name: "feature/auth"}); err != nil {
		t.Fatalf("DeleteBranch: %v", err)
	}
	branches, err := client.GetBranches(ctx, &singularitreev1.GetBranchesRequest{RepoId: repoID})
	if err != nil {
		t.Fatalf("GetBranches: %v", err)
	}
	for _, b := range branches.GetBranches() {
		if b.GetName() == "feature/auth" {
			t.Fatalf("deleted branch still listed")
		}
	}

	// Missing branch maps to NotFound.
	if _, err := client.DeleteBranch(ctx, &singularitreev1.DeleteBranchRequest{RepoId: repoID, Name: "ghost"}); status.Code(err) != codes.NotFound {
		t.Errorf("DeleteBranch(missing) code = %v, want NotFound", status.Code(err))
	}
}

// TestTagCRUDRPCs covers CreateTag / DeleteTag and GetTags (ADR-028).
func TestTagCRUDRPCs(t *testing.T) {
	addr := startServer(t)
	fixture := initFixtureRepo(t)
	gitRun(t, fixture, "branch", "-M", "main")
	head := gitRun(t, fixture, "rev-parse", "HEAD")

	client, closeConn := newGitCoreClient(t, addr)
	defer closeConn()
	ctx := authed(context.Background())

	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}
	repoID := repo.GetId()

	ann, err := client.CreateTag(ctx, &singularitreev1.CreateTagRequest{
		RepoId: repoID, Name: "v1.0", Annotated: true, Message: "release one",
	})
	if err != nil {
		t.Fatalf("CreateTag: %v", err)
	}
	if !ann.GetAnnotated() || ann.GetTarget().GetHex() != head || ann.GetMessage() != "release one" {
		t.Errorf("created tag = %+v", ann)
	}

	// Duplicate annotates the collision as FailedPrecondition (TAG_EXISTS).
	_, err = client.CreateTag(ctx, &singularitreev1.CreateTagRequest{RepoId: repoID, Name: "v1.0"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Errorf("CreateTag(duplicate) code = %v, want FailedPrecondition", status.Code(err))
	}

	tags, err := client.GetTags(ctx, &singularitreev1.GetTagsRequest{RepoId: repoID})
	if err != nil {
		t.Fatalf("GetTags: %v", err)
	}
	if len(tags.GetTags()) != 1 {
		t.Fatalf("tags len = %d, want 1", len(tags.GetTags()))
	}

	if _, err := client.DeleteTag(ctx, &singularitreev1.DeleteTagRequest{RepoId: repoID, Name: "v1.0"}); err != nil {
		t.Fatalf("DeleteTag: %v", err)
	}
	if _, err := client.DeleteTag(ctx, &singularitreev1.DeleteTagRequest{RepoId: repoID, Name: "v1.0"}); status.Code(err) != codes.NotFound {
		t.Errorf("DeleteTag(missing) code = %v, want NotFound", status.Code(err))
	}
}

// TestMergeRPCs covers a clean merge, a conflict surfaced as data with the
// MERGE_CONFLICT trailer, and the unspecified-strategy rejection.
func TestMergeRPCs(t *testing.T) {
	addr := startServer(t)
	fixture := initFixtureRepo(t)
	gitRun(t, fixture, "branch", "-M", "main")

	client, closeConn := newGitCoreClient(t, addr)
	defer closeConn()
	ctx := authed(context.Background())

	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}
	repoID := repo.GetId()

	// Clean fast-forward merge.
	gitRun(t, fixture, "checkout", "-q", "-b", "feature")
	writeFixture(t, fixture, "c.txt", "three\n")
	gitRun(t, fixture, "add", "c.txt")
	gitRun(t, fixture, "commit", "-q", "-m", "feature commit")
	gitRun(t, fixture, "checkout", "-q", "main")

	clean, err := client.Merge(ctx, &singularitreev1.MergeRequest{
		RepoId: repoID, Ref: "feature", Strategy: singularitreev1.MergeStrategy_MERGE,
	})
	if err != nil {
		t.Fatalf("Merge(clean): %v", err)
	}
	if clean.GetHasConflict() {
		t.Errorf("clean.HasConflict = true, want false")
	}
	if clean.GetOid() == "" {
		t.Errorf("clean.Oid is empty, want the resulting HEAD")
	}

	// Build a conflicting divergence.
	gitRun(t, fixture, "checkout", "-q", "-b", "other")
	writeFixture(t, fixture, "a.txt", "other\n")
	gitRun(t, fixture, "add", "a.txt")
	gitRun(t, fixture, "commit", "-q", "-m", "other change")
	gitRun(t, fixture, "checkout", "-q", "main")
	writeFixture(t, fixture, "a.txt", "main\n")
	gitRun(t, fixture, "add", "a.txt")
	gitRun(t, fixture, "commit", "-q", "-m", "main change")

	var trailer metadata.MD
	conflict, err := client.Merge(
		ctx,
		&singularitreev1.MergeRequest{RepoId: repoID, Ref: "other", Strategy: singularitreev1.MergeStrategy_MERGE},
		googlegrpc.Trailer(&trailer),
	)
	if err != nil {
		t.Fatalf("Merge(conflict): %v", err)
	}
	if !conflict.GetHasConflict() {
		t.Errorf("conflict.HasConflict = false, want true")
	}
	if got := trailer.Get("x-app-error-code"); len(got) == 0 || got[0] != "MERGE_CONFLICT" {
		t.Errorf("trailer x-app-error-code = %v, want [MERGE_CONFLICT]", got)
	}

	// The conflicted tree is visible through GetStatus.
	statusResp, err := client.GetStatus(ctx, &singularitreev1.GetStatusRequest{RepoId: repoID})
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	var conflicted bool
	for _, f := range statusResp.GetFiles() {
		if f.GetIsConflicted() {
			conflicted = true
		}
	}
	if !conflicted {
		t.Errorf("GetStatus = %+v, want a conflicted entry", statusResp.GetFiles())
	}

	// Unspecified strategy is rejected (MERGE_FAILED -> Aborted).
	_, err = client.Merge(ctx, &singularitreev1.MergeRequest{RepoId: repoID, Ref: "other"})
	if status.Code(err) != codes.Aborted {
		t.Errorf("Merge(unspecified) code = %v, want Aborted", status.Code(err))
	}
}

// TestStashRPCs covers GetStashes / StashApply / StashDrop / StashPop (ADR-028).
func TestStashRPCs(t *testing.T) {
	addr := startServer(t)
	fixture := initFixtureRepo(t)
	gitRun(t, fixture, "branch", "-M", "main")
	writeFixture(t, fixture, "a.txt", "modified\n")
	gitRun(t, fixture, "stash", "push", "-m", "wip")

	client, closeConn := newGitCoreClient(t, addr)
	defer closeConn()
	ctx := authed(context.Background())

	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}
	repoID := repo.GetId()

	stashes, err := client.GetStashes(ctx, &singularitreev1.GetStashesRequest{RepoId: repoID})
	if err != nil {
		t.Fatalf("GetStashes: %v", err)
	}
	if len(stashes.GetStashes()) != 1 {
		t.Fatalf("stashes len = %d, want 1 (%+v)", len(stashes.GetStashes()), stashes.GetStashes())
	}
	if st := stashes.GetStashes()[0]; st.GetIndex() != 0 || st.GetMessage() != "wip" || st.GetOid().GetHex() == "" {
		t.Errorf("stash = %+v", st)
	}

	if _, err := client.StashApply(ctx, &singularitreev1.StashApplyRequest{RepoId: repoID, Index: 0}); err != nil {
		t.Fatalf("StashApply: %v", err)
	}
	if got := readFixture(t, filepath.Join(fixture, "a.txt")); got != "modified\n" {
		t.Errorf("a.txt = %q, want restored", got)
	}

	if _, err := client.StashDrop(ctx, &singularitreev1.StashDropRequest{RepoId: repoID, Index: 0}); err != nil {
		t.Fatalf("StashDrop: %v", err)
	}
	stashes, _ = client.GetStashes(ctx, &singularitreev1.GetStashesRequest{RepoId: repoID})
	if len(stashes.GetStashes()) != 0 {
		t.Errorf("after drop len = %d, want 0", len(stashes.GetStashes()))
	}

	// Popping an absent entry is STASH_FAILED (InvalidArgument).
	if _, err := client.StashPop(ctx, &singularitreev1.StashPopRequest{RepoId: repoID, Index: 0}); status.Code(err) != codes.InvalidArgument {
		t.Errorf("StashPop(empty) code = %v, want InvalidArgument", status.Code(err))
	}
}

func readFixture(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}
