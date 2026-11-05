// Package github implements domain.AuthPort over the GitHub REST API
// (https://api.github.com). The network owner is the Go core: the http.Client
// and base URL are injectable, and an in-memory ETag cache minimises rate-limit
// consumption (github-real-data-guide.md §4, §12b/§12c).
package github

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/SingulariTree/go-core/internal/domain"
)

const (
	defaultBaseURL = "https://api.github.com"
	defaultPerPage = 30
	maxPerPage     = 100
)

// Adapter implements domain.AuthPort.
type Adapter struct {
	client  *http.Client
	baseURL string

	mu    sync.Mutex
	cache map[string]cacheEntry
}

// cacheEntry is one account's last repos response. requestQuery pins the cache
// to a specific query so a different page/filter never serves the wrong body.
// TODO(HS4): persist to SQLite metadata cache (migration explicitly deferred).
type cacheEntry struct {
	etag         string
	body         []byte
	requestQuery string
}

// NewAdapter creates an Adapter targeting https://api.github.com.
func NewAdapter(client *http.Client) *Adapter {
	return NewAdapterWithBaseURL(client, defaultBaseURL)
}

// NewAdapterWithBaseURL creates an Adapter with an explicit base URL (tests).
func NewAdapterWithBaseURL(client *http.Client, baseURL string) *Adapter {
	if client == nil {
		client = http.DefaultClient
	}
	return &Adapter{
		client:  client,
		baseURL: strings.TrimRight(baseURL, "/"),
		cache:   make(map[string]cacheEntry),
	}
}

var _ domain.AuthPort = (*Adapter)(nil)

// GetUser returns the authenticated account profile (GET /user).
func (a *Adapter) GetUser(ctx context.Context, token string) (*domain.GitHubUser, error) {
	const path = "/user"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.baseURL+path, nil)
	if err != nil {
		return nil, apiError(domain.ErrCodeGitHubAPIError, "GitHub request could not be built", path, 0, nil)
	}
	a.setHeaders(req, token)

	resp, err := a.client.Do(req)
	if err != nil {
		return nil, apiError(domain.ErrCodeGitHubAPIError, "GitHub API is unreachable", path, 0, nil)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)

	switch resp.StatusCode {
	case http.StatusOK:
		var raw ghUser
		if err := json.Unmarshal(body, &raw); err != nil {
			return nil, apiError(domain.ErrCodeGitHubAPIError, "GitHub user response could not be parsed", path, resp.StatusCode, resp.Header)
		}
		return &domain.GitHubUser{
			ID:        raw.ID,
			Login:     raw.Login,
			Name:      raw.Name,
			AvatarURL: raw.AvatarURL,
			Email:     raw.Email,
			HTMLURL:   raw.HTMLURL,
		}, nil
	case http.StatusUnauthorized:
		return nil, apiError(domain.ErrCodeGitHubTokenInvalid, "GitHub token is invalid", path, resp.StatusCode, resp.Header)
	case http.StatusForbidden, http.StatusTooManyRequests:
		return nil, apiError(domain.ErrCodeGitHubRateLimited, "GitHub rate limit exceeded", path, resp.StatusCode, resp.Header)
	default:
		return nil, apiError(domain.ErrCodeGitHubAPIError, "GitHub API request failed", path, resp.StatusCode, resp.Header)
	}
}

// ListRepos returns one page of the authenticated account's repositories
// (GET /user/repos), with pagination and rate-limit metadata.
func (a *Adapter) ListRepos(ctx context.Context, token, accountLogin string, req domain.ListReposRequest) (*domain.ListReposResult, error) {
	query := buildQuery(req)
	return a.listRepos(ctx, token, accountLogin, query, true, true)
}

// InvalidateCache drops one account's cached response, or every account when
// accountLogin is empty (github-real-data-guide.md §12c).
func (a *Adapter) InvalidateCache(accountLogin string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if accountLogin == "" {
		a.cache = make(map[string]cacheEntry)
		return
	}
	delete(a.cache, accountLogin)
}

