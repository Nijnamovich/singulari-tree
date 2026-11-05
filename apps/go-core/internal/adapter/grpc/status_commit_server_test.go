package grpc_test

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"

	googlegrpc "google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	singularitreev1 "github.com/SingulariTree/go-core/gen/go/singularitree/v1"
	grpcadapter "github.com/SingulariTree/go-core/internal/adapter/grpc"
	"github.com/SingulariTree/go-core/internal/domain"
	"github.com/SingulariTree/go-core/internal/service"
)

// fakeGitPort implements the subset of domain.GitPort exercised by the
// status/diff/stage/unstage/commit RPCs. The embedded interface satisfies the
// remaining methods; calling one of those would panic, which the tests never do.
// It also captures the arguments it receives so pass-through semantics can be
// asserted.
type fakeGitPort struct {
	domain.GitPort

	statusResult []domain.FileStatus
	statusErr    error

	diffResult    *domain.Diff
	diffErr       error
	gotDiffFrom   domain.Oid
	gotDiffTo     domain.Oid
	gotDiffPath   string
	gotDiffStaged bool

	stageHunkCalls   int
	unstageHunkCalls int
	discardHunkCalls int
	discardPaths     []string
	resetTo          string
	resetMode        domain.ResetMode
	resetCalls       int

	commitStatsResult []domain.CommitStats
	commitStatsErr    error
	gotStatsOids      []string

	gotStageRepo  domain.RepositoryId
	gotStagePaths []string
	stageErr      error

	gotUnstageRepo  domain.RepositoryId
	gotUnstagePaths []string
	unstageErr      error

	commitResult    *domain.Commit
	commitErr       error
	gotCommitRepo   domain.RepositoryId
	gotCommitMsg    string
	gotCommitAuthor *domain.Signature
}

func (f *fakeGitPort) Status(context.Context, domain.RepositoryId) ([]domain.FileStatus, error) {
	return f.statusResult, f.statusErr
}

func (f *fakeGitPort) Diff(_ context.Context, _ domain.RepositoryId, req domain.DiffRequest) (*domain.Diff, error) {
	f.gotDiffFrom, f.gotDiffTo = req.From, req.To
	f.gotDiffPath, f.gotDiffStaged = req.Path, req.Staged
	return f.diffResult, f.diffErr
}

func (f *fakeGitPort) Stage(_ context.Context, repoID domain.RepositoryId, paths []string) error {
	f.gotStageRepo, f.gotStagePaths = repoID, paths
	return f.stageErr
}

func (f *fakeGitPort) Unstage(_ context.Context, repoID domain.RepositoryId, paths []string) error {
	f.gotUnstageRepo, f.gotUnstagePaths = repoID, paths
	return f.unstageErr
}

func (f *fakeGitPort) Commit(_ context.Context, repoID domain.RepositoryId, msg string, author *domain.Signature) (*domain.Commit, error) {
	f.gotCommitRepo, f.gotCommitMsg, f.gotCommitAuthor = repoID, msg, author
	return f.commitResult, f.commitErr
}

func (f *fakeGitPort) StageHunk(context.Context, domain.RepositoryId, string, uint32, []uint32) error {
	f.stageHunkCalls++
	return nil
}

func (f *fakeGitPort) UnstageHunk(context.Context, domain.RepositoryId, string, uint32, []uint32) error {
	f.unstageHunkCalls++
	return nil
}

func (f *fakeGitPort) DiscardHunk(context.Context, domain.RepositoryId, string, uint32, []uint32) error {
	f.discardHunkCalls++
	return nil
}

func (f *fakeGitPort) Discard(_ context.Context, _ domain.RepositoryId, paths []string) error {
	f.discardPaths = paths
	return nil
}

func (f *fakeGitPort) Reset(_ context.Context, _ domain.RepositoryId, to string, mode domain.ResetMode) error {
	f.resetCalls++
	f.resetTo, f.resetMode = to, mode
	return nil
}

func (f *fakeGitPort) CommitStats(_ context.Context, _ domain.RepositoryId, oids []string) ([]domain.CommitStats, error) {
	f.gotStatsOids = oids
	return f.commitStatsResult, f.commitStatsErr
}

