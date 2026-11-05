package grpc_test

import (
	"context"
	"encoding/json"
	"net"
	"testing"

	googlegrpc "google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	singularitreev1 "github.com/SingulariTree/go-core/gen/go/singularitree/v1"
	grpcadapter "github.com/SingulariTree/go-core/internal/adapter/grpc"
	"github.com/SingulariTree/go-core/internal/domain"
	"github.com/SingulariTree/go-core/internal/service"
)

type fakeAuthSource struct {
	token string
	err   error
}

func (s *fakeAuthSource) Token(context.Context, string) (string, error) { return s.token, s.err }

type fakeAuthPort struct {
	user    *domain.GitHubUser
	userErr error
}

func (p *fakeAuthPort) GetUser(context.Context, string) (*domain.GitHubUser, error) {
	return p.user, p.userErr
}

func (p *fakeAuthPort) ListRepos(context.Context, string, string, domain.ListReposRequest) (*domain.ListReposResult, error) {
	return &domain.ListReposResult{Repos: []domain.GitHubRepo{{ID: 1, Name: "repo"}}}, nil
}

func (p *fakeAuthPort) InvalidateCache(string) {}

// startAuthServer boots a gRPC server exposing only the Auth service (no token
// interceptor) and returns its address.
func startAuthServer(t *testing.T, port domain.AuthPort, src service.TokenSource) string {
	t.Helper()
	authSvc := service.NewAuthService(port, src, service.AuthConfig{})
	srv := grpcadapter.NewAuthServer(authSvc)
	gs := googlegrpc.NewServer()
	srv.Register(gs)

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() { _ = gs.Serve(lis) }()
	t.Cleanup(gs.Stop)
	return lis.Addr().String()
}

func dialAuth(t *testing.T, addr string) singularitreev1.AuthClient {
	t.Helper()
	conn, err := googlegrpc.NewClient(addr, googlegrpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return singularitreev1.NewAuthClient(conn)
}

func TestAuthServerConnectRoundTrip(t *testing.T) {
	port := &fakeAuthPort{user: &domain.GitHubUser{ID: 1, Login: "dave", Name: "Dave", AvatarURL: "av", Email: "d@x"}}
	addr := startAuthServer(t, port, &fakeAuthSource{token: "tok"})
	client := dialAuth(t, addr)

	resp, err := client.ConnectGitHubFromCLI(context.Background(), &singularitreev1.ConnectGitHubFromCLIRequest{
		GhBinary: "gh",
		Verify:   true,
	})
	if err != nil {
		t.Fatalf("ConnectGitHubFromCLI: %v", err)
	}
	st := resp.GetStatus()
	if st == nil || !st.GetAuthenticated() {
		t.Fatalf("status = %+v", st)
	}
	if st.GetSource() != singularitreev1.AuthSource_AUTH_SOURCE_GITHUB_CLI {
		t.Errorf("source = %v, want GITHUB_CLI", st.GetSource())
	}
	if st.GetAccountLogin() != "dave" {
		t.Errorf("account_login = %q, want dave", st.GetAccountLogin())
	}
	if resp.GetUser().GetLogin() != "dave" {
		t.Errorf("user.login = %q, want dave", resp.GetUser().GetLogin())
	}

	// GetAuthStatus reflects the same in-memory status.
	statusResp, err := client.GetAuthStatus(context.Background(), &singularitreev1.GetAuthStatusRequest{})
	if err != nil {
		t.Fatalf("GetAuthStatus: %v", err)
	}
	if !statusResp.GetAuthenticated() || statusResp.GetLogin() != "dave" {
		t.Errorf("GetAuthStatus = %+v", statusResp)
	}
}

func TestAuthServerListRepos(t *testing.T) {
	port := &fakeAuthPort{user: &domain.GitHubUser{Login: "dave"}}
	addr := startAuthServer(t, port, &fakeAuthSource{token: "tok"})
	client := dialAuth(t, addr)

	if _, err := client.ConnectGitHubFromCLI(context.Background(), &singularitreev1.ConnectGitHubFromCLIRequest{}); err != nil {
		t.Fatalf("ConnectGitHubFromCLI: %v", err)
	}
	resp, err := client.ListGitHubRepos(context.Background(), &singularitreev1.ListGitHubReposRequest{})
	if err != nil {
		t.Fatalf("ListGitHubRepos: %v", err)
	}
	if len(resp.GetRepos()) != 1 || resp.GetRepos()[0].GetName() != "repo" {
		t.Fatalf("repos = %+v", resp.GetRepos())
	}
	if resp.GetPageInfo() == nil {
		t.Error("page_info is nil")
	}
}

func TestAuthServerListReposRequiresAuth(t *testing.T) {
	addr := startAuthServer(t, &fakeAuthPort{}, &fakeAuthSource{token: "tok"})
	client := dialAuth(t, addr)

	var trailer metadata.MD
	_, err := client.ListGitHubRepos(context.Background(), &singularitreev1.ListGitHubReposRequest{}, googlegrpc.Trailer(&trailer))
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("code = %v, want Unauthenticated", status.Code(err))
	}
	if got := trailer.Get("x-app-error-code"); len(got) == 0 || got[0] != domain.ErrCodeUnauthenticated {
		t.Errorf("trailer code = %v, want [UNAUTHENTICATED]", got)
	}
}

