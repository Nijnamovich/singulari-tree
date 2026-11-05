package grpc_test

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	googlegrpc "google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	singularitreev1 "github.com/SingulariTree/go-core/gen/go/singularitree/v1"
	gitadapter "github.com/SingulariTree/go-core/internal/adapter/git"
	grpcadapter "github.com/SingulariTree/go-core/internal/adapter/grpc"
	"github.com/SingulariTree/go-core/internal/adapter/watcher"
	"github.com/SingulariTree/go-core/internal/repository"
	"github.com/SingulariTree/go-core/internal/service"
)

const testToken = "test-token-0123456789abcdef"

func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	// `-c core.autocrlf=false` is belt-and-braces on top of pinNoAutocrlf: it
	// pins line-ending policy for the fixture's own commands, while the env pin
	// is what reaches the adapter's subprocesses (which never see this argv).
	// Harmless and a no-op on Linux.
	full := append([]string{"-c", "core.autocrlf=false", "-C", dir}, args...)
	out, err := exec.Command("git", full...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// canonicalTempDir returns a fresh temp dir with symlinks resolved and, on
// Windows, 8.3 short names expanded to their on-disk long form. The GitHub
// Windows runner publishes TEMP in the 8.3 short form
// (C:\Users\RUNNER~1\AppData\Local\Temp), so t.TempDir() yields the short path
// while production persists the canonical long top-level it reads back from
// `git rev-parse --show-toplevel` (C:\Users\runneradmin\...). Canonicalising the
// fixture once, at the source, makes GetFsPath and the fixture comparable on
// Windows; it is a no-op on Linux.
//
// Mirrors commit 947c552, which applied the identical fix to the Electron e2e
// via fs.realpathSync.native (GetFinalPathNameByHandleW on Windows); the two
// fixes are deliberately linked.
func canonicalTempDir(t *testing.T) string {
	t.Helper()
	raw := t.TempDir()
	dir, err := filepath.EvalSymlinks(raw)
	if err != nil {
		t.Fatalf("EvalSymlinks(%s): %v", raw, err)
	}
	return dir
}

// pinNoAutocrlf forces LF line endings for every git process spawned by this
// test binary: fixture gitRun calls and, crucially, the adapter's own
// runGit/runGitAllowExit/streamGitProgress subprocesses.
//
// Git for Windows on the CI runner defaults to core.autocrlf=true, so a
// stash/checkout materialises CRLF bytes and TestStashRPCs reads back
// "modified\r\n" for a file it wrote as "modified\n".
//
// The pin MUST use git's environment-config form rather than a
// `-c core.autocrlf=false` argv flag on the fixture's gitRun: the bytes are
// produced by the *adapter's* subprocesses (internal/adapter/git/adapter.go),
// which build their env from os.Environ() and never see an argv flag passed to
// the fixture. Environment config is inherited by every git child instead,
// while leaving production code and the developer's own config untouched.
func pinNoAutocrlf(t *testing.T) {
	t.Helper()
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "core.autocrlf")
	t.Setenv("GIT_CONFIG_VALUE_0", "false")
}

// initFixtureRepo creates a real git repo with two commits.
func initFixtureRepo(t *testing.T) string {
	t.Helper()
	pinNoAutocrlf(t)
	dir := canonicalTempDir(t)
	gitRun(t, dir, "init", "-q")
	gitRun(t, dir, "config", "user.email", "alice@example.com")
	gitRun(t, dir, "config", "user.name", "Alice")
	gitRun(t, dir, "config", "commit.gpgsign", "false")

	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, dir, "add", "a.txt")
	gitRun(t, dir, "commit", "-q", "-m", "first commit")

	if err := os.WriteFile(filepath.Join(dir, "b.txt"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, dir, "add", "b.txt")
	gitRun(t, dir, "commit", "-q", "-m", "second commit")
	return dir
}

