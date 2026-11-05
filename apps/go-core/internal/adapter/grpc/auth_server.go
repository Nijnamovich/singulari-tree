package grpc

import (
	"context"

	googlegrpc "google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	singularitreev1 "github.com/SingulariTree/go-core/gen/go/singularitree/v1"
	"github.com/SingulariTree/go-core/internal/domain"
	"github.com/SingulariTree/go-core/internal/service"
)

// AuthServer is the gRPC transport adapter for singularitree.v1.Auth.
//
// It embeds UnimplementedAuthServer so the retained OAuth RPCs
// (StartGitHubOAuth, ExchangeCode, GetGitHubUser) stay Unimplemented; only the
// gh-CLI vertical is wired (github-real-data-guide.md §5.1, §12d).
type AuthServer struct {
	singularitreev1.UnimplementedAuthServer

	authSvc *service.AuthService
}

// NewAuthServer creates the Auth gRPC adapter.
func NewAuthServer(authSvc *service.AuthService) *AuthServer {
	return &AuthServer{authSvc: authSvc}
}

// Register registers the Auth service implementation on a grpc.Server.
func (s *AuthServer) Register(gs *googlegrpc.Server) {
	singularitreev1.RegisterAuthServer(gs, s)
}

// GetAuthStatus returns the current auth status.
func (s *AuthServer) GetAuthStatus(ctx context.Context, _ *singularitreev1.GetAuthStatusRequest) (*singularitreev1.GetAuthStatusResponse, error) {
	if s.authSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "auth service not configured")
	}
	st, err := s.authSvc.GetStatus(ctx)
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.GetAuthStatusResponse{
		Authenticated: st.Authenticated,
		Login:         st.AccountLogin,
		Status:        authStatusToProto(st),
	}, nil
}

// ConnectGitHubFromCLI obtains a token from `gh auth token` and returns the
// resulting auth status (and user when verification succeeded).
func (s *AuthServer) ConnectGitHubFromCLI(ctx context.Context, req *singularitreev1.ConnectGitHubFromCLIRequest) (*singularitreev1.ConnectGitHubFromCLIResponse, error) {
	if s.authSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "auth service not configured")
	}
	ghBinary := req.GetGhBinary()
	if ghBinary == "" {
		ghBinary = "gh"
	}
	st, user, err := s.authSvc.ConnectFromCLI(ctx, ghBinary, req.GetVerify())
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.ConnectGitHubFromCLIResponse{
		Status: authStatusToProto(st),
		User:   githubUserToProto(user),
	}, nil
}

// ListGitHubRepos lists the authenticated account's repositories.
func (s *AuthServer) ListGitHubRepos(ctx context.Context, req *singularitreev1.ListGitHubReposRequest) (*singularitreev1.ListGitHubReposResponse, error) {
	if s.authSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "auth service not configured")
	}
	result, err := s.authSvc.ListRepos(ctx, domain.ListReposRequest{
		PerPage:     req.GetPerPage(),
		Page:        req.GetPage(),
		Sort:        req.GetSort(),
		Direction:   req.GetDirection(),
		Affiliation: req.GetAffiliation(),
		Visibility:  req.GetVisibility(),
		Type:        req.GetType(),
	})
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	out := &singularitreev1.ListGitHubReposResponse{
		Repos: make([]*singularitreev1.GitHubRepo, 0, len(result.Repos)),
	}
	for i := range result.Repos {
		out.Repos = append(out.Repos, githubRepoToProto(result.Repos[i]))
	}
	out.PageInfo = pageInfoToProto(result.PageInfo)
	out.RateLimit = rateLimitToProto(result.RateLimit)
	return out, nil
}

// Logout clears the in-memory token and all cached accounts.
func (s *AuthServer) Logout(ctx context.Context, _ *singularitreev1.LogoutRequest) (*singularitreev1.LogoutResponse, error) {
	if s.authSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "auth service not configured")
	}
	if err := s.authSvc.Logout(ctx); err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.LogoutResponse{}, nil
}
