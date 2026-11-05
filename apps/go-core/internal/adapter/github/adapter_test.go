package github_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/SingulariTree/go-core/internal/adapter/github"
	"github.com/SingulariTree/go-core/internal/domain"
)

func TestGetUserParsesAndSetsHeaders(t *testing.T) {
	var gotHeaders http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/user" {
			t.Errorf("path = %q, want /user", r.URL.Path)
		}
		gotHeaders = r.Header.Clone()
		_, _ = io.WriteString(w, `{"id":1,"login":"dave","name":"Dave","avatar_url":"av","email":"d@x","html_url":"https://github.com/dave"}`)
	}))
	defer srv.Close()

	a := github.NewAdapterWithBaseURL(srv.Client(), srv.URL)
	user, err := a.GetUser(context.Background(), "tok")
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if user.ID != 1 || user.Login != "dave" || user.Name != "Dave" || user.AvatarURL != "av" || user.Email != "d@x" {
		t.Errorf("user = %+v", user)
	}
	if got := gotHeaders.Get("Authorization"); got != "Bearer tok" {
		t.Errorf("Authorization = %q", got)
	}
	if got := gotHeaders.Get("Accept"); got != "application/vnd.github+json" {
		t.Errorf("Accept = %q", got)
	}
	if got := gotHeaders.Get("X-GitHub-Api-Version"); got != "2022-11-28" {
		t.Errorf("X-GitHub-Api-Version = %q", got)
	}
	if got := gotHeaders.Get("User-Agent"); got != "SingulariTree" {
		t.Errorf("User-Agent = %q", got)
	}
}

func TestGetUserUnauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	a := github.NewAdapterWithBaseURL(srv.Client(), srv.URL)
	_, err := a.GetUser(context.Background(), "bad")
	assertCode(t, err, domain.ErrCodeGitHubTokenInvalid)
}

func TestListReposParsesAndMetadata(t *testing.T) {
	reset := int64(1700000000)
	var gotQuery map[string][]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/user/repos" {
			t.Errorf("path = %q, want /user/repos", r.URL.Path)
		}
		gotQuery = r.URL.Query()
		w.Header().Set("Link", `<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=5>; rel="last"`)
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Remaining", "4999")
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset, 10))
		_, _ = io.WriteString(w, `[{"id":1,"name":"repo","full_name":"dave/repo","private":true,"html_url":"h","description":"d","language":"Go","stargazers_count":7,"updated_at":"2024-01-02T03:04:05Z","node_id":"NODE","default_branch":"main","owner":{"login":"dave","avatar_url":"av"},"visibility":"private","fork":true,"archived":true,"disabled":false,"clone_url":"c","ssh_url":"s","git_url":"g","pushed_at":"2024-01-01T00:00:00Z","created_at":"2023-01-01T00:00:00Z","forks_count":2,"open_issues_count":3,"topics":["a","b"],"license":{"spdx_id":"MIT"},"is_template":true,"homepage":"https://x"}]`)
	}))
	defer srv.Close()

	a := github.NewAdapterWithBaseURL(srv.Client(), srv.URL)
	result, err := a.ListRepos(context.Background(), "tok", "dave", domain.ListReposRequest{})
	if err != nil {
		t.Fatalf("ListRepos: %v", err)
	}

	if got := gotQuery["sort"][0]; got != "full_name" {
		t.Errorf("sort = %q, want full_name", got)
	}
	if got := gotQuery["direction"][0]; got != "asc" {
		t.Errorf("direction = %q, want asc", got)
	}
	if got := gotQuery["page"][0]; got != "1" {
		t.Errorf("page = %q, want 1", got)
	}
	if got := gotQuery["per_page"][0]; got != "30" {
		t.Errorf("per_page = %q, want 30", got)
	}
	for _, absent := range []string{"affiliation", "visibility", "type"} {
		if _, ok := gotQuery[absent]; ok {
			t.Errorf("query unexpectedly includes %s", absent)
		}
	}

	if len(result.Repos) != 1 {
		t.Fatalf("repos len = %d, want 1", len(result.Repos))
	}
	r := result.Repos[0]
	checks := []struct {
		name string
		got  any
		want any
	}{
		{"id", r.ID, int64(1)},
		{"name", r.Name, "repo"},
		{"full_name", r.FullName, "dave/repo"},
		{"private", r.Private, true},
		{"stargazers", r.StargazersCount, int32(7)},
		{"node_id", r.NodeID, "NODE"},
		{"default_branch", r.DefaultBranch, "main"},
		{"owner_login", r.OwnerLogin, "dave"},
		{"owner_avatar", r.OwnerAvatarURL, "av"},
		{"visibility", r.Visibility, "private"},
		{"fork", r.Fork, true},
		{"archived", r.Archived, true},
		{"clone_url", r.CloneURL, "c"},
		{"ssh_url", r.SSHURL, "s"},
		{"git_url", r.GitURL, "g"},
		{"forks_count", r.ForksCount, int32(2)},
		{"open_issues", r.OpenIssuesCount, int32(3)},
		{"license", r.LicenseSPDXID, "MIT"},
		{"is_template", r.IsTemplate, true},
		{"homepage", r.Homepage, "https://x"},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %v, want %v", c.name, c.got, c.want)
		}
	}
	if len(r.Topics) != 2 || r.Topics[0] != "a" {
		t.Errorf("topics = %v, want [a b]", r.Topics)
	}

	pi := result.PageInfo
	if pi.Page != 1 || pi.PerPage != 30 || pi.NextPage != 2 || !pi.HasMore || pi.Total != 0 {
		t.Errorf("page info = %+v", pi)
	}

	rl := result.RateLimit
	if rl == nil {
		t.Fatal("rate limit is nil")
	}
	if rl.Resource != "core" || rl.Limit != 5000 || rl.Remaining != 4999 || rl.Reset != reset {
		t.Errorf("rate limit = %+v", rl)
	}
	if want := time.Unix(reset, 0).UTC().Format(time.RFC3339); rl.ResetAt != want {
		t.Errorf("ResetAt = %q, want %q", rl.ResetAt, want)
	}
}