// initUnbornRepo creates a real git repo with no commits (unborn HEAD),
// mirroring initFixtureRepo's setup but skipping the commit step.
func initUnbornRepo(t *testing.T) string {
	t.Helper()
	pinNoAutocrlf(t)
	dir := canonicalTempDir(t)
	gitRun(t, dir, "init", "-q")
	gitRun(t, dir, "config", "user.email", "alice@example.com")
	gitRun(t, dir, "config", "user.name", "Alice")
	gitRun(t, dir, "config", "commit.gpgsign", "false")
	return dir
}

// startServer boots the real gRPC server on an ephemeral loopback port and
// returns the address. Everything is scoped to a temp SQLite DB.
func startServer(t *testing.T) string {
	t.Helper()
	ctx := context.Background()

	db, err := repository.OpenSQLite(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := repository.ApplyMigrations(ctx, db); err != nil {
		t.Fatalf("ApplyMigrations: %v", err)
	}

	repoStore := repository.NewRepoStore(db)
	gitAdapter := gitadapter.NewAdapter(repoStore)
	repoSvc := service.NewRepoService(repoStore, gitAdapter)
	commitCache := repository.NewCommitCache(db)
	cacheSvc := service.NewCacheServiceWithStore(10, commitCache)
	graphSvc := service.NewGraphService(gitAdapter, cacheSvc)
	// The watcher is not exercised by the unary/streaming RPCs here; a nil
	// resolver is the documented no-op (no filesystem watches attached).
	watcherSvc := service.NewWatcherService(watcher.NewFsnotifyAdapter(nil))
	gitSvc := service.NewGitService(gitAdapter, cacheSvc, watcherSvc)
	gitflowSvc := service.NewGitFlowService(gitAdapter, repository.NewGitFlowStore(db))

	grpcSrv := grpcadapter.NewServer(repoSvc, gitSvc, graphSvc, watcherSvc, cacheSvc, gitflowSvc, testToken)
	gs := googlegrpc.NewServer(
		googlegrpc.UnaryInterceptor(grpcadapter.UnaryAuthInterceptor(testToken)),
		googlegrpc.StreamInterceptor(grpcadapter.StreamAuthInterceptor(testToken)),
	)
	grpcSrv.Register(gs)

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() { _ = gs.Serve(lis) }()
	t.Cleanup(gs.Stop)

	return lis.Addr().String()
}

func authed(ctx context.Context) context.Context {
	return metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+testToken)
}

func TestPingRequiresToken(t *testing.T) {
	addr := startServer(t)
	conn, err := googlegrpc.NewClient(addr, googlegrpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer conn.Close()
	client := singularitreev1.NewGitCoreClient(conn)

	// No token → Unauthenticated.
	_, err = client.Ping(context.Background(), &singularitreev1.PingRequest{})
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("Ping without token code = %v, want Unauthenticated (err=%v)", status.Code(err), err)
	}

	// Wrong token → Unauthenticated.
	badCtx := metadata.AppendToOutgoingContext(context.Background(), "authorization", "Bearer wrong")
	_, err = client.Ping(badCtx, &singularitreev1.PingRequest{})
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("Ping with wrong token code = %v, want Unauthenticated", status.Code(err))
	}

	// Correct token → ok.
	resp, err := client.Ping(authed(context.Background()), &singularitreev1.PingRequest{})
	if err != nil {
		t.Fatalf("Ping with token: %v", err)
	}
	if !resp.GetOk() {
		t.Error("Ping ok = false, want true")
	}
	if resp.GetQueueDepth() != 0 {
		t.Errorf("QueueDepth = %d, want 0", resp.GetQueueDepth())
	}
}

