package grpc_test

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	googlegrpc "google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	singularitreev1 "github.com/SingulariTree/go-core/gen/go/singularitree/v1"
)

// progressStream is the common receive side of the three server-streaming
// remote-operation RPCs.
type progressStream interface {
	Recv() (*singularitreev1.Progress, error)
	Trailer() metadata.MD
}

// drainProgressStream consumes a progress stream until EOF, failing on any error.
func drainProgressStream(t *testing.T, stream progressStream) []*singularitreev1.Progress {
	t.Helper()
	var out []*singularitreev1.Progress
	for {
		p, err := stream.Recv()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatalf("stream Recv: %v", err)
		}
		out = append(out, p)
	}
}

// requireAppError asserts a stream terminated with an error and (when available)
// the domain code in the trailer.
func requireAppError(t *testing.T, err error, trailer metadata.MD, wantCode string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error with code %s, got nil", wantCode)
	}
	if got := status.Code(err); got != codes.Unavailable {
		t.Errorf("status code = %v, want Unavailable (err=%v)", got, err)
	}
	if trailer != nil {
		if got := trailer.Get("x-app-error-code"); len(got) == 0 || got[0] != wantCode {
			t.Errorf("trailer x-app-error-code = %v, want [%s]", got, wantCode)
		}
	}
}

func newGitCoreClient(t *testing.T, addr string) (singularitreev1.GitCoreClient, func()) {
	t.Helper()
	conn, err := googlegrpc.NewClient(addr, googlegrpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return singularitreev1.NewGitCoreClient(conn), func() { _ = conn.Close() }
}

func TestFetchStreamsProgressAndUnknownRemote(t *testing.T) {
	addr := startServer(t)
	fixture := initFixtureRepo(t)
	gitRun(t, fixture, "branch", "-M", "main")
	bare := t.TempDir()
	gitRun(t, bare, "init", "--bare", "-q")
	gitRun(t, fixture, "remote", "add", "origin", bare)
	gitRun(t, fixture, "push", "-q", "-u", "origin", "main")
	// Force the fetch to recreate the remote-tracking ref.
	gitRun(t, fixture, "update-ref", "-d", "refs/remotes/origin/main")

	client, closeConn := newGitCoreClient(t, addr)
	defer closeConn()
	ctx := authed(context.Background())

	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}

	stream, err := client.Fetch(ctx, &singularitreev1.FetchRequest{
		RepoId: repo.GetId(),
		Remote: "origin",
		Prune:  true,
	})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	chunks := drainProgressStream(t, stream)
	if len(chunks) == 0 {
		t.Fatal("Fetch stream produced no Progress chunks")
	}
	for _, p := range chunks {
		if p.GetPercent() > 100 {
			t.Errorf("chunk percent = %d, want <= 100", p.GetPercent())
		}
	}

	head := gitRun(t, fixture, "rev-parse", "HEAD")
	if got := gitRun(t, fixture, "rev-parse", "refs/remotes/origin/main"); got != head {
		t.Errorf("refs/remotes/origin/main = %s, want HEAD %s", got, head)
	}

	// Bad remote: server-streaming errors surface on Recv with the domain code
	// in the trailer.
	badStream, err := client.Fetch(ctx, &singularitreev1.FetchRequest{RepoId: repo.GetId(), Remote: "bogus"})
	if err != nil {
		requireAppError(t, err, nil, "FETCH_FAILED")
		return
	}
	_, err = badStream.Recv()
	requireAppError(t, err, badStream.Trailer(), "FETCH_FAILED")
}

