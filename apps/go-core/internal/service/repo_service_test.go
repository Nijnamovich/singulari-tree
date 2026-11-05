package service_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
	"github.com/SingulariTree/go-core/internal/service"
)

// stubRepoPort is a minimal domain.RepoPort double recording the calls the
// service makes so delegation and error propagation can be asserted.
type stubRepoPort struct {
	opened      *domain.Repository
	openErr     error
	list        []domain.Repository
	listErr     error
	get         *domain.Repository
	getErr      error
	removeErr   error
	removedID   domain.RepositoryId
	removeCalls int

	relocated     *domain.Repository
	relocateErr   error
	relocatedID   domain.RepositoryId
	relocatePath  string
	relocateCalls int
}

func (p *stubRepoPort) Open(context.Context, string) (*domain.Repository, error) {
	return p.opened, p.openErr
}

func (p *stubRepoPort) List(context.Context) ([]domain.Repository, error) {
	return p.list, p.listErr
}

func (p *stubRepoPort) Remove(_ context.Context, id domain.RepositoryId) error {
	p.removeCalls++
	p.removedID = id
	return p.removeErr
}

func (p *stubRepoPort) Get(context.Context, domain.RepositoryId) (*domain.Repository, error) {
	return p.get, p.getErr
}

func (p *stubRepoPort) Relocate(_ context.Context, id domain.RepositoryId, fsPath string) (*domain.Repository, error) {
	p.relocateCalls++
	p.relocatedID, p.relocatePath = id, fsPath
	if p.relocateErr != nil {
		return nil, p.relocateErr
	}
	if p.relocated != nil {
		return p.relocated, nil
	}
	return &domain.Repository{ID: id, FsPath: fsPath}, nil
}

// stubGitPort satisfies domain.GitPort through the embedded interface while
// recording only Resolve, which is the sole Git-port call RepoService makes.
type stubGitPort struct {
	domain.GitPort

	resolveTop       string
	resolveCommonDir string
	resolveErr       error
}

func (g *stubGitPort) Resolve(context.Context, string) (string, string, error) {
	return g.resolveTop, g.resolveCommonDir, g.resolveErr
}

func TestRemoveNilPortReturnsRepoNotFound(t *testing.T) {
	svc := service.NewRepoService(nil, nil)

	err := svc.Remove(context.Background(), "repo-1")

	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want domain.AppError", err)
	}
	if appErr.Code != domain.ErrCodeRepoNotFound {
		t.Errorf("code = %q, want %q", appErr.Code, domain.ErrCodeRepoNotFound)
	}
}

func TestRemoveDelegatesToPort(t *testing.T) {
	port := &stubRepoPort{}
	svc := service.NewRepoService(port, nil)

	if err := svc.Remove(context.Background(), "repo-42"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if port.removeCalls != 1 {
		t.Errorf("removeCalls = %d, want 1", port.removeCalls)
	}
	if port.removedID != "repo-42" {
		t.Errorf("removedID = %q, want repo-42", port.removedID)
	}
}

func TestRemovePropagatesPortError(t *testing.T) {
	sentinel := errors.New("boom")
	port := &stubRepoPort{removeErr: sentinel}
	svc := service.NewRepoService(port, nil)

	if err := svc.Remove(context.Background(), "repo-1"); !errors.Is(err, sentinel) {
		t.Fatalf("err = %v, want sentinel", err)
	}
}

// requireAppCode asserts err is a domain.AppError carrying code.
func requireAppCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("err = nil, want domain.AppError %s", code)
	}
	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want domain.AppError", err)
	}
	if appErr.Code != code {
		t.Fatalf("code = %q, want %q", appErr.Code, code)
	}
}

// TestOpenMissingPathIsRepoPathMissing pins the distinction at the heart of the
// requirement: a recorded folder that is genuinely gone is REPO_PATH_MISSING,
// not NOT_A_GIT_REPO.
func TestOpenMissingPathIsRepoPathMissing(t *testing.T) {
	svc := service.NewRepoService(&stubRepoPort{}, &stubGitPort{})
	missing := filepath.Join(t.TempDir(), "gone")

	_, err := svc.Open(context.Background(), missing)

	requireAppCode(t, err, domain.ErrCodeRepoPathMissing)
}