func (a *Adapter) listRepos(ctx context.Context, token, accountLogin string, query url.Values, sendConditional, allowRetry bool) (*domain.ListReposResult, error) {
	const path = "/user/repos"
	queryStr := query.Encode()

	etag, cachedBody, haveCache := a.cacheLookup(accountLogin, queryStr)
	conditional := ""
	if sendConditional && haveCache && etag != "" {
		conditional = etag
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.baseURL+path+"?"+queryStr, nil)
	if err != nil {
		return nil, apiError(domain.ErrCodeGitHubAPIError, "GitHub request could not be built", path, 0, nil)
	}
	a.setHeaders(req, token)
	if conditional != "" {
		req.Header.Set("If-None-Match", conditional)
	}

	resp, err := a.client.Do(req)
	if err != nil {
		return nil, apiError(domain.ErrCodeGitHubAPIError, "GitHub API is unreachable", path, 0, nil)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)

	switch {
	case resp.StatusCode == http.StatusNotModified:
		// A 304 carries no body: honor it only with a usable cached body.
		if haveCache && len(cachedBody) > 0 {
			return parseRepos(cachedBody, resp, query)
		}
		// No cached body: re-issue unconditionally once.
		if allowRetry {
			return a.listRepos(ctx, token, accountLogin, query, false, false)
		}
		return nil, apiError(domain.ErrCodeGitHubAPIError, "GitHub returned 304 without a cached body", path, resp.StatusCode, resp.Header)
	case resp.StatusCode == http.StatusOK:
		// Store atomically before parsing so a malformed body still leaves the
		// cache consistent with what the server sent.
		a.cacheStore(accountLogin, queryStr, resp.Header.Get("ETag"), body)
		return parseRepos(body, resp, query)
	case resp.StatusCode == http.StatusUnauthorized:
		return nil, apiError(domain.ErrCodeGitHubTokenInvalid, "GitHub token is invalid", path, resp.StatusCode, resp.Header)
	case resp.StatusCode == http.StatusForbidden, resp.StatusCode == http.StatusTooManyRequests:
		return nil, apiError(domain.ErrCodeGitHubRateLimited, "GitHub rate limit exceeded", path, resp.StatusCode, resp.Header)
	default:
		return nil, apiError(domain.ErrCodeGitHubAPIError, "GitHub API request failed", path, resp.StatusCode, resp.Header)
	}
}

func (a *Adapter) setHeaders(req *http.Request, token string) {
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "SingulariTree")
}

func (a *Adapter) cacheLookup(accountLogin, queryStr string) (etag string, body []byte, ok bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	entry, found := a.cache[accountLogin]
	if !found || entry.requestQuery != queryStr {
		return "", nil, false
	}
	return entry.etag, entry.body, true
}

func (a *Adapter) cacheStore(accountLogin, queryStr, etag string, body []byte) {
	stored := make([]byte, len(body))
	copy(stored, body)
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cache[accountLogin] = cacheEntry{etag: etag, body: stored, requestQuery: queryStr}
}

// buildQuery applies the defaults frozen in github-real-data-guide.md §12b:
// sort=full_name (stable page edges), direction=asc, page=1, per_page=30 clamped
// to <=100. affiliation/visibility/type are included only when non-empty.
func buildQuery(req domain.ListReposRequest) url.Values {
	perPage := req.PerPage
	if perPage == 0 {
		perPage = defaultPerPage
	}
	if perPage > maxPerPage {
		perPage = maxPerPage
	}
	page := req.Page
	if page == 0 {
		page = 1
	}
	sort := req.Sort
	if sort == "" {
		sort = "full_name"
	}
	direction := req.Direction
	if direction == "" {
		direction = "asc"
	}

	q := url.Values{}
	q.Set("per_page", strconv.FormatUint(uint64(perPage), 10))
	q.Set("page", strconv.FormatUint(uint64(page), 10))
	q.Set("sort", sort)
	q.Set("direction", direction)
	if req.Affiliation != "" {
		q.Set("affiliation", req.Affiliation)
	}
	if req.Visibility != "" {
		q.Set("visibility", req.Visibility)
	}
	if req.Type != "" {
		q.Set("type", req.Type)
	}
	return q
}

func parseRepos(body []byte, resp *http.Response, query url.Values) (*domain.ListReposResult, error) {
	var raw []ghRepo
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, apiError(domain.ErrCodeGitHubAPIError, "GitHub repos response could not be parsed", "/user/repos", resp.StatusCode, resp.Header)
	}
	repos := make([]domain.GitHubRepo, 0, len(raw))
	for i := range raw {
		repos = append(repos, raw[i].toDomain())
	}

	next := parseNextPage(resp.Header.Get("Link"))
	return &domain.ListReposResult{
		Repos: repos,
		PageInfo: domain.PageInfo{
			Page:     uint32(parseUint(query.Get("page"), 0)),
			PerPage:  uint32(parseUint(query.Get("per_page"), 0)),
			NextPage: next,
			HasMore:  next > 0,
			Total:    0, // best-effort: /user/repos does not provide a total
		},
		RateLimit: parseRateLimit(resp.Header),
	}, nil
}

