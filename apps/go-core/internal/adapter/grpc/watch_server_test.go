package grpc_test

import (
	"context"
	"net"
	"testing"

	googlegrpc "google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	singularitreev1 "github.com/SingulariTree/go-core/gen/go/singularitree/v1"
	grpcadapter "github.com/SingulariTree/go-core/internal/adapter/grpc"
	"github.com/SingulariTree/go-core/internal/domain"
	"github.com/SingulariTree/go-core/internal/service"
)

// fakeWatchPort is a domain.WatcherPort whose channel is owned by the test, so
// the Watch stream can be fed events deterministically.
type fakeWatchPort struct {
	ch chan domain.FsChangedEvent
}

func (f *fakeWatchPort) Watch(context.Context, domain.RepositoryId) (<-chan domain.FsChangedEvent, error) {
	return f.ch, nil
}

func (f *fakeWatchPort) Unwatch(domain.RepositoryId) error { return nil }

// startWatchServer boots a GitCore gRPC server with only the watcher service
// configured (the Watch RPC touches nothing else) and returns its address.
func startWatchServer(t *testing.T, watcherSvc *service.WatcherService) string {
	t.Helper()
	grpcSrv := grpcadapter.NewServer(nil, nil, nil, watcherSvc, nil, nil, testToken)
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

// TestWatchStreamsEventsAndEndsOnCancel proves the server-streaming Watch RPC
// forwards port events as proto FsChangedEvent messages and that cancelling the
// client context terminates the stream.
func TestWatchStreamsEventsAndEndsOnCancel(t *testing.T) {
	portCh := make(chan domain.FsChangedEvent, 4)
	watcherSvc := service.NewWatcherService(&fakeWatchPort{ch: portCh})
	addr := startWatchServer(t, watcherSvc)

	client, closeConn := newGitCoreClient(t, addr)
	defer closeConn()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	stream, err := client.Watch(authed(ctx), &singularitreev1.WatchRequest{RepoId: "repo-1"})
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}

	portCh <- domain.FsChangedEvent{RepoID: "repo-1", Paths: []string{"a.txt", "b.txt"}}

	ev, err := stream.Recv()
	if err != nil {
		t.Fatalf("Recv: %v", err)
	}
	if ev.GetRepoId() != "repo-1" {
		t.Errorf("event repo_id = %q, want repo-1", ev.GetRepoId())
	}
	if got := ev.GetPaths(); len(got) != 2 || got[0] != "a.txt" || got[1] != "b.txt" {
		t.Errorf("event paths = %v, want [a.txt b.txt]", got)
	}

	// Cancelling the stream context must end the RPC.
	cancel()
	if _, err := stream.Recv(); status.Code(err) != codes.Canceled {
		t.Fatalf("Recv after cancel: err = %v (code %v), want Canceled", err, status.Code(err))
	}
}

// TestWatchWithoutWatcherServiceFailsPrecondition pins the nil-service guard.
func TestWatchWithoutWatcherServiceFailsPrecondition(t *testing.T) {
	addr := startWatchServer(t, nil)

	client, closeConn := newGitCoreClient(t, addr)
	defer closeConn()

	stream, err := client.Watch(authed(context.Background()), &singularitreev1.WatchRequest{RepoId: "repo-1"})
	if err != nil {
		if status.Code(err) != codes.FailedPrecondition {
			t.Fatalf("Watch error code = %v, want FailedPrecondition", status.Code(err))
		}
		return
	}
	if _, err := stream.Recv(); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("Recv error = %v (code %v), want FailedPrecondition", err, status.Code(err))
	}
}
