package grpc_test

import (
	"context"
	"testing"

	googlegrpc "google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	singularitreev1 "github.com/SingulariTree/go-core/gen/go/singularitree/v1"
	"github.com/SingulariTree/go-core/internal/domain"
)

// TestStageHunkDispatches proves the hunk RPCs reach the Git port.
func TestStageHunkDispatches(t *testing.T) {
	port := &fakeGitPort{}
	client, closeConn := newGitCoreClient(t, startGitServer(t, port))
	defer closeConn()

	if _, err := client.StageHunk(authed(context.Background()), &singularitreev1.StageHunkRequest{
		RepoId: "repo-1", Path: "a.txt", HunkIndex: 2, LineIndices: []uint32{1, 3},
	}); err != nil {
		t.Fatalf("StageHunk: %v", err)
	}
	if _, err := client.UnstageHunk(authed(context.Background()), &singularitreev1.UnstageHunkRequest{
		RepoId: "repo-1", Path: "a.txt", HunkIndex: 0,
	}); err != nil {
		t.Fatalf("UnstageHunk: %v", err)
	}
	if _, err := client.DiscardHunk(authed(context.Background()), &singularitreev1.DiscardHunkRequest{
		RepoId: "repo-1", Path: "a.txt", HunkIndex: 0,
	}); err != nil {
		t.Fatalf("DiscardHunk: %v", err)
	}
	if port.stageHunkCalls != 1 || port.unstageHunkCalls != 1 || port.discardHunkCalls != 1 {
		t.Errorf("hunk calls = %d/%d/%d, want 1/1/1", port.stageHunkCalls, port.unstageHunkCalls, port.discardHunkCalls)
	}
}

// TestDiscardDispatches proves the file-level discard forwards its path list.
func TestDiscardDispatches(t *testing.T) {
	port := &fakeGitPort{}
	client, closeConn := newGitCoreClient(t, startGitServer(t, port))
	defer closeConn()

	if _, err := client.Discard(authed(context.Background()), &singularitreev1.DiscardRequest{
		RepoId: "repo-1", Paths: []string{"a.txt", "untracked.txt"},
	}); err != nil {
		t.Fatalf("Discard: %v", err)
	}
	if len(port.discardPaths) != 2 || port.discardPaths[0] != "a.txt" {
		t.Errorf("discardPaths = %v, want [a.txt untracked.txt]", port.discardPaths)
	}
}

// TestResetMapsMode proves the wire ResetMode maps to the domain mode and that
// the unspecified mode is rejected as InvalidArgument without calling git.
func TestResetMapsMode(t *testing.T) {
	cases := []struct {
		mode singularitreev1.ResetMode
		want domain.ResetMode
	}{
		{singularitreev1.ResetMode_SOFT, domain.ResetModeSoft},
		{singularitreev1.ResetMode_MIXED, domain.ResetModeMixed},
		{singularitreev1.ResetMode_HARD, domain.ResetModeHard},
	}
	for _, tc := range cases {
		port := &fakeGitPort{}
		client, closeConn := newGitCoreClient(t, startGitServer(t, port))
		if _, err := client.Reset(authed(context.Background()), &singularitreev1.ResetRequest{
			RepoId: "repo-1", To: "HEAD~1", Mode: tc.mode,
		}); err != nil {
			closeConn()
			t.Fatalf("Reset(%v): %v", tc.mode, err)
		}
		closeConn()
		if port.resetCalls != 1 || port.resetMode != tc.want {
			t.Errorf("Reset(%v): mode = %v, want %v", tc.mode, port.resetMode, tc.want)
		}
	}

	// Unspecified is rejected.
	port := &fakeGitPort{}
	client, closeConn := newGitCoreClient(t, startGitServer(t, port))
	defer closeConn()
	var trailer metadata.MD
	_, err := client.Reset(authed(context.Background()), &singularitreev1.ResetRequest{
		RepoId: "repo-1", To: "HEAD~1", Mode: singularitreev1.ResetMode_RESET_MODE_UNSPECIFIED,
	}, googlegrpc.Trailer(&trailer))
	if err == nil {
		t.Fatal("Reset(unspecified) succeeded, want error")
	}
	if status.Code(err) != codes.InvalidArgument {
		t.Errorf("status code = %v, want InvalidArgument", status.Code(err))
	}
	if got := trailer.Get("x-app-error-code"); len(got) == 0 || got[0] != domain.ErrCodeResetFailed {
		t.Errorf("trailer code = %v, want [%s]", got, domain.ErrCodeResetFailed)
	}
	if port.resetCalls != 0 {
		t.Errorf("git reset called %d times, want 0", port.resetCalls)
	}
}

// TestGetCommitStatsMaps proves the stats RPC forwards oids and maps the results.
func TestGetCommitStatsMaps(t *testing.T) {
	port := &fakeGitPort{commitStatsResult: []domain.CommitStats{
		{Oid: "aaaa", Additions: 1, Deletions: 2, FilesChanged: 3},
		{Oid: "bbbb", Additions: 4, Deletions: 5, FilesChanged: 6},
	}}
	client, closeConn := newGitCoreClient(t, startGitServer(t, port))
	defer closeConn()

	resp, err := client.GetCommitStats(authed(context.Background()), &singularitreev1.GetCommitStatsRequest{
		RepoId: "repo-1", Oids: []string{"aaaa", "bbbb"},
	})
	if err != nil {
		t.Fatalf("GetCommitStats: %v", err)
	}
	stats := resp.GetStats()
	if len(stats) != 2 {
		t.Fatalf("len(stats) = %d, want 2", len(stats))
	}
	if stats[0].GetOid() != "aaaa" || stats[0].GetAdditions() != 1 || stats[0].GetFilesChanged() != 3 {
		t.Errorf("stats[0] = %+v, want aaaa +1 -2 files 3", stats[0])
	}
	if len(port.gotStatsOids) != 2 || port.gotStatsOids[1] != "bbbb" {
		t.Errorf("forwarded oids = %v, want [aaaa bbbb]", port.gotStatsOids)
	}
}