// TestOpenExistingNonRepoIsNotAGitRepo proves an existing directory that fails
// Git resolution keeps the historical NOT_A_GIT_REPO classification.
func TestOpenExistingNonRepoIsNotAGitRepo(t *testing.T) {
	dir := t.TempDir()
	git := &stubGitPort{resolveErr: domain.ErrNotAGitRepo}
	svc := service.NewRepoService(&stubRepoPort{}, git)

	_, err := svc.Open(context.Background(), dir)

	requireAppCode(t, err, domain.ErrCodeNotAGitRepo)
}

func TestRelocateHappyPathPreservesID(t *testing.T) {
	dir := t.TempDir()
	port := &stubRepoPort{get: &domain.Repository{ID: "repo-1"}}
	git := &stubGitPort{resolveTop: dir, resolveCommonDir: filepath.Join(dir, ".git")}
	svc := service.NewRepoService(port, git)

	got, err := svc.Relocate(context.Background(), "repo-1", dir)
	if err != nil {
		t.Fatalf("Relocate: %v", err)
	}
	if got.ID != "repo-1" {
		t.Errorf("id = %q, want repo-1 (must be preserved)", got.ID)
	}
	if port.relocatedID != "repo-1" {
		t.Errorf("port relocated id = %q, want repo-1", port.relocatedID)
	}
	if port.relocatePath != dir {
		t.Errorf("port relocated path = %q, want resolved top-level %q", port.relocatePath, dir)
	}
	if port.relocateCalls != 1 {
		t.Errorf("relocateCalls = %d, want 1", port.relocateCalls)
	}
}

func TestRelocateUnknownIDIsRepoNotFound(t *testing.T) {
	port := &stubRepoPort{getErr: domain.ErrRepoNotFound}
	svc := service.NewRepoService(port, &stubGitPort{})

	_, err := svc.Relocate(context.Background(), "nope", t.TempDir())

	requireAppCode(t, err, domain.ErrCodeRepoNotFound)
	if port.relocateCalls != 0 {
		t.Errorf("relocateCalls = %d, want 0 (unknown id must fail before relocating)", port.relocateCalls)
	}
}

func TestRelocateMissingTargetIsRepoPathMissing(t *testing.T) {
	port := &stubRepoPort{get: &domain.Repository{ID: "repo-1"}}
	svc := service.NewRepoService(port, &stubGitPort{})

	_, err := svc.Relocate(context.Background(), "repo-1", filepath.Join(t.TempDir(), "gone"))

	requireAppCode(t, err, domain.ErrCodeRepoPathMissing)
	if port.relocateCalls != 0 {
		t.Errorf("relocateCalls = %d, want 0", port.relocateCalls)
	}
}

func TestRelocateNonRepoIsNotAGitRepo(t *testing.T) {
	dir := t.TempDir()
	port := &stubRepoPort{get: &domain.Repository{ID: "repo-1"}}
	git := &stubGitPort{resolveErr: domain.ErrNotAGitRepo}
	svc := service.NewRepoService(port, git)

	_, err := svc.Relocate(context.Background(), "repo-1", dir)

	requireAppCode(t, err, domain.ErrCodeNotAGitRepo)
	if port.relocateCalls != 0 {
		t.Errorf("relocateCalls = %d, want 0", port.relocateCalls)
	}
}

func TestRelocateTargetInUseIsRepoPathInUse(t *testing.T) {
	dir := t.TempDir()
	port := &stubRepoPort{get: &domain.Repository{ID: "repo-1"}, relocateErr: domain.ErrRepoPathInUse}
	git := &stubGitPort{resolveTop: dir}
	svc := service.NewRepoService(port, git)

	_, err := svc.Relocate(context.Background(), "repo-1", dir)

	requireAppCode(t, err, domain.ErrCodeRepoPathInUse)
}