func TestOpenRepositoryThenGetCommits(t *testing.T) {
	addr := startServer(t)
	fixture := initFixtureRepo(t)
	head := gitRun(t, fixture, "rev-parse", "HEAD")

	conn, err := googlegrpc.NewClient(addr, googlegrpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer conn.Close()
	client := singularitreev1.NewGitCoreClient(conn)
	ctx := authed(context.Background())

	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}
	if repo.GetId() == "" {
		t.Fatal("OpenRepository returned empty id")
	}
	if repo.GetFsPath() != fixture {
		t.Errorf("FsPath = %q, want %q", repo.GetFsPath(), fixture)
	}
	if repo.GetName() != filepath.Base(fixture) {
		t.Errorf("Name = %q, want %q", repo.GetName(), filepath.Base(fixture))
	}

	// GetRepository round-trips.
	got, err := client.GetRepository(ctx, &singularitreev1.GetRepositoryRequest{RepoId: repo.GetId()})
	if err != nil {
		t.Fatalf("GetRepository: %v", err)
	}
	if got.GetId() != repo.GetId() {
		t.Errorf("GetRepository id = %q, want %q", got.GetId(), repo.GetId())
	}

	// ListRepositories includes it.
	list, err := client.ListRepositories(ctx, &singularitreev1.ListRepositoriesRequest{})
	if err != nil {
		t.Fatalf("ListRepositories: %v", err)
	}
	if len(list.GetRepositories()) != 1 {
		t.Fatalf("ListRepositories len = %d, want 1", len(list.GetRepositories()))
	}

	// GetCommits returns the fixture commits with real field values.
	resp, err := client.GetCommits(ctx, &singularitreev1.GetCommitsRequest{
		RepoId: repo.GetId(),
		Offset: 0,
		Limit:  10,
	})
	if err != nil {
		t.Fatalf("GetCommits: %v", err)
	}
	if resp.GetTotal() != 2 {
		t.Errorf("total = %d, want 2", resp.GetTotal())
	}
	commits := resp.GetCommits()
	if len(commits) != 2 {
		t.Fatalf("commits len = %d, want 2", len(commits))
	}
	newest := commits[0]
	if newest.GetOid().GetHex() != head {
		t.Errorf("commits[0].oid = %q, want HEAD %q", newest.GetOid().GetHex(), head)
	}
	if !strings.HasPrefix(newest.GetMessage(), "second commit") {
		t.Errorf("message = %q", newest.GetMessage())
	}
	if newest.GetAuthor().GetEmail() != "alice@example.com" {
		t.Errorf("author email = %q", newest.GetAuthor().GetEmail())
	}
	if len(newest.GetParents()) != 1 {
		t.Errorf("parents len = %d, want 1", len(newest.GetParents()))
	}
	if newest.GetCommittedAt() == "" {
		t.Error("committed_at is empty")
	}

	// Lanes are index-aligned with commits (ADR-008).
	lanes := resp.GetLanes()
	if len(lanes) != len(commits) {
		t.Fatalf("lanes len = %d, want %d (parallel to commits)", len(lanes), len(commits))
	}
	if lanes[0].GetIndex() != 0 || !lanes[0].GetContinues() {
		t.Errorf("lanes[0] = %+v, want index 0 continuing", lanes[0])
	}
	if lanes[1].GetIndex() != 0 || lanes[1].GetContinues() {
		t.Errorf("lanes[1] = %+v, want index 0 non-continuing", lanes[1])
	}

	// Ref decorations: HEAD + the checked-out branch on the newest commit.
	var hasHead, hasBranch bool
	for _, r := range newest.GetRefs() {
		switch r.GetKind() {
		case "head":
			if r.GetName() != "HEAD" {
				t.Errorf("head ref name = %q, want HEAD", r.GetName())
			}
			hasHead = true
		case "branch":
			hasBranch = true
		}
	}
	if !hasHead || !hasBranch {
		t.Errorf("newest refs = %+v, want head + branch decorations", newest.GetRefs())
	}

	// Pagination window.
	page, err := client.GetCommits(ctx, &singularitreev1.GetCommitsRequest{
		RepoId: repo.GetId(),
		Offset: 1,
		Limit:  1,
	})
	if err != nil {
		t.Fatalf("GetCommits page: %v", err)
	}
	if len(page.GetCommits()) != 1 {
		t.Fatalf("page len = %d, want 1", len(page.GetCommits()))
	}
	if page.GetTotal() != 2 {
		t.Errorf("page total = %d, want 2", page.GetTotal())
	}
}

