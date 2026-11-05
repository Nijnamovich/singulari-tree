package service_test

import (
	"context"
	"errors"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
	"github.com/SingulariTree/go-core/internal/service"
)

type stubSource struct {
	token      string
	err        error
	calls      int
	lastBinary string
}

func (s *stubSource) Token(_ context.Context, ghBinary string) (string, error) {
	s.calls++
	s.lastBinary = ghBinary
	return s.token, s.err
}

type stubPort struct {
	user      *domain.GitHubUser
	userErr   error
	userCalls int

	listResult *domain.ListReposResult
	listErr    error
	listCalls  int
	gotToken   string
	gotLogin   string

	invalidated []string
}

func (p *stubPort) GetUser(context.Context, string) (*domain.GitHubUser, error) {
	p.userCalls++
	return p.user, p.userErr
}

func (p *stubPort) ListRepos(_ context.Context, token, accountLogin string, _ domain.ListReposRequest) (*domain.ListReposResult, error) {
	p.listCalls++
	p.gotToken = token
	p.gotLogin = accountLogin
	return p.listResult, p.listErr
}

func (p *stubPort) InvalidateCache(accountLogin string) {
	p.invalidated = append(p.invalidated, accountLogin)
}

func TestConnectSetsStatus(t *testing.T) {
	port := &stubPort{user: &domain.GitHubUser{ID: 1, Login: "dave", Name: "Dave", AvatarURL: "av", Email: "d@x"}}
	svc := service.NewAuthService(port, &stubSource{token: "tok"}, service.AuthConfig{})

	status, user, err := svc.ConnectFromCLI(context.Background(), "gh", true)
	if err != nil {
		t.Fatalf("ConnectFromCLI: %v", err)
	}
	if status == nil || !status.Authenticated || status.Source != domain.AuthSourceGitHubCLI {
		t.Fatalf("status = %+v", status)
	}
	if status.AccountLogin != "dave" || status.Name != "Dave" || status.AvatarURL != "av" || status.Email != "d@x" {
		t.Errorf("status fields = %+v", status)
	}
	if user == nil || user.Login != "dave" {
		t.Errorf("user = %+v", user)
	}

	got, err := svc.GetStatus(context.Background())
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	if got.AccountLogin != "dave" {
		t.Errorf("GetStatus login = %q", got.AccountLogin)
	}
}

func TestConnectVerifyFalseToleratesGetUserFailure(t *testing.T) {
	port := &stubPort{userErr: errors.New("boom")}
	svc := service.NewAuthService(port, &stubSource{token: "tok"}, service.AuthConfig{})

	status, user, err := svc.ConnectFromCLI(context.Background(), "gh", false)
	if err != nil {
		t.Fatalf("ConnectFromCLI(verify=false): %v", err)
	}
	if status == nil || !status.Authenticated {
		t.Fatalf("status = %+v", status)
	}
	if user != nil {
		t.Errorf("user = %+v, want nil", user)
	}
	if status.Source != domain.AuthSourceGitHubCLI {
		t.Errorf("source = %v, want GitHubCLI", status.Source)
	}
}

func TestConnectVerifyTrueFailsOnGetUserFailure(t *testing.T) {
	port := &stubPort{userErr: errors.New("boom")}
	svc := service.NewAuthService(port, &stubSource{token: "tok"}, service.AuthConfig{})

	_, _, err := svc.ConnectFromCLI(context.Background(), "gh", true)
	if err == nil {
		t.Fatal("ConnectFromCLI(verify=true) succeeded, want error")
	}
	// The failed verification must not leave the service authenticated.
	status, _ := svc.GetStatus(context.Background())
	if status.Authenticated {
		t.Errorf("status.Authenticated = true after failed verify")
	}
}

func TestConnectInvalidatesCacheOnAccountChange(t *testing.T) {
	port := &stubPort{user: &domain.GitHubUser{Login: "dave"}}
	svc := service.NewAuthService(port, &stubSource{token: "tok"}, service.AuthConfig{})
	if _, _, err := svc.ConnectFromCLI(context.Background(), "gh", true); err != nil {
		t.Fatalf("first connect: %v", err)
	}

	port.user = &domain.GitHubUser{Login: "eve"}
	if _, _, err := svc.ConnectFromCLI(context.Background(), "gh", true); err != nil {
		t.Fatalf("second connect: %v", err)
	}

	found := false
	for _, login := range port.invalidated {
		if login == "dave" {
			found = true
		}
	}
	if !found {
		t.Errorf("invalidated = %v, want dave", port.invalidated)
	}
}

func TestListReposRequiresAuth(t *testing.T) {
	svc := service.NewAuthService(&stubPort{}, &stubSource{token: "tok"}, service.AuthConfig{})

	_, err := svc.ListRepos(context.Background(), domain.ListReposRequest{})
	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want domain.AppError", err)
	}
	if appErr.Code != domain.ErrCodeUnauthenticated {
		t.Errorf("code = %q, want %q", appErr.Code, domain.ErrCodeUnauthenticated)
	}
}

func TestListReposResolvesLoginAndDelegates(t *testing.T) {
	port := &stubPort{
		userErr:    errors.New("no profile yet"),
		listResult: &domain.ListReposResult{Repos: []domain.GitHubRepo{{Name: "r"}}},
	}
	svc := service.NewAuthService(port, &stubSource{token: "tok"}, service.AuthConfig{})
	// Connect without verification: login stays unknown.
	if _, _, err := svc.ConnectFromCLI(context.Background(), "gh", false); err != nil {
		t.Fatalf("connect: %v", err)
	}

	// Now GetUser succeeds so ListRepos can resolve the account login.
	port.userErr = nil
	port.user = &domain.GitHubUser{Login: "dave"}
	result, err := svc.ListRepos(context.Background(), domain.ListReposRequest{Page: 2})
	if err != nil {
		t.Fatalf("ListRepos: %v", err)
	}
	if len(result.Repos) != 1 {
		t.Fatalf("repos = %+v", result.Repos)
	}
	if port.gotToken != "tok" {
		t.Errorf("port token = %q, want tok", port.gotToken)
	}
	if port.gotLogin != "dave" {
		t.Errorf("port login = %q, want dave (resolved via GetUser)", port.gotLogin)
	}
}

func TestLogoutClears(t *testing.T) {
	port := &stubPort{user: &domain.GitHubUser{Login: "dave"}}
	svc := service.NewAuthService(port, &stubSource{token: "tok"}, service.AuthConfig{})
	if _, _, err := svc.ConnectFromCLI(context.Background(), "gh", true); err != nil {
		t.Fatalf("connect: %v", err)
	}

	if err := svc.Logout(context.Background()); err != nil {
		t.Fatalf("Logout: %v", err)
	}

	status, err := svc.GetStatus(context.Background())
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	if status.Authenticated || status.Source != domain.AuthSourceNone {
		t.Errorf("status after logout = %+v", status)
	}

	_, err = svc.ListRepos(context.Background(), domain.ListReposRequest{})
	var appErr domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeUnauthenticated {
		t.Errorf("ListRepos after logout = %v, want UNAUTHENTICATED", err)
	}

	if len(port.invalidated) == 0 || port.invalidated[len(port.invalidated)-1] != "" {
		t.Errorf("invalidated = %v, want final clear-all (\"\")", port.invalidated)
	}
}
