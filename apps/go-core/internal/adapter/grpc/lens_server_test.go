package grpc_test

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	googlegrpc "google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	singularitreev1 "github.com/SingulariTree/go-core/gen/go/singularitree/v1"
)

// initLensRepo builds a repository where main and feature diverge from a shared
// base (HEAD is main):
//
//	base
//	├─ main1    (main, HEAD)
//	└─ feature1 (feature)
func initLensRepo(t *testing.T) (dir, base, mainTip, featureTip string) {
	t.Helper()
	pinNoAutocrlf(t)
	dir = canonicalTempDir(t)
	gitRun(t, dir, "init", "-q")
	gitRun(t, dir, "config", "user.email", "alice@example.com")
	gitRun(t, dir, "config", "user.name", "Alice")
	gitRun(t, dir, "config", "commit.gpgsign", "false")
	gitRun(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")

	commitFile := func(name, content, msg string) string {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		gitRun(t, dir, "add", name)
		gitRun(t, dir, "commit", "-q", "-m", msg)
		return gitRun(t, dir, "rev-parse", "HEAD")
	}

	base = commitFile("base.txt", "base\n", "base")
	gitRun(t, dir, "checkout", "-q", "-b", "feature")
	featureTip = commitFile("feature.txt", "feature\n", "feature1")
	gitRun(t, dir, "checkout", "-q", "main")
	mainTip = commitFile("main.txt", "main\n", "main1")
	return dir, base, mainTip, featureTip
}

// TestGetCommitsBranchLens proves the RPC passes refs through and returns
// in_refs as a parallel membership array for the lensed union, while an
// un-lensed request leaves in_refs empty.
func TestGetCommitsBranchLens(t *testing.T) {
	addr := startServer(t)
	dir, base, mainTip, featureTip := initLensRepo(t)

	conn, err := googlegrpc.NewClient(addr, googlegrpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer conn.Close()
	client := singularitreev1.NewGitCoreClient(conn)
	ctx := authed(context.Background())

	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: dir})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}

	wantTotal := gitRun(t, dir, "rev-list", "--count", "main", "feature")

	resp, err := client.GetCommits(ctx, &singularitreev1.GetCommitsRequest{
		RepoId: repo.GetId(),
		Limit:  10,
		Refs:   []string{"feature"},
	})
	if err != nil {
		t.Fatalf("GetCommits(lensed): %v", err)
	}
	if resp.GetTotal() != 3 {
		t.Errorf("lensed total = %d, want 3 (rev-list count main feature = %s)", resp.GetTotal(), wantTotal)
	}
	if got, want := strconv.FormatUint(uint64(resp.GetTotal()), 10), wantTotal; got != want {
		t.Errorf("lensed total = %s, want the live rev-list count %s for main feature", got, want)
	}
	commits := resp.GetCommits()
	if len(commits) != 3 {
		t.Fatalf("lensed commits len = %d, want 3 (union HEAD u feature)", len(commits))
	}
	if len(resp.GetInRefs()) != len(commits) {
		t.Fatalf("in_refs len = %d, want %d (parallel to commits)", len(resp.GetInRefs()), len(commits))
	}
	if len(resp.GetLanes()) != len(commits) {
		t.Fatalf("lanes len = %d, want %d (parallel to commits)", len(resp.GetLanes()), len(commits))
	}

	listed := make(map[string]bool, len(commits))
	membership := make(map[string]bool, len(commits))
	for i, c := range commits {
		oid := c.GetOid().GetHex()
		listed[oid] = true
		membership[oid] = resp.GetInRefs()[i]
	}
	for _, want := range []string{mainTip, featureTip, base} {
		if !listed[want] {
			t.Errorf("lensed window is missing %s", want)
		}
	}
	if !membership[featureTip] {
		t.Errorf("in_refs[%s] = false, want true (feature tip reachable from feature)", featureTip)
	}
	if !membership[base] {
		t.Errorf("in_refs[%s] = false, want true (shared base reachable from feature)", base)
	}
	if membership[mainTip] {
		t.Errorf("in_refs[%s] = true, want false (main-only commit)", mainTip)
	}

	// A lensed scroll window still reports membership aligned with its rows.
	page, err := client.GetCommits(ctx, &singularitreev1.GetCommitsRequest{
		RepoId: repo.GetId(),
		Offset: 1,
		Limit:  1,
		Refs:   []string{"feature"},
	})
	if err != nil {
		t.Fatalf("GetCommits(lensed page): %v", err)
	}
	if len(page.GetCommits()) != 1 || len(page.GetInRefs()) != 1 {
		t.Fatalf("lensed page = (%d commits, %d in_refs), want (1, 1)",
			len(page.GetCommits()), len(page.GetInRefs()))
	}
	pageOid := page.GetCommits()[0].GetOid().GetHex()
	if page.GetInRefs()[0] != membership[pageOid] {
		t.Errorf("page in_refs[0] = %v for %s, want %v", page.GetInRefs()[0], pageOid, membership[pageOid])
	}

	// With no refs the contract leaves in_refs empty (shorter than commits).
	plain, err := client.GetCommits(ctx, &singularitreev1.GetCommitsRequest{
		RepoId: repo.GetId(),
		Limit:  10,
	})
	if err != nil {
		t.Fatalf("GetCommits(un-lensed): %v", err)
	}
	if len(plain.GetInRefs()) != 0 {
		t.Errorf("un-lensed in_refs = %v, want empty", plain.GetInRefs())
	}
	if plain.GetTotal() != 2 || len(plain.GetCommits()) != 2 {
		t.Errorf("un-lensed = (%d commits, total %d), want (2, 2)",
			len(plain.GetCommits()), plain.GetTotal())
	}
}