// startGitServer boots a real gRPC server whose GitCore service is backed by a
// GitService over the given fake port. Only the Git-read/write RPCs are usable;
// repo/graph/watcher/cache services are nil. Auth mirrors startServer.
func startGitServer(t *testing.T, port domain.GitPort) string {
	t.Helper()
	gitSvc := service.NewGitService(port, nil, nil)
	grpcSrv := grpcadapter.NewServer(nil, gitSvc, nil, nil, nil, nil, testToken)
	gs := googlegrpc.NewServer(
		googlegrpc.UnaryInterceptor(grpcadapter.UnaryAuthInterceptor(testToken)),
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

func TestGetStatusMapsFileStatus(t *testing.T) {
	port := &fakeGitPort{statusResult: []domain.FileStatus{
		{Path: "a.txt", Staged: "M", Unstaged: " ", IsStaged: true},
		{Path: "b.txt", Staged: "?", Unstaged: "?", IsConflicted: true},
	}}
	client, closeConn := newGitCoreClient(t, startGitServer(t, port))
	defer closeConn()

	resp, err := client.GetStatus(authed(context.Background()), &singularitreev1.GetStatusRequest{RepoId: "repo-1"})
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	files := resp.GetFiles()
	if len(files) != 2 {
		t.Fatalf("files len = %d, want 2 (%+v)", len(files), files)
	}
	if files[0].GetPath() != "a.txt" || files[0].GetStaged() != "M" || !files[0].GetIsStaged() {
		t.Errorf("files[0] = %+v, want a.txt staged M", files[0])
	}
	if files[1].GetPath() != "b.txt" || !files[1].GetIsConflicted() {
		t.Errorf("files[1] = %+v, want b.txt conflicted", files[1])
	}
}

func TestGetDiffMapsHunksAndLineKinds(t *testing.T) {
	from := strings.Repeat("a", 40)
	to := strings.Repeat("b", 40)
	port := &fakeGitPort{diffResult: &domain.Diff{
		From:      domain.Oid{Hex: from, Kind: "SHA1"},
		To:        domain.Oid{Hex: to, Kind: "SHA1"},
		Additions: 1,
		Deletions: 1,
		Hunks: []domain.Hunk{{
			FromStart: 1, FromLines: 2, ToStart: 1, ToLines: 2,
			Lines: []domain.DiffLine{
				{Kind: "context", Text: " same"},
				{Kind: "removed", Text: "-old"},
				{Kind: "added", Text: "+new", NoNewline: true},
			},
		}},
	}}
	client, closeConn := newGitCoreClient(t, startGitServer(t, port))
	defer closeConn()

	resp, err := client.GetDiff(authed(context.Background()), &singularitreev1.GetDiffRequest{
		RepoId: "repo-1", From: from, To: to,
	})
	if err != nil {
		t.Fatalf("GetDiff: %v", err)
	}
	if resp.GetFrom().GetHex() != from || resp.GetTo().GetHex() != to {
		t.Errorf("oids = %q/%q, want %q/%q", resp.GetFrom().GetHex(), resp.GetTo().GetHex(), from, to)
	}
	if resp.GetAdditions() != 1 || resp.GetDeletions() != 1 {
		t.Errorf("counts = +%d/-%d, want +1/-1", resp.GetAdditions(), resp.GetDeletions())
	}
	hunks := resp.GetHunks()
	if len(hunks) != 1 {
		t.Fatalf("hunks len = %d, want 1 (%+v)", len(hunks), hunks)
	}
	h := hunks[0]
	if h.GetFromStart() != 1 || h.GetFromLines() != 2 || h.GetToStart() != 1 || h.GetToLines() != 2 {
		t.Errorf("hunk header = {%d,%d,%d,%d}, want {1,2,1,2}",
			h.GetFromStart(), h.GetFromLines(), h.GetToStart(), h.GetToLines())
	}
	lines := h.GetLines()
	if len(lines) != 3 {
		t.Fatalf("lines len = %d, want 3", len(lines))
	}
	if lines[0].GetKind() != "context" || lines[1].GetKind() != "removed" || lines[2].GetKind() != "added" {
		t.Errorf("line kinds = %q/%q/%q, want context/removed/added",
			lines[0].GetKind(), lines[1].GetKind(), lines[2].GetKind())
	}
	if !lines[2].GetNoNewline() {
		t.Error("last line no_newline = false, want true")
	}
	// The parsed oids reached the service verbatim.
	if port.gotDiffFrom.Hex != from || port.gotDiffTo.Hex != to {
		t.Errorf("port got from/to = %q/%q, want %q/%q", port.gotDiffFrom.Hex, port.gotDiffTo.Hex, from, to)
	}
}

func TestGetDiffEmptySidesPassZeroOid(t *testing.T) {
	port := &fakeGitPort{diffResult: &domain.Diff{}}
	client, closeConn := newGitCoreClient(t, startGitServer(t, port))
	defer closeConn()

	resp, err := client.GetDiff(authed(context.Background()), &singularitreev1.GetDiffRequest{RepoId: "repo-1"})
	if err != nil {
		t.Fatalf("GetDiff: %v", err)
	}
	if resp.GetFrom() != nil || resp.GetTo() != nil {
		t.Errorf("empty sides should map to unset oids, got from=%+v to=%+v", resp.GetFrom(), resp.GetTo())
	}
	if port.gotDiffFrom.Hex != "" || port.gotDiffTo.Hex != "" {
		t.Errorf("port got from/to = %q/%q, want zero oids", port.gotDiffFrom.Hex, port.gotDiffTo.Hex)
	}
}

func TestGetDiffInvalidOidMapsTrailer(t *testing.T) {
	port := &fakeGitPort{}
	client, closeConn := newGitCoreClient(t, startGitServer(t, port))
	defer closeConn()

	var trailer metadata.MD
	_, err := client.GetDiff(
		authed(context.Background()),
		&singularitreev1.GetDiffRequest{RepoId: "repo-1", From: "not-an-oid"},
		googlegrpc.Trailer(&trailer),
	)
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("GetDiff(bad oid) code = %v, want InvalidArgument (err=%v)", status.Code(err), err)
	}
	if got := trailer.Get("x-app-error-code"); len(got) == 0 || got[0] != domain.ErrCodeInvalidOid {
		t.Fatalf("trailer x-app-error-code = %v, want [%s]", got, domain.ErrCodeInvalidOid)
	}
}

func TestStageUnstagePassThrough(t *testing.T) {
	port := &fakeGitPort{}
	client, closeConn := newGitCoreClient(t, startGitServer(t, port))
	defer closeConn()
	ctx := authed(context.Background())

	stageResp, err := client.Stage(ctx, &singularitreev1.StageRequest{RepoId: "repo-9", Paths: []string{"a.txt", "b.txt"}})
	if err != nil {
		t.Fatalf("Stage: %v", err)
	}
	if stageResp == nil {
		t.Fatal("Stage returned nil response")
	}
	if port.gotStageRepo != "repo-9" {
		t.Errorf("Stage repo = %q, want repo-9", port.gotStageRepo)
	}
	if strings.Join(port.gotStagePaths, ",") != "a.txt,b.txt" {
		t.Errorf("Stage paths = %v, want [a.txt b.txt]", port.gotStagePaths)
	}

	unstageResp, err := client.Unstage(ctx, &singularitreev1.UnstageRequest{RepoId: "repo-9", Paths: []string{"c.txt"}})
	if err != nil {
		t.Fatalf("Unstage: %v", err)
	}
	if unstageResp == nil {
		t.Fatal("Unstage returned nil response")
	}
	if port.gotUnstageRepo != "repo-9" {
		t.Errorf("Unstage repo = %q, want repo-9", port.gotUnstageRepo)
	}
	if strings.Join(port.gotUnstagePaths, ",") != "c.txt" {
		t.Errorf("Unstage paths = %v, want [c.txt]", port.gotUnstagePaths)
	}
}

func TestStageErrorMapsTrailer(t *testing.T) {
	port := &fakeGitPort{stageErr: domain.AppError{Code: domain.ErrCodeStageFailed, Message: "stage failed"}}
	client, closeConn := newGitCoreClient(t, startGitServer(t, port))
	defer closeConn()

	var trailer metadata.MD
	_, err := client.Stage(
		authed(context.Background()),
		&singularitreev1.StageRequest{RepoId: "repo-1", Paths: []string{"a.txt"}},
		googlegrpc.Trailer(&trailer),
	)
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("Stage error code = %v, want InvalidArgument (err=%v)", status.Code(err), err)
	}
	if got := trailer.Get("x-app-error-code"); len(got) == 0 || got[0] != domain.ErrCodeStageFailed {
		t.Fatalf("trailer x-app-error-code = %v, want [%s]", got, domain.ErrCodeStageFailed)
	}
}