func TestListReposClampsPerPageAndPassesFilters(t *testing.T) {
	var gotQuery map[string][]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query()
		_, _ = io.WriteString(w, `[]`)
	}))
	defer srv.Close()

	a := github.NewAdapterWithBaseURL(srv.Client(), srv.URL)
	_, err := a.ListRepos(context.Background(), "tok", "dave", domain.ListReposRequest{
		PerPage:     500,
		Page:        3,
		Sort:        "updated",
		Direction:   "desc",
		Affiliation: "owner,collaborator",
		Visibility:  "all",
		Type:        "public",
	})
	if err != nil {
		t.Fatalf("ListRepos: %v", err)
	}
	if got := gotQuery["per_page"][0]; got != "100" {
		t.Errorf("per_page = %q, want 100 (clamped)", got)
	}
	for k, want := range map[string]string{
		"page":        "3",
		"sort":        "updated",
		"direction":   "desc",
		"affiliation": "owner,collaborator",
		"visibility":  "all",
		"type":        "public",
	} {
		if got := gotQuery[k][0]; got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
}

func TestListReposConditionalRequestAnd304(t *testing.T) {
	var requests int
	var ifNoneMatch []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		ifNoneMatch = append(ifNoneMatch, r.Header.Get("If-None-Match"))
		if requests == 1 {
			w.Header().Set("ETag", `W/"abc"`)
			_, _ = io.WriteString(w, `[{"id":1,"name":"one"}]`)
			return
		}
		w.WriteHeader(http.StatusNotModified)
	}))
	defer srv.Close()

	a := github.NewAdapterWithBaseURL(srv.Client(), srv.URL)
	first, err := a.ListRepos(context.Background(), "tok", "dave", domain.ListReposRequest{})
	if err != nil {
		t.Fatalf("first ListRepos: %v", err)
	}
	if len(first.Repos) != 1 || first.Repos[0].Name != "one" {
		t.Fatalf("first repos = %+v", first.Repos)
	}

	second, err := a.ListRepos(context.Background(), "tok", "dave", domain.ListReposRequest{})
	if err != nil {
		t.Fatalf("second ListRepos: %v", err)
	}
	if len(second.Repos) != 1 || second.Repos[0].Name != "one" {
		t.Fatalf("second repos = %+v, want cached body", second.Repos)
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2", requests)
	}
	if ifNoneMatch[0] != "" {
		t.Errorf("first If-None-Match = %q, want empty", ifNoneMatch[0])
	}
	if ifNoneMatch[1] != `W/"abc"` {
		t.Errorf("second If-None-Match = %q, want W/\"abc\"", ifNoneMatch[1])
	}
}