// TestOpenRepositoryRejectsNonRepo asserts that OpenRepository validates the
// path through the Git port: a plain temp directory is NOT_A_GIT_REPO (mapped to
// InvalidArgument) and the domain code travels back in the trailer.
func TestOpenRepositoryRejectsNonRepo(t *testing.T) {
	addr := startServer(t)
	conn, err := googlegrpc.NewClient(addr, googlegrpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer conn.Close()
	client := singularitreev1.NewGitCoreClient(conn)

	var trailer metadata.MD
	_, err = client.OpenRepository(
		authed(context.Background()),
		&singularitreev1.OpenRepositoryRequest{FsPath: t.TempDir()},
		googlegrpc.Trailer(&trailer),
	)
	if err == nil {
		t.Fatal("OpenRepository(non-repo) succeeded, want error")
	}
	if got := status.Code(err); got != codes.InvalidArgument {
		t.Fatalf("OpenRepository(non-repo) code = %v, want InvalidArgument (err=%v)", got, err)
	}
	trailerCodes := trailer.Get("x-app-error-code")
	if len(trailerCodes) == 0 || trailerCodes[0] != "NOT_A_GIT_REPO" {
		t.Fatalf("trailer x-app-error-code = %v, want [NOT_A_GIT_REPO]", trailerCodes)
	}
}

func TestGetRepositoryUnknown(t *testing.T) {
	addr := startServer(t)
	conn, err := googlegrpc.NewClient(addr, googlegrpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer conn.Close()
	client := singularitreev1.NewGitCoreClient(conn)

	_, err = client.GetRepository(authed(context.Background()), &singularitreev1.GetRepositoryRequest{RepoId: "nope"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("GetRepository(unknown) code = %v, want NotFound", status.Code(err))
	}
}

func TestRemoveRepositoryUnknown(t *testing.T) {
	addr := startServer(t)
	conn, err := googlegrpc.NewClient(addr, googlegrpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer conn.Close()
	client := singularitreev1.NewGitCoreClient(conn)

	_, err = client.RemoveRepository(authed(context.Background()), &singularitreev1.RemoveRepositoryRequest{RepoId: "nope"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("RemoveRepository(unknown) code = %v, want NotFound", status.Code(err))
	}
}

// TestRemoveRepositoryRoundTrip opens a real fixture repo, removes it, and
// asserts it disappears from ListRepositories and that GetRepository reports
// NotFound.
func TestRemoveRepositoryRoundTrip(t *testing.T) {
	addr := startServer(t)
	fixture := initFixtureRepo(t)

	conn, err := googlegrpc.NewClient(addr, googlegrpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer conn.Close()
	client := singularitreev1.NewGitCoreClient(conn)
	ctx := authed(context.Background())

	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}
	repoID := repo.GetId()

	resp, err := client.RemoveRepository(ctx, &singularitreev1.RemoveRepositoryRequest{RepoId: repoID})
	if err != nil {
		t.Fatalf("RemoveRepository: %v", err)
	}
	if resp == nil {
		t.Fatal("RemoveRepository returned nil response")
	}

	list, err := client.ListRepositories(ctx, &singularitreev1.ListRepositoriesRequest{})
	if err != nil {
		t.Fatalf("ListRepositories: %v", err)
	}
	for _, r := range list.GetRepositories() {
		if r.GetId() == repoID {
			t.Fatalf("removed repo %q still present in ListRepositories", repoID)
		}
	}

	if _, err := client.GetRepository(ctx, &singularitreev1.GetRepositoryRequest{RepoId: repoID}); status.Code(err) != codes.NotFound {
		t.Fatalf("GetRepository after Remove code = %v, want NotFound", status.Code(err))
	}
}

func TestGetBranchesRemotesTags(t *testing.T) {
	addr := startServer(t)
	fixture := initFixtureRepo(t)
	gitRun(t, fixture, "branch", "-M", "main")
	gitRun(t, fixture, "branch", "feature")
	head := gitRun(t, fixture, "rev-parse", "HEAD")
	gitRun(t, fixture, "remote", "add", "origin", "https://example.com/repo.git")
	gitRun(t, fixture, "tag", "light")
	gitRun(t, fixture, "tag", "-a", "annotated", "-m", "release one")

	conn, err := googlegrpc.NewClient(addr, googlegrpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer conn.Close()
	client := singularitreev1.NewGitCoreClient(conn)
	ctx := authed(context.Background())

	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}
	repoID := repo.GetId()

	// Branches round-trip.
	branchesResp, err := client.GetBranches(ctx, &singularitreev1.GetBranchesRequest{RepoId: repoID})
	if err != nil {
		t.Fatalf("GetBranches: %v", err)
	}
	branches := branchesResp.GetBranches()
	if len(branches) != 2 {
		t.Fatalf("branches len = %d, want 2 (%+v)", len(branches), branches)
	}
	byBranch := map[string]*singularitreev1.Branch{}
	for _, b := range branches {
		byBranch[b.GetName()] = b
	}
	main := byBranch["main"]
	if main == nil {
		t.Fatalf("missing main in %+v", branches)
	}
	if !main.GetIsCurrent() || main.GetIsRemote() {
		t.Errorf("main = %+v, want current local branch", main)
	}
	if main.GetRefName() != "refs/heads/main" {
		t.Errorf("main.ref_name = %q, want refs/heads/main", main.GetRefName())
	}
	if main.GetTip().GetHex() != head {
		t.Errorf("main.tip = %q, want HEAD %q", main.GetTip().GetHex(), head)
	}

	// Remotes round-trip.
	remotesResp, err := client.GetRemotes(ctx, &singularitreev1.GetRemotesRequest{RepoId: repoID})
	if err != nil {
		t.Fatalf("GetRemotes: %v", err)
	}
	remotes := remotesResp.GetRemotes()
	if len(remotes) != 1 {
		t.Fatalf("remotes len = %d, want 1 (%+v)", len(remotes), remotes)
	}
	if remotes[0].GetName() != "origin" || len(remotes[0].GetUrls()) != 1 ||
		remotes[0].GetUrls()[0] != "https://example.com/repo.git" {
		t.Errorf("remote = %+v, want origin with configured url", remotes[0])
	}
	if len(remotes[0].GetFetchSpecs()) != 1 {
		t.Errorf("fetch_specs = %v, want one refspec", remotes[0].GetFetchSpecs())
	}

	// Tags round-trip.
	tagsResp, err := client.GetTags(ctx, &singularitreev1.GetTagsRequest{RepoId: repoID})
	if err != nil {
		t.Fatalf("GetTags: %v", err)
	}
	tags := tagsResp.GetTags()
	if len(tags) != 2 {
		t.Fatalf("tags len = %d, want 2 (%+v)", len(tags), tags)
	}
	byTag := map[string]*singularitreev1.Tag{}
	for _, tag := range tags {
		byTag[tag.GetName()] = tag
	}
	light := byTag["light"]
	if light == nil || light.GetAnnotated() {
		t.Errorf("light = %+v, want lightweight tag", light)
	} else if light.GetTarget().GetHex() != head || light.GetTagger() != nil || light.GetMessage() != "" {
		t.Errorf("light = %+v, want target HEAD with no tagger/message", light)
	}
	annotated := byTag["annotated"]
	if annotated == nil || !annotated.GetAnnotated() {
		t.Fatalf("annotated = %+v, want annotated tag", annotated)
	}
	if annotated.GetTarget().GetHex() != head {
		t.Errorf("annotated.target = %q, want dereferenced HEAD %q", annotated.GetTarget().GetHex(), head)
	}
	if annotated.GetTagger().GetEmail() != "alice@example.com" {
		t.Errorf("annotated.tagger email = %q, want alice@example.com", annotated.GetTagger().GetEmail())
	}
	if !strings.Contains(annotated.GetMessage(), "release one") {
		t.Errorf("annotated.message = %q, want subject containing %q", annotated.GetMessage(), "release one")
	}

	// Unknown repository id maps to NotFound through the repo port.
	bad := authed(context.Background())
	if _, err := client.GetBranches(bad, &singularitreev1.GetBranchesRequest{RepoId: "nope"}); status.Code(err) != codes.NotFound {
		t.Errorf("GetBranches(unknown) code = %v, want NotFound", status.Code(err))
	}
	if _, err := client.GetRemotes(bad, &singularitreev1.GetRemotesRequest{RepoId: "nope"}); status.Code(err) != codes.NotFound {
		t.Errorf("GetRemotes(unknown) code = %v, want NotFound", status.Code(err))
	}
	if _, err := client.GetTags(bad, &singularitreev1.GetTagsRequest{RepoId: "nope"}); status.Code(err) != codes.NotFound {
		t.Errorf("GetTags(unknown) code = %v, want NotFound", status.Code(err))
	}

	// Missing/empty repository id must fail fast with a structured NotFound,
	// never crash the handler.
	if _, err := client.GetBranches(bad, &singularitreev1.GetBranchesRequest{}); status.Code(err) != codes.NotFound {
		t.Errorf("GetBranches(empty repo_id) code = %v, want NotFound", status.Code(err))
	}
	if _, err := client.GetRemotes(bad, &singularitreev1.GetRemotesRequest{}); status.Code(err) != codes.NotFound {
		t.Errorf("GetRemotes(empty repo_id) code = %v, want NotFound", status.Code(err))
	}
	if _, err := client.GetTags(bad, &singularitreev1.GetTagsRequest{}); status.Code(err) != codes.NotFound {
		t.Errorf("GetTags(empty repo_id) code = %v, want NotFound", status.Code(err))
	}
}

// TestGetBranchesRemotesTagsUnbornRepo covers the empty/unborn repository
// round-trip: a freshly initialized repo with no commits must report empty
// branch/remote/tag slices without error.
func TestGetBranchesRemotesTagsUnbornRepo(t *testing.T) {
	addr := startServer(t)
	unborn := initUnbornRepo(t)

	conn, err := googlegrpc.NewClient(addr, googlegrpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer conn.Close()
	client := singularitreev1.NewGitCoreClient(conn)
	ctx := authed(context.Background())

	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: unborn})
	if err != nil {
		t.Fatalf("OpenRepository(unborn): %v", err)
	}
	repoID := repo.GetId()
	if repoID == "" {
		t.Fatal("OpenRepository(unborn) returned empty id")
	}

	branchesResp, err := client.GetBranches(ctx, &singularitreev1.GetBranchesRequest{RepoId: repoID})
	if err != nil {
		t.Fatalf("GetBranches(unborn): %v", err)
	}
	if got := branchesResp.GetBranches(); len(got) != 0 {
		t.Errorf("branches len = %d, want 0 (%+v)", len(got), got)
	}

	remotesResp, err := client.GetRemotes(ctx, &singularitreev1.GetRemotesRequest{RepoId: repoID})
	if err != nil {
		t.Fatalf("GetRemotes(unborn): %v", err)
	}
	if got := remotesResp.GetRemotes(); len(got) != 0 {
		t.Errorf("remotes len = %d, want 0 (%+v)", len(got), got)
	}

	tagsResp, err := client.GetTags(ctx, &singularitreev1.GetTagsRequest{RepoId: repoID})
	if err != nil {
		t.Fatalf("GetTags(unborn): %v", err)
	}
	if got := tagsResp.GetTags(); len(got) != 0 {
		t.Errorf("tags len = %d, want 0 (%+v)", len(got), got)
	}
}

// TestCheckoutNilGitService asserts the handler fails fast with
// FailedPrecondition when no git service is wired, instead of panicking.
func TestCheckoutNilGitService(t *testing.T) {
	srv := grpcadapter.NewServer(nil, nil, nil, nil, nil, nil, "")
	_, err := srv.Checkout(context.Background(), &singularitreev1.CheckoutRequest{RepoId: "repo-1", RefName: "main"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("Checkout(nil gitSvc) code = %v, want FailedPrecondition (err=%v)", status.Code(err), err)
	}
}

// TestCheckoutSwitchesBranch covers the end-to-end unary Checkout RPC: the
// renderer sends refs/heads/<b> and the core switches HEAD. An unknown ref is a
// typed CHECKOUT_FAILED (InvalidArgument) with the domain code in the trailer.
func TestCheckoutSwitchesBranch(t *testing.T) {
	addr := startServer(t)
	fixture := initFixtureRepo(t)
	gitRun(t, fixture, "branch", "-M", "main")
	gitRun(t, fixture, "branch", "feature")

	client, closeConn := newGitCoreClient(t, addr)
	defer closeConn()
	ctx := authed(context.Background())

	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}

	resp, err := client.Checkout(ctx, &singularitreev1.CheckoutRequest{RepoId: repo.GetId(), RefName: "refs/heads/feature"})
	if err != nil {
		t.Fatalf("Checkout: %v", err)
	}
	if resp == nil {
		t.Fatal("Checkout returned nil response")
	}
	if got := gitRun(t, fixture, "symbolic-ref", "HEAD"); got != "refs/heads/feature" {
		t.Fatalf("HEAD = %q, want refs/heads/feature", got)
	}

	var trailer metadata.MD
	_, err = client.Checkout(
		ctx,
		&singularitreev1.CheckoutRequest{RepoId: repo.GetId(), RefName: "refs/heads/nope"},
		googlegrpc.Trailer(&trailer),
	)
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("Checkout(unknown) code = %v, want InvalidArgument (err=%v)", status.Code(err), err)
	}
	if got := trailer.Get("x-app-error-code"); len(got) == 0 || got[0] != "CHECKOUT_FAILED" {
		t.Fatalf("trailer x-app-error-code = %v, want [CHECKOUT_FAILED]", got)
	}
}

// TestRelocateRepositoryRoundTrip moves a registered fixture folder on disk and
// repoints the existing registration at the new path. The repository id must be
// preserved (a delete + re-create would mint a new id and drop the cache) and
// Get/List must reflect the new path.
func TestRelocateRepositoryRoundTrip(t *testing.T) {
	addr := startServer(t)
	client, closeConn := newGitCoreClient(t, addr)
	defer closeConn()
	ctx := authed(context.Background())

	fixture := initFixtureRepo(t)
	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}
	repoID := repo.GetId()

	moved := filepath.Join(canonicalTempDir(t), "moved-repo")
	if err := os.Rename(fixture, moved); err != nil {
		t.Fatalf("rename fixture: %v", err)
	}

	relocated, err := client.RelocateRepository(ctx, &singularitreev1.RelocateRepositoryRequest{RepoId: repoID, FsPath: moved})
	if err != nil {
		t.Fatalf("RelocateRepository: %v", err)
	}
	if relocated.GetId() != repoID {
		t.Errorf("id = %q, want preserved %q", relocated.GetId(), repoID)
	}
	if relocated.GetFsPath() != moved {
		t.Errorf("fs_path = %q, want %q", relocated.GetFsPath(), moved)
	}
	if want := filepath.Join(moved, ".git"); relocated.GetCommonDir() != want {
		t.Errorf("common_dir = %q, want refreshed %q", relocated.GetCommonDir(), want)
	}

	got, err := client.GetRepository(ctx, &singularitreev1.GetRepositoryRequest{RepoId: repoID})
	if err != nil {
		t.Fatalf("GetRepository: %v", err)
	}
	if got.GetFsPath() != moved {
		t.Errorf("GetRepository fs_path = %q, want %q", got.GetFsPath(), moved)
	}

	list, err := client.ListRepositories(ctx, &singularitreev1.ListRepositoriesRequest{})
	if err != nil {
		t.Fatalf("ListRepositories: %v", err)
	}
	var found bool
	for _, r := range list.GetRepositories() {
		if r.GetId() == repoID {
			found = true
			if r.GetFsPath() != moved {
				t.Errorf("ListRepositories fs_path = %q, want %q", r.GetFsPath(), moved)
			}
		}
	}
	if !found {
		t.Fatalf("relocated repo %q missing from ListRepositories", repoID)
	}
}

// TestRelocateRepositoryErrorCodes maps each failure to its gRPC status and
// carries the domain code in the trailer: unknown id → NotFound,
// missing target → NotFound (REPO_PATH_MISSING), non-repo target →
// InvalidArgument (NOT_A_GIT_REPO), duplicate target → FailedPrecondition
// (REPO_PATH_IN_USE).
func TestRelocateRepositoryErrorCodes(t *testing.T) {
	addr := startServer(t)
	client, closeConn := newGitCoreClient(t, addr)
	defer closeConn()
	ctx := authed(context.Background())

	fixture := initFixtureRepo(t)
	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}
	repoID := repo.GetId()

	tests := []struct {
		name       string
		req        *singularitreev1.RelocateRepositoryRequest
		wantStatus codes.Code
		wantCode   string
	}{
		{
			name:       "unknown id",
			req:        &singularitreev1.RelocateRepositoryRequest{RepoId: "nope", FsPath: t.TempDir()},
			wantStatus: codes.NotFound,
			wantCode:   "REPO_NOT_FOUND",
		},
		{
			name:       "missing target",
			req:        &singularitreev1.RelocateRepositoryRequest{RepoId: repoID, FsPath: filepath.Join(t.TempDir(), "gone")},
			wantStatus: codes.NotFound,
			wantCode:   "REPO_PATH_MISSING",
		},
		{
			name:       "target not a repo",
			req:        &singularitreev1.RelocateRepositoryRequest{RepoId: repoID, FsPath: t.TempDir()},
			wantStatus: codes.InvalidArgument,
			wantCode:   "NOT_A_GIT_REPO",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var trailer metadata.MD
			_, err := client.RelocateRepository(ctx, tt.req, googlegrpc.Trailer(&trailer))
			if got := status.Code(err); got != tt.wantStatus {
				t.Fatalf("code = %v, want %v (err=%v)", got, tt.wantStatus, err)
			}
			if got := trailer.Get("x-app-error-code"); len(got) == 0 || got[0] != tt.wantCode {
				t.Fatalf("trailer x-app-error-code = %v, want [%s]", got, tt.wantCode)
			}
		})
	}

	// Duplicate target: a second repo is opened at another path, then the first
	// registration is repointed at it. Kept separate because it needs a second
	// real fixture.
	other := initFixtureRepo(t)
	if _, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: other}); err != nil {
		t.Fatalf("OpenRepository(other): %v", err)
	}
	var trailer metadata.MD
	_, err = client.RelocateRepository(
		ctx,
		&singularitreev1.RelocateRepositoryRequest{RepoId: repoID, FsPath: other},
		googlegrpc.Trailer(&trailer),
	)
	if got := status.Code(err); got != codes.FailedPrecondition {
		t.Fatalf("duplicate target code = %v, want FailedPrecondition (err=%v)", got, err)
	}
	if got := trailer.Get("x-app-error-code"); len(got) == 0 || got[0] != "REPO_PATH_IN_USE" {
		t.Fatalf("trailer x-app-error-code = %v, want [REPO_PATH_IN_USE]", got)
	}
}