func TestAuthServerErrorCodeAndDetailsTrailers(t *testing.T) {
	src := &fakeAuthSource{err: domain.AppError{
		Code:    domain.ErrCodeGHCLINotFound,
		Message: "gh CLI not found",
		Details: map[string]string{"binary": "gh", "searched_path": "/usr/bin:/bin"},
	}}
	addr := startAuthServer(t, &fakeAuthPort{}, src)
	client := dialAuth(t, addr)

	var trailer metadata.MD
	_, err := client.ConnectGitHubFromCLI(context.Background(), &singularitreev1.ConnectGitHubFromCLIRequest{}, googlegrpc.Trailer(&trailer))
	if status.Code(err) != codes.NotFound {
		t.Fatalf("code = %v, want NotFound (err=%v)", status.Code(err), err)
	}
	if got := trailer.Get("x-app-error-code"); len(got) == 0 || got[0] != domain.ErrCodeGHCLINotFound {
		t.Fatalf("trailer code = %v, want [GH_CLI_NOT_FOUND]", got)
	}

	details := trailer.Get("x-app-error-details")
	if len(details) == 0 {
		t.Fatal("x-app-error-details trailer missing")
	}
	var decoded map[string]string
	if err := json.Unmarshal([]byte(details[0]), &decoded); err != nil {
		t.Fatalf("details JSON invalid: %v (%q)", err, details[0])
	}
	if decoded["binary"] != "gh" || decoded["searched_path"] != "/usr/bin:/bin" {
		t.Errorf("decoded details = %v", decoded)
	}
}

func TestAuthServerLogout(t *testing.T) {
	port := &fakeAuthPort{user: &domain.GitHubUser{Login: "dave"}}
	addr := startAuthServer(t, port, &fakeAuthSource{token: "tok"})
	client := dialAuth(t, addr)

	if _, err := client.ConnectGitHubFromCLI(context.Background(), &singularitreev1.ConnectGitHubFromCLIRequest{}); err != nil {
		t.Fatalf("ConnectGitHubFromCLI: %v", err)
	}
	if _, err := client.Logout(context.Background(), &singularitreev1.LogoutRequest{}); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	statusResp, err := client.GetAuthStatus(context.Background(), &singularitreev1.GetAuthStatusRequest{})
	if err != nil {
		t.Fatalf("GetAuthStatus: %v", err)
	}
	if statusResp.GetAuthenticated() {
		t.Errorf("GetAuthStatus after logout = %+v", statusResp)
	}
	if statusResp.GetStatus().GetSource() != singularitreev1.AuthSource_AUTH_SOURCE_NONE {
		t.Errorf("source after logout = %v, want NONE", statusResp.GetStatus().GetSource())
	}
}