func TestPushStreamsProgressAndUnknownRemote(t *testing.T) {
	addr := startServer(t)
	fixture := initFixtureRepo(t)
	gitRun(t, fixture, "branch", "-M", "main")
	bare := t.TempDir()
	gitRun(t, bare, "init", "--bare", "-q")
	gitRun(t, fixture, "remote", "add", "origin", bare)

	client, closeConn := newGitCoreClient(t, addr)
	defer closeConn()
	ctx := authed(context.Background())

	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}

	stream, err := client.Push(ctx, &singularitreev1.PushRequest{
		RepoId:      repo.GetId(),
		Remote:      "origin",
		Branch:      "main",
		SetUpstream: true,
	})
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	chunks := drainProgressStream(t, stream)
	if len(chunks) == 0 {
		t.Fatal("Push stream produced no Progress chunks")
	}

	head := gitRun(t, fixture, "rev-parse", "HEAD")
	if got := gitRun(t, bare, "rev-parse", "refs/heads/main"); got != head {
		t.Errorf("remote refs/heads/main = %s, want %s", got, head)
	}

	badStream, err := client.Push(ctx, &singularitreev1.PushRequest{RepoId: repo.GetId(), Remote: "bogus", Branch: "main"})
	if err != nil {
		requireAppError(t, err, nil, "PUSH_FAILED")
		return
	}
	_, err = badStream.Recv()
	requireAppError(t, err, badStream.Trailer(), "PUSH_FAILED")
}

// TestPushNonFastForwardSurfacesTerminalError proves a post-spawn git failure
// (rejected non-fast-forward push) becomes a non-OK gRPC status with the typed
// domain code, rather than a clean EOF the renderer would treat as success.
func TestPushNonFastForwardSurfacesTerminalError(t *testing.T) {
	addr := startServer(t)
	fixture := initFixtureRepo(t)
	gitRun(t, fixture, "branch", "-M", "main")
	bare := t.TempDir()
	gitRun(t, bare, "init", "--bare", "-q")
	gitRun(t, fixture, "remote", "add", "origin", bare)
	gitRun(t, fixture, "push", "-q", "-u", "origin", "main")
	gitRun(t, bare, "symbolic-ref", "HEAD", "refs/heads/main")

	// A second clone advances the remote so the fixture diverges behind it.
	otherParent := t.TempDir()
	clone := filepath.Join(otherParent, "clone")
	gitRun(t, otherParent, "clone", "-q", bare, "clone")
	gitRun(t, clone, "config", "user.email", "bob@example.com")
	gitRun(t, clone, "config", "user.name", "Bob")
	gitRun(t, clone, "config", "commit.gpgsign", "false")
	if err := os.WriteFile(filepath.Join(clone, "remote.txt"), []byte("remote\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, clone, "add", ".")
	gitRun(t, clone, "commit", "-q", "-m", "remote change")
	gitRun(t, clone, "push", "-q", "origin", "main")

	if err := os.WriteFile(filepath.Join(fixture, "local.txt"), []byte("local\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, fixture, "add", ".")
	gitRun(t, fixture, "commit", "-q", "-m", "local change")

	client, closeConn := newGitCoreClient(t, addr)
	defer closeConn()
	ctx := authed(context.Background())

	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}

	stream, err := client.Push(ctx, &singularitreev1.PushRequest{RepoId: repo.GetId(), Remote: "origin", Branch: "main"})
	if err != nil {
		requireAppError(t, err, nil, "PUSH_FAILED")
		return
	}
	sawChunk := false
	for {
		_, rerr := stream.Recv()
		if rerr == io.EOF {
			t.Fatal("non-fast-forward push stream ended cleanly, want PUSH_FAILED")
		}
		if rerr != nil {
			requireAppError(t, rerr, stream.Trailer(), "PUSH_FAILED")
			break
		}
		sawChunk = true
	}
	if !sawChunk {
		t.Fatal("push stream produced no progress chunks before the terminal error")
	}
}

// TestPullRejectsUnsafeArg ensures Pull maps validation failures to PULL_FAILED
// with the domain code in the stream trailer.
func TestPullRejectsUnsafeArg(t *testing.T) {
	addr := startServer(t)
	fixture := initFixtureRepo(t)

	client, closeConn := newGitCoreClient(t, addr)
	defer closeConn()
	ctx := authed(context.Background())

	repo, err := client.OpenRepository(ctx, &singularitreev1.OpenRepositoryRequest{FsPath: fixture})
	if err != nil {
		t.Fatalf("OpenRepository: %v", err)
	}

	stream, err := client.Pull(ctx, &singularitreev1.PullRequest{RepoId: repo.GetId(), Remote: "-evil", Branch: "main"})
	if err != nil {
		requireAppError(t, err, nil, "PULL_FAILED")
		return
	}
	_, err = stream.Recv()
	requireAppError(t, err, stream.Trailer(), "PULL_FAILED")
}