// parseNextPage extracts page from the Link header's rel="next" URL, or 0 when
// absent (github-real-data-guide.md §4).
func parseNextPage(link string) uint32 {
	for _, part := range strings.Split(link, ",") {
		sections := strings.Split(part, ";")
		if len(sections) < 2 {
			continue
		}
		urlPart := strings.TrimSpace(sections[0])
		if !strings.HasPrefix(urlPart, "<") || !strings.HasSuffix(urlPart, ">") {
			continue
		}
		isNext := false
		for _, sec := range sections[1:] {
			if strings.TrimSpace(sec) == `rel="next"` {
				isNext = true
				break
			}
		}
		if !isNext {
			continue
		}
		u, err := url.Parse(strings.TrimSuffix(strings.TrimPrefix(urlPart, "<"), ">"))
		if err != nil {
			return 0
		}
		return uint32(parseUint(u.Query().Get("page"), 0))
	}
	return 0
}

// parseRateLimit maps X-RateLimit-* headers to domain.RateLimit. It returns nil
// when no rate-limit headers are present.
func parseRateLimit(h http.Header) *domain.RateLimit {
	limit := h.Get("X-RateLimit-Limit")
	remaining := h.Get("X-RateLimit-Remaining")
	reset := h.Get("X-RateLimit-Reset")
	if limit == "" && remaining == "" && reset == "" {
		return nil
	}
	rl := &domain.RateLimit{
		Resource:  "core",
		Limit:     uint32(parseUint(limit, 0)),
		Remaining: uint32(parseUint(remaining, 0)),
		Reset:     int64(parseUint(reset, 0)),
	}
	if rl.Reset > 0 {
		rl.ResetAt = time.Unix(rl.Reset, 0).UTC().Format(time.RFC3339)
	}
	return rl
}

// apiError builds a structured AppError. It never includes a response body;
// details are limited to status/path and, for rate limiting, the reset epoch.
func apiError(code, message, path string, status int, h http.Header) domain.AppError {
	details := map[string]string{"path": path}
	if status > 0 {
		details["status"] = strconv.Itoa(status)
	}
	if h != nil {
		if reset := h.Get("X-RateLimit-Reset"); reset != "" {
			details["reset"] = reset
		}
	}
	return domain.AppError{Code: code, Message: message, Details: details}
}

func parseUint(s string, fallback uint64) uint64 {
	if s == "" {
		return fallback
	}
	v, err := strconv.ParseUint(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return fallback
	}
	return v
}

// --- GitHub JSON shapes ---

type ghUser struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
	Email     string `json:"email"`
	HTMLURL   string `json:"html_url"`
}

type ghRepo struct {
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
	Owner           ghOwner  `json:"owner"`
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
	License         *ghLic   `json:"license"`
	IsTemplate      bool     `json:"is_template"`
	Homepage        string   `json:"homepage"`
}

type ghOwner struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
}

type ghLic struct {
	SPDXID string `json:"spdx_id"`
}

func (r ghRepo) toDomain() domain.GitHubRepo {
	repo := domain.GitHubRepo{
		ID:              r.ID,
		Name:            r.Name,
		FullName:        r.FullName,
		Private:         r.Private,
		HTMLURL:         r.HTMLURL,
		Description:     r.Description,
		Language:        r.Language,
		StargazersCount: r.StargazersCount,
		UpdatedAt:       r.UpdatedAt,
		NodeID:          r.NodeID,
		DefaultBranch:   r.DefaultBranch,
		OwnerLogin:      r.Owner.Login,
		OwnerAvatarURL:  r.Owner.AvatarURL,
		Visibility:      r.Visibility,
		Fork:            r.Fork,
		Archived:        r.Archived,
		Disabled:        r.Disabled,
		CloneURL:        r.CloneURL,
		SSHURL:          r.SSHURL,
		GitURL:          r.GitURL,
		PushedAt:        r.PushedAt,
		CreatedAt:       r.CreatedAt,
		ForksCount:      r.ForksCount,
		OpenIssuesCount: r.OpenIssuesCount,
		Topics:          r.Topics,
		IsTemplate:      r.IsTemplate,
		Homepage:        r.Homepage,
	}
	if r.License != nil {
		repo.LicenseSPDXID = r.License.SPDXID
	}
	return repo
}