func TestCommitMapsCommitAndAuthorOverride(t *testing.T) {
	when := time.Date(2026, 10, 7, 12, 34, 56, 0, time.UTC)
	port := &fakeGitPort{commitResult: &domain.Commit{
		Oid:         domain.Oid{Hex: strings.Repeat("c", 40), Kind: "SHA1"},
		Author:      domain.Signature{Name: "Override", Email: "override@example.com", When: when},
		Message:     "hello",
		TreeOid:     domain.Oid{Hex: strings.Repeat("d", 40), Kind: "SHA1"},
		CommittedAt: when,
	}}
	client, closeConn := newGitCoreClient(t, startGitServer(t, port))
	defer closeConn()

	resp, err := client.Commit(authed(context.Background()), &singularitreev1.CommitRequest{
		RepoId:  "repo-1",
		Message: "hello",
		Author:  &singularitreev1.Signature{Name: "Override", Email: "override@example.com", When: when.Format(time.RFC3339)},
	})
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if resp.GetOid().GetHex() != strings.Repeat("c", 40) || resp.GetMessage() != "hello" {
		t.Errorf("commit = %+v, want oid c*40 message hello", resp)
	}
	if resp.GetAuthor().GetEmail() != "override@example.com" {
		t.Errorf("author email = %q, want override@example.com", resp.GetAuthor().GetEmail())
	}
	if port.gotCommitRepo != "repo-1" || port.gotCommitMsg != "hello" {
		t.Errorf("port got repo/msg = %q/%q, want repo-1/hello", port.gotCommitRepo, port.gotCommitMsg)
	}
	if port.gotCommitAuthor == nil {
		t.Fatal("port author = nil, want override signature")
	}
	if port.gotCommitAuthor.Name != "Override" || port.gotCommitAuthor.Email != "override@example.com" {
		t.Errorf("port author = %+v, want Override/override@example.com", *port.gotCommitAuthor)
	}
	if !port.gotCommitAuthor.When.Equal(when) {
		t.Errorf("port author when = %v, want %v", port.gotCommitAuthor.When, when)
	}
}

