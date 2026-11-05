package service

import (
	"context"
	"sync"

	"github.com/SingulariTree/go-core/internal/domain"
)

// TokenSource obtains a GitHub token from the `gh` CLI. It is satisfied by
// *ghcli.TokenSource, keeping the service decoupled from the adapter.
type TokenSource interface {
	Token(ctx context.Context, ghBinary string) (string, error)
}

// AuthConfig carries the resolved configuration the AuthService needs for
// diagnostics (github-real-data-guide.md §13 item 1).
type AuthConfig struct {
	GhSearchPath string
}

// AuthService orchestrates the token source and the GitHub port
// (github-real-data-guide.md §3, §7 HS1). It owns the in-memory token and the
// auth status; the token never leaves the core.
type AuthService struct {
	port   domain.AuthPort
	source TokenSource
	cfg    AuthConfig

	mu           sync.Mutex
	store        *MemoryTokenStore
	status       *domain.AuthStatus
	accountLogin string
	rateLimit    *domain.RateLimit
}

// NewAuthService creates an AuthService.
func NewAuthService(port domain.AuthPort, source TokenSource, cfg AuthConfig) *AuthService {
	return &AuthService{
		port:   port,
		source: source,
		cfg:    cfg,
		store:  NewMemoryTokenStore(),
	}
}

// ConnectFromCLI obtains a token via `gh auth token`, stores it in memory and
// (optionally) verifies it with GET /user. verify=true makes GetUser fatal;
// verify=false degrades to an unverified connection.
func (s *AuthService) ConnectFromCLI(ctx context.Context, ghBinary string, verify bool) (*domain.AuthStatus, *domain.GitHubUser, error) {
	if s.source == nil {
		return nil, nil, domain.AppError{
			Code:    domain.ErrCodeGHCLINotFound,
			Message: "gh CLI token source not configured",
		}
	}

	token, err := s.source.Token(ctx, ghBinary)
	if err != nil {
		return nil, nil, err
	}

	// GetUser is a network call: never hold s.mu across it.
	var user *domain.GitHubUser
	if s.port != nil {
		user, err = s.port.GetUser(ctx, token)
		if err != nil {
			if verify {
				s.store.Clear()
				return nil, nil, err
			}
			user = nil
		}
	}
	login := ""
	if user != nil {
		login = user.Login
	}

	status := &domain.AuthStatus{
		Authenticated: true,
		Source:        domain.AuthSourceGitHubCLI,
		AccountLogin:  login,
	}
	if user != nil {
		status.Name = user.Name
		status.AvatarURL = user.AvatarURL
		status.Email = user.Email
	}

	// Finalize under one lock section: the previous token/login used for cache
	// invalidation are read here, at the write, not before the network call, so
	// a concurrent connect cannot make us compare against a stale snapshot.
	// Concurrent connects remain benign last-writer-wins: the last writer's
	// account/token ends up in memory, and any interleaving can at worst
	// over-invalidate the account-scoped ETag cache (the loser's key is cleared
	// too) — it can never serve another account's data.
	s.mu.Lock()
	oldToken := s.store.Get()
	oldLogin := s.accountLogin
	if s.rateLimit != nil {
		status.RateLimit = s.rateLimit
	}
	s.store.Set(token)
	s.status = status
	s.accountLogin = login
	s.mu.Unlock()

	// A changed account or token must not serve another account's cached repos.
	if oldLogin != login || oldToken != token {
		s.invalidate(oldLogin)
	}

	return status, user, nil
}

// GetStatus returns the current auth status. With no token it reports
// {Authenticated:false, Source:NONE}.
func (s *AuthService) GetStatus(_ context.Context) (*domain.AuthStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.store.IsAuthenticated() {
		return &domain.AuthStatus{Authenticated: false, Source: domain.AuthSourceNone}, nil
	}
	if s.status != nil {
		cp := *s.status
		return &cp, nil
	}
	return &domain.AuthStatus{
		Authenticated: true,
		Source:        domain.AuthSourceGitHubCLI,
		AccountLogin:  s.accountLogin,
	}, nil
}

// ListRepos lists the authenticated account's GitHub repositories. It requires
// a token; when the account login is unknown it is resolved with GetUser first.
func (s *AuthService) ListRepos(ctx context.Context, req domain.ListReposRequest) (*domain.ListReposResult, error) {
	token := s.store.Get()
	if token == "" {
		return nil, domain.AppError{Code: domain.ErrCodeUnauthenticated, Message: "not authenticated"}
	}
	if s.port == nil {
		return nil, domain.AppError{Code: domain.ErrCodeGitHubAPIError, Message: "GitHub API not configured"}
	}

	login := s.accountLoginLocked()
	if login == "" {
		user, err := s.port.GetUser(ctx, token)
		if err != nil {
			return nil, err
		}
		if user != nil {
			login = user.Login
			s.mu.Lock()
			s.accountLogin = login
			if s.status != nil {
				s.status.AccountLogin = login
			}
			s.mu.Unlock()
		}
	}

	result, err := s.port.ListRepos(ctx, token, login, req)
	if err != nil {
		return nil, err
	}
	if result != nil && result.RateLimit != nil {
		s.mu.Lock()
		s.rateLimit = result.RateLimit
		s.mu.Unlock()
	}
	return result, nil
}

// Logout clears the token, status and every cached account.
func (s *AuthService) Logout(_ context.Context) error {
	s.store.Clear()
	s.mu.Lock()
	s.status = nil
	s.accountLogin = ""
	s.rateLimit = nil
	s.mu.Unlock()
	s.invalidate("")
	return nil
}

func (s *AuthService) accountLoginLocked() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.accountLogin
}

func (s *AuthService) invalidate(accountLogin string) {
	if s.port != nil {
		s.port.InvalidateCache(accountLogin)
	}
}

// MemoryTokenStore is the concrete in-memory domain.TokenStore, guarded by a
// mutex so concurrent RPC handlers do not race.
type MemoryTokenStore struct {
	mu    sync.Mutex
	token string
}

// NewMemoryTokenStore creates an empty MemoryTokenStore.
func NewMemoryTokenStore() *MemoryTokenStore { return &MemoryTokenStore{} }

var _ domain.TokenStore = (*MemoryTokenStore)(nil)

// Set stores the token.
func (m *MemoryTokenStore) Set(token string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.token = token
}

// Get returns the stored token ("" when unset).
func (m *MemoryTokenStore) Get() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.token
}

// Clear drops the stored token.
func (m *MemoryTokenStore) Clear() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.token = ""
}

// IsAuthenticated reports whether a non-empty token is stored.
func (m *MemoryTokenStore) IsAuthenticated() bool {
	return m.Get() != ""
}
