package grpc_test

import (
	"context"
	"path/filepath"
	"testing"

	googlegrpc "google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	singularitreev1 "github.com/SingulariTree/go-core/gen/go/singularitree/v1"
)

// TestCherryPickRPCs covers a clean pick, a conflict surfaced as data with the
// CHERRY_PICK_CONFLICT trailer, and a non-conflict failure (busy sequencer)
// mapped to Aborted.
func TestCherryPickRPCs(t *testing.T) {
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

	// Clean pick from a feature branch.
	gitRun(t, fixture, "checkout", "-q", "-b", "feature")
	writeFixture(t, fixture, "c.txt", "three\n")
	gitRun(t, fixture, "add", "c.txt")
	gitRun(t, fixture, "commit", "-q", "-m", "feature commit")
	gitRun(t, fixture, "checkout", "-q", "main")

	clean, err := client.CherryPick(ctx, &singularitreev1.CherryPickRequest{
		RepoId: repoID, Source: "feature", RecordOrigin: true,
	})
	if err != nil {
		t.Fatalf("CherryPick(clean): %v", err)
	}
	if clean.GetHasConflict() {
		t.Errorf("clean.HasConflict = true, want false")
	}
	if clean.GetOid() == "" || clean.GetOid() != gitRun(t, fixture, "rev-parse", "HEAD") {
		t.Errorf("clean.Oid = %q, want HEAD", clean.GetOid())
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
	conflict, err := client.CherryPick(
		ctx,
		&singularitreev1.CherryPickRequest{RepoId: repoID, Source: "other"},
		googlegrpc.Trailer(&trailer),
	)
	if err != nil {
		t.Fatalf("CherryPick(conflict): %v", err)
	}
	if !conflict.GetHasConflict() {
		t.Errorf("conflict.HasConflict = false, want true")
	}
	if got := trailer.Get("x-app-error-code"); len(got) == 0 || got[0] != "CHERRY_PICK_CONFLICT" {
		t.Errorf("trailer x-app-error-code = %v, want [CHERRY_PICK_CONFLICT]", got)
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

	// Another pick while the sequencer is armed fails (CHERRY_PICK_FAILED ->
	// Aborted), not as a conflict.
	var failTrailer metadata.MD
	_, err = client.CherryPick(
		ctx,
		&singularitreev1.CherryPickRequest{RepoId: repoID, Source: "HEAD~1"},
		googlegrpc.Trailer(&failTrailer),
	)
	if status.Code(err) != codes.Aborted {
		t.Errorf("CherryPick(busy) code = %v, want Aborted", status.Code(err))
	}
	if got := failTrailer.Get("x-app-error-code"); len(got) == 0 || got[0] != "CHERRY_PICK_FAILED" {
		t.Errorf("trailer x-app-error-code = %v, want [CHERRY_PICK_FAILED]", got)
	}
}

// TestRevertRPCs covers a clean revert plus the conflict-as-data path with the
// REVERT_CONFLICT trailer.
func TestRevertRPCs(t *testing.T) {
	addr := startServer(t)
	client, closeConn := newGitCoreClient(t, addr)
	defer closeConn()
	ctx := authed(context.Background())

	t.Run("clean", func(t *testing.T) {
		fixture := initFixtureRepo(t)
		gitRun(t, fixture, "branch", "-M", "main")
		writeFixture(t, fixture, "a.txt", "changed\n")
		gitRun(t, fixture, "add", "a.txt")
		gitRun(t, fixture, "commit", "-q", "-m", "change a")
		target := gitRun(t, fixture, "rev-parse", "HEAD")

		repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
		if err != nil {
			t.Fatalf("OpenRepository: %v", err)
		}
		res, err := client.Revert(ctx, &singularitreev1.RevertRequest{RepoId: repo.GetId(), Source: target})
		if err != nil {
			t.Fatalf("Revert: %v", err)
		}
		if res.GetHasConflict() {
			t.Errorf("HasConflict = true, want false")
		}
		if res.GetOid() != gitRun(t, fixture, "rev-parse", "HEAD") {
			t.Errorf("Oid = %q, want the new HEAD", res.GetOid())
		}
		if got := readFixture(t, filepath.Join(fixture, "a.txt")); got != "one\n" {
			t.Errorf("a.txt = %q, want the pre-change content", got)
		}
	})

	t.Run("conflict", func(t *testing.T) {
		fixture := initFixtureRepo(t)
		gitRun(t, fixture, "branch", "-M", "main")
		writeFixture(t, fixture, "a.txt", "two\n")
		gitRun(t, fixture, "add", "a.txt")
		gitRun(t, fixture, "commit", "-q", "-m", "second")
		second := gitRun(t, fixture, "rev-parse", "HEAD")
		writeFixture(t, fixture, "a.txt", "three\n")
		gitRun(t, fixture, "add", "a.txt")
		gitRun(t, fixture, "commit", "-q", "-m", "third")

		repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
		if err != nil {
			t.Fatalf("OpenRepository: %v", err)
		}
		var trailer metadata.MD
		res, err := client.Revert(
			ctx,
			&singularitreev1.RevertRequest{RepoId: repo.GetId(), Source: second},
			googlegrpc.Trailer(&trailer),
		)
		if err != nil {
			t.Fatalf("Revert(conflict): %v", err)
		}
		if !res.GetHasConflict() {
			t.Errorf("HasConflict = false, want true")
		}
		if got := trailer.Get("x-app-error-code"); len(got) == 0 || got[0] != "REVERT_CONFLICT" {
			t.Errorf("trailer x-app-error-code = %v, want [REVERT_CONFLICT]", got)
		}
	})
}

// TestResolveRevisionRPC covers revision resolution (full/short sha, branch,
// tag) plus the NotFound/InvalidArgument rejections.
func TestResolveRevisionRPC(t *testing.T) {
	addr := startServer(t)
	fixture := initFixtureRepo(t)
	gitRun(t, fixture, "branch", "-M", "main")
	full := gitRun(t, fixture, "rev-parse", "HEAD")
	short := gitRun(t, fixture, "rev-parse", "--short=8", "HEAD")
	parent := gitRun(t, fixture, "rev-parse", "HEAD~1")
	gitRun(t, fixture, "branch", "feature", "HEAD~1")
	gitRun(t, fixture, "tag", "v1", "HEAD~1")

	client, closeConn := newGitCoreClient(t, addr)
	defer closeConn()
	ctx := authed(context.Background())

	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}
	repoID := repo.GetId()

	cases := []struct{ revision, want string }{
		{"HEAD", full},
		{full, full},
		{short, full},
		{"main", full},
		{"feature", parent},
		{"v1", parent},
	}
	for _, tc := range cases {
		commit, err := client.ResolveRevision(ctx, &singularitreev1.ResolveRevisionRequest{RepoId: repoID, Revision: tc.revision})
		if err != nil {
			t.Errorf("ResolveRevision(%q): %v", tc.revision, err)
			continue
		}
		if commit.GetOid().GetHex() != tc.want {
			t.Errorf("ResolveRevision(%q) = %q, want %q", tc.revision, commit.GetOid().GetHex(), tc.want)
		}
	}

	if _, err := client.ResolveRevision(ctx, &singularitreev1.ResolveRevisionRequest{RepoId: repoID, Revision: "no-such-rev"}); status.Code(err) != codes.NotFound {
		t.Errorf("ResolveRevision(missing) code = %v, want NotFound", status.Code(err))
	}
	if _, err := client.ResolveRevision(ctx, &singularitreev1.ResolveRevisionRequest{RepoId: repoID, Revision: "-oops"}); status.Code(err) != codes.InvalidArgument {
		t.Errorf("ResolveRevision(invalid) code = %v, want InvalidArgument", status.Code(err))
	}
}
