package domain

import "context"

// GitHubUser mirrors auth.proto GitHubUser. Email may be empty: the frozen gh
// token scopes (gist, read:org, repo, workflow) omit read:user
// (github-real-data-guide.md §8).
type GitHubUser struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
	Email     string `json:"email"`
	HTMLURL   string `json:"html_url"`
}

// GitHubRepo mirrors auth.proto GitHubRepo. Fields 1-9 are the original subset;
// fields 10-28 are additive real-data fields (github-real-data-guide.md §5.1).
type GitHubRepo struct {
	ID              int64    `json:"id"`
	Name            string   `json:"name"`
	FullName        string   `json:"full_name"`
	Private         bool     `json:"private"`
	HTMLURL         string   `json:"html_url"`
	Description     string   `json:"description"`
	Language        string   `json:"language"`
	StargazersCount int32    `json:"stargazers_count"`
	UpdatedAt       string   `json:"updated_at"`
	NodeID          string   `json:"node_id"`
	DefaultBranch   string   `json:"default_branch"`
	OwnerLogin      string   `json:"owner_login"`
	OwnerAvatarURL  string   `json:"owner_avatar_url"`
	Visibility      string   `json:"visibility"`
	Fork            bool     `json:"fork"`
	Archived        bool     `json:"archived"`
	Disabled        bool     `json:"disabled"`
	CloneURL        string   `json:"clone_url"`
	SSHURL          string   `json:"ssh_url"`
	GitURL          string   `json:"git_url"`
	PushedAt        string   `json:"pushed_at"`
	CreatedAt       string   `json:"created_at"`
	ForksCount      int32    `json:"forks_count"`
	OpenIssuesCount int32    `json:"open_issues_count"`
	Topics          []string `json:"topics"`
	LicenseSPDXID   string   `json:"license_spdx_id"`
	IsTemplate      bool     `json:"is_template"`
	Homepage        string   `json:"homepage"`
}

// PageInfo mirrors auth.proto PageInfo. Total is best-effort: /user/repos omits
// it, so 0 means unknown (github-real-data-guide.md §12b).
type PageInfo struct {
	Page     uint32
	PerPage  uint32
	NextPage uint32 // 0 == no Link rel="next"
	HasMore  bool
	Total    uint32
}

// RateLimit mirrors auth.proto RateLimit (X-RateLimit-* headers).
type RateLimit struct {
	Resource  string
	Limit     uint32
	Remaining uint32
	Reset     int64  // epoch seconds
	ResetAt   string // RFC3339
}

// AuthSource mirrors auth.proto AuthSource.
type AuthSource int

const (
	AuthSourceUnspecified AuthSource = iota
	AuthSourceNone
	AuthSourceGitHubCLI
	AuthSourceOAuth
)

// AuthStatus mirrors auth.proto AuthStatus.
type AuthStatus struct {
	Authenticated bool
	Source        AuthSource
	AccountLogin  string
	Name          string
	AvatarURL     string
	Email         string
	Scopes        []string
	RateLimit     *RateLimit
}

// ListReposRequest carries the query knobs for GET /user/repos.
type ListReposRequest struct {
	PerPage     uint32
	Page        uint32
	Sort        string // created|updated|pushed|full_name
	Direction   string // asc|desc
	Affiliation string // owner,collaborator,organization_member
	Visibility  string // all|public|private
	Type        string // all|owner|public|private|member
}

// ListReposResult is the ListRepos return: the page of repos plus pagination
// and rate-limit metadata.
type ListReposResult struct {
	Repos     []GitHubRepo
	PageInfo  PageInfo
	RateLimit *RateLimit
}

// AuthPort is the driven port for the GitHub REST API (hexagonal). It is
// implemented by adapter/github over https://api.github.com with an injectable
// http.Client and base URL.
type AuthPort interface {
	GetUser(ctx context.Context, token string) (*GitHubUser, error)
	ListRepos(ctx context.Context, token, accountLogin string, req ListReposRequest) (*ListReposResult, error)
	// InvalidateCache drops the cached ETag/body for one account; an empty
	// accountLogin clears every account (github-real-data-guide.md §12c).
	InvalidateCache(accountLogin string)
}

// TokenStore holds the GitHub token in-memory (prototype). It is never exposed
// on the wire; later replaced by secure storage.
type TokenStore interface {
	Set(token string)
	Get() string
	Clear()
	IsAuthenticated() bool
}