func TestCommitWithoutAuthorPassesNil(t *testing.T) {
	port := &fakeGitPort{commitResult: &domain.Commit{Oid: domain.Oid{Hex: strings.Repeat("e", 40), Kind: "SHA1"}}}
	client, closeConn := newGitCoreClient(t, startGitServer(t, port))
	defer closeConn()

	if _, err := client.Commit(authed(context.Background()), &singularitreev1.CommitRequest{RepoId: "repo-1", Message: "m"}); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if port.gotCommitAuthor != nil {
		t.Errorf("port author = %+v, want nil when no override", *port.gotCommitAuthor)
	}
}

func TestCommitInvalidWhenMapsTrailer(t *testing.T) {
	port := &fakeGitPort{}
	client, closeConn := newGitCoreClient(t, startGitServer(t, port))
	defer closeConn()

	var trailer metadata.MD
	_, err := client.Commit(
		authed(context.Background()),
		&singularitreev1.CommitRequest{
			RepoId:  "repo-1",
			Message: "m",
			Author:  &singularitreev1.Signature{Name: "x", Email: "y@x", When: "not-a-time"},
		},
		googlegrpc.Trailer(&trailer),
	)
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("Commit(bad when) code = %v, want InvalidArgument (err=%v)", status.Code(err), err)
	}
	if got := trailer.Get("x-app-error-code"); len(got) == 0 || got[0] != domain.ErrCodeCommitFailed {
		t.Fatalf("trailer x-app-error-code = %v, want [%s]", got, domain.ErrCodeCommitFailed)
	}
}

// TestStatusCommitNilGitService asserts each new handler fails fast with
// FailedPrecondition when no git service is wired, instead of panicking.
func TestStatusCommitNilGitService(t *testing.T) {
	srv := grpcadapter.NewServer(nil, nil, nil, nil, nil, nil, "")
	ctx := context.Background()

	if _, err := srv.GetStatus(ctx, &singularitreev1.GetStatusRequest{RepoId: "r"}); status.Code(err) != codes.FailedPrecondition {
		t.Errorf("GetStatus(nil gitSvc) code = %v, want FailedPrecondition", status.Code(err))
	}
	if _, err := srv.GetDiff(ctx, &singularitreev1.GetDiffRequest{RepoId: "r"}); status.Code(err) != codes.FailedPrecondition {
		t.Errorf("GetDiff(nil gitSvc) code = %v, want FailedPrecondition", status.Code(err))
	}
	if _, err := srv.Stage(ctx, &singularitreev1.StageRequest{RepoId: "r"}); status.Code(err) != codes.FailedPrecondition {
		t.Errorf("Stage(nil gitSvc) code = %v, want FailedPrecondition", status.Code(err))
	}
	if _, err := srv.Unstage(ctx, &singularitreev1.UnstageRequest{RepoId: "r"}); status.Code(err) != codes.FailedPrecondition {
		t.Errorf("Unstage(nil gitSvc) code = %v, want FailedPrecondition", status.Code(err))
	}
	if _, err := srv.Commit(ctx, &singularitreev1.CommitRequest{RepoId: "r"}); status.Code(err) != codes.FailedPrecondition {
		t.Errorf("Commit(nil gitSvc) code = %v, want FailedPrecondition", status.Code(err))
	}
}