func TestListRepos304WithoutCachedBodyReissues(t *testing.T) {
	var requests int
	var secondIfNoneMatch string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if requests == 1 {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		secondIfNoneMatch = r.Header.Get("If-None-Match")
		_, _ = io.WriteString(w, `[{"id":2,"name":"two"}]`)
	}))
	defer srv.Close()

	a := github.NewAdapterWithBaseURL(srv.Client(), srv.URL)
	result, err := a.ListRepos(context.Background(), "tok", "dave", domain.ListReposRequest{})
	if err != nil {
		t.Fatalf("ListRepos: %v", err)
	}
	if len(result.Repos) != 1 || result.Repos[0].Name != "two" {
		t.Fatalf("repos = %+v, want re-issued body", result.Repos)
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2 (re-issue unconditionally)", requests)
	}
	if secondIfNoneMatch != "" {
		t.Errorf("re-issue If-None-Match = %q, want empty", secondIfNoneMatch)
	}
}

func TestListReposForbiddenIsRateLimited(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Reset", "1700000000")
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	a := github.NewAdapterWithBaseURL(srv.Client(), srv.URL)
	_, err := a.ListRepos(context.Background(), "tok", "dave", domain.ListReposRequest{})
	assertCode(t, err, domain.ErrCodeGitHubRateLimited)
	var appErr domain.AppError
	if errors.As(err, &appErr) && appErr.Details["reset"] != "1700000000" {
		t.Errorf("details.reset = %q, want 1700000000", appErr.Details["reset"])
	}
}

func TestInvalidateCacheIsolatesAccounts(t *testing.T) {
	seen := map[string][]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		seen[token] = append(seen[token], r.Header.Get("If-None-Match"))
		if r.Header.Get("If-None-Match") != "" {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"`+token+`"`)
		_, _ = io.WriteString(w, `[{"id":1,"name":"`+token+`"}]`)
	}))
	defer srv.Close()

	a := github.NewAdapterWithBaseURL(srv.Client(), srv.URL)
	if _, err := a.ListRepos(context.Background(), "tokA", "alice", domain.ListReposRequest{}); err != nil {
		t.Fatalf("alice first: %v", err)
	}
	if _, err := a.ListRepos(context.Background(), "tokB", "bob", domain.ListReposRequest{}); err != nil {
		t.Fatalf("bob first: %v", err)
	}

	a.InvalidateCache("alice")

	alice, err := a.ListRepos(context.Background(), "tokA", "alice", domain.ListReposRequest{})
	if err != nil {
		t.Fatalf("alice second: %v", err)
	}
	if alice.Repos[0].Name != "tokA" {
		t.Errorf("alice repo = %q, want fresh tokA", alice.Repos[0].Name)
	}
	if got := seen["tokA"][1]; got != "" {
		t.Errorf("alice second If-None-Match = %q, want empty (cache invalidated)", got)
	}

	bob, err := a.ListRepos(context.Background(), "tokB", "bob", domain.ListReposRequest{})
	if err != nil {
		t.Fatalf("bob second: %v", err)
	}
	if bob.Repos[0].Name != "tokB" {
		t.Errorf("bob repo = %q, want cached tokB", bob.Repos[0].Name)
	}
	if got := seen["tokB"][1]; got != `"tokB"` {
		t.Errorf("bob second If-None-Match = %q, want \"tokB\" (cache kept)", got)
	}
}

func assertCode(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("err = nil, want code %s", want)
	}
	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want domain.AppError", err)
	}
	if appErr.Code != want {
		t.Fatalf("code = %q, want %q", appErr.Code, want)
	}
}
