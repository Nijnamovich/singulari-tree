package git

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// fakeRepoPort is a minimal domain.RepoPort returning a fixed fsPath for any id.
type fakeRepoPort struct{ fsPath string }

func (f *fakeRepoPort) Open(context.Context, string) (*domain.Repository, error) {
	return nil, domain.ErrRepoNotFound
}
func (f *fakeRepoPort) List(context.Context) ([]domain.Repository, error) { return nil, nil }
func (f *fakeRepoPort) Remove(context.Context, domain.RepositoryId) error { return nil }
func (f *fakeRepoPort) Get(_ context.Context, id domain.RepositoryId) (*domain.Repository, error) {
	return &domain.Repository{ID: id, FsPath: f.fsPath}, nil
}
func (f *fakeRepoPort) Relocate(_ context.Context, id domain.RepositoryId, fsPath string) (*domain.Repository, error) {
	return &domain.Repository{ID: id, FsPath: fsPath}, nil
}

// gitRun runs `git -C dir args...` and fails the test on error.
//
// Line-ending policy is pinned to core.autocrlf=false for the whole test
// process and every git invocation it spawns. Git for Windows defaults
// autocrlf=true (system/global config) on the windows-latest runner, which
// materialises CRLF in the worktree while every assertion in this package
// compares raw worktree bytes against LF; without the override the suite is
// line-ending-dependent (R9). The override is exported through git's
// environment-config mechanism (GIT_CONFIG_*) in addition to the explicit -c
// flag, because the bytes under test are produced by the *adapter's* own git
// commands (`runGit` etc.), which spawn their own processes from os.Environ()
// and therefore never see a -c flag passed to gitRun. The production adapter
// is untouched: it still honours the user's own git config, which exposes
// core.autocrlf as a setting.
func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "core.autocrlf")
	t.Setenv("GIT_CONFIG_VALUE_0", "false")
	full := append([]string{"-c", "core.autocrlf=false", "-C", dir}, args...)
	cmd := exec.Command("git", full...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// initRepo creates a real git repository with two commits and returns its path.
func initRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q")
	gitRun(t, dir, "config", "user.email", "alice@example.com")
	gitRun(t, dir, "config", "user.name", "Alice")
	gitRun(t, dir, "config", "commit.gpgsign", "false")

	writeFile(t, filepath.Join(dir, "a.txt"), "one\n")
	gitRun(t, dir, "add", "a.txt")
	gitRun(t, dir, "commit", "-q", "-m", "first commit")

	writeFile(t, filepath.Join(dir, "b.txt"), "two\n")
	gitRun(t, dir, "add", "b.txt")
	gitRun(t, dir, "commit", "-q", "-m", "second commit\n\nbody line")
	return dir
}

func TestListAndGet(t *testing.T) {
	dir := initRepo(t)
	head := gitRun(t, dir, "rev-parse", "HEAD")
	parent := gitRun(t, dir, "rev-parse", "HEAD~1")

	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()

	commits, total, err := a.List(ctx, repoID, nil, 0, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if total != 2 {
		t.Fatalf("total = %d, want 2", total)
	}
	if len(commits) != 2 {
		t.Fatalf("len(commits) = %d, want 2", len(commits))
	}

	// Newest first.
	if commits[0].Oid.Hex != head {
		t.Errorf("commits[0].Oid = %s, want HEAD %s", commits[0].Oid.Hex, head)
	}
	if commits[1].Oid.Hex != parent {
		t.Errorf("commits[1].Oid = %s, want HEAD~1 %s", commits[1].Oid.Hex, parent)
	}

	newest := commits[0]
	if !strings.HasPrefix(newest.Message, "second commit") {
		t.Errorf("message = %q, want prefix %q", newest.Message, "second commit")
	}
	if !strings.Contains(newest.Message, "body line") {
		t.Errorf("message should retain body, got %q", newest.Message)
	}
	if newest.Author.Name != "Alice" || newest.Author.Email != "alice@example.com" {
		t.Errorf("author = %+v, want Alice <alice@example.com>", newest.Author)
	}
	if newest.Committer.Email != "alice@example.com" {
		t.Errorf("committer email = %q", newest.Committer.Email)
	}
	if len(newest.Parents) != 1 || newest.Parents[0].Hex != parent {
		t.Errorf("parents = %+v, want [%s]", newest.Parents, parent)
	}
	if len(newest.TreeOid.Hex) != 40 || len(newest.Oid.Hex) != 40 {
		t.Errorf("oid/tree lengths unexpected: %s / %s", newest.Oid.Hex, newest.TreeOid.Hex)
	}
	if newest.CommittedAt.IsZero() {
		t.Error("committed_at is zero")
	}
	if len(commits[1].Parents) != 0 {
		t.Errorf("root commit parents = %+v, want none", commits[1].Parents)
	}
}

func TestListPagination(t *testing.T) {
	dir := initRepo(t)
	parent := gitRun(t, dir, "rev-parse", "HEAD~1")

	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()

	page, total, err := a.List(ctx, repoID, nil, 1, 1)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if total != 2 {
		t.Fatalf("total = %d, want 2", total)
	}
	if len(page) != 1 {
		t.Fatalf("len(page) = %d, want 1", len(page))
	}
	if page[0].Oid.Hex != parent {
		t.Errorf("page[0].Oid = %s, want %s", page[0].Oid.Hex, parent)
	}
}

// TestListShortWindowDerivesTotal pins the consistent (items, total) pair:
// a window that came back shorter than the requested limit reached the end of
// history, so total is derived as offset+len(commits) without a separate count
// read. The offset term is what makes it a total rather than a window length.
func TestListShortWindowDerivesTotal(t *testing.T) {
	dir := initRepo(t)
	parent := gitRun(t, dir, "rev-parse", "HEAD~1")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	page, total, err := a.List(context.Background(), domain.RepositoryId("repo-1"), nil, 1, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if total != 2 {
		t.Fatalf("total = %d, want 2 (offset+len)", total)
	}
	if len(page) != 1 || page[0].Oid.Hex != parent {
		t.Fatalf("page len = %d, want 1 (the parent)", len(page))
	}
}

func TestGet(t *testing.T) {
	dir := initRepo(t)
	head := gitRun(t, dir, "rev-parse", "HEAD")

	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()

	oid, err := domain.NewOid(head)
	if err != nil {
		t.Fatalf("NewOid: %v", err)
	}
	c, err := a.Get(ctx, repoID, oid)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if c.Oid.Hex != head {
		t.Errorf("Get oid = %s, want %s", c.Oid.Hex, head)
	}

	missing, _ := domain.NewOid(strings.Repeat("0", 40))
	_, err = a.Get(ctx, repoID, missing)
	var appErr domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeCommitNotFound {
		t.Fatalf("Get(missing) err = %v, want COMMIT_NOT_FOUND", err)
	}
}

func TestResolve(t *testing.T) {
	dir := initRepo(t)
	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	topLevel, commonDir, err := a.Resolve(context.Background(), sub)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	wantDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	gotDir, err := filepath.EvalSymlinks(topLevel)
	if err != nil {
		t.Fatalf("EvalSymlinks(topLevel): %v", err)
	}
	if gotDir != wantDir {
		t.Errorf("topLevel = %q, want %q", gotDir, wantDir)
	}

	wantCommon := filepath.Join(wantDir, ".git")
	gotCommon, err := filepath.EvalSymlinks(commonDir)
	if err != nil {
		t.Fatalf("EvalSymlinks(commonDir): %v", err)
	}
	if gotCommon != wantCommon {
		t.Errorf("commonDir = %q, want %q", gotCommon, wantCommon)
	}
}

func TestResolveNotAGitRepo(t *testing.T) {
	a := NewAdapter(&fakeRepoPort{fsPath: t.TempDir()})
	_, _, err := a.Resolve(context.Background(), t.TempDir())
	var appErr domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeNotAGitRepo {
		t.Fatalf("Resolve err = %v, want NOT_A_GIT_REPO", err)
	}
}

func TestParseRefs(t *testing.T) {
	out := strings.Join([]string{
		"aaa" + unitSep + "refs/heads/main" + unitSep + "",
		"bbb" + unitSep + "refs/remotes/origin/main" + unitSep + "",
		"ccc" + unitSep + "refs/tags/v1.0.0" + unitSep + "",
		// Annotated tag: objectname is the tag object, *objectname the commit.
		"tagobject" + unitSep + "refs/tags/v2.0.0" + unitSep + "ccc",
		// Unrelated namespace must be ignored.
		"ddd" + unitSep + "refs/notes/commits" + unitSep + "",
	}, "\n")

	got := parseRefs(out)

	want := map[string][]domain.RefLabel{
		"aaa": {{Name: "main", Kind: domain.RefKindBranch}},
		"bbb": {{Name: "origin/main", Kind: domain.RefKindRemote}},
		"ccc": {
			{Name: "v1.0.0", Kind: domain.RefKindTag},
			{Name: "v2.0.0", Kind: domain.RefKindTag},
		},
	}
	if len(got) != len(want) {
		t.Fatalf("parseRefs keys = %d, want %d (%v)", len(got), len(want), got)
	}
	for oid, wantRefs := range want {
		refs := got[oid]
		if len(refs) != len(wantRefs) {
			t.Fatalf("refs[%s] len = %d, want %d", oid, len(refs), len(wantRefs))
		}
		for i := range refs {
			if refs[i] != wantRefs[i] {
				t.Errorf("refs[%s][%d] = %+v, want %+v", oid, i, refs[i], wantRefs[i])
			}
		}
	}
}

func TestListPopulatesRefs(t *testing.T) {
	dir := initRepo(t)
	// Deterministic branch name independent of init.defaultBranch.
	gitRun(t, dir, "branch", "-M", "main")
	gitRun(t, dir, "branch", "feature")
	gitRun(t, dir, "tag", "v1.0.0")

	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()

	commits, _, err := a.List(ctx, repoID, nil, 0, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(commits) != 2 {
		t.Fatalf("len(commits) = %d, want 2", len(commits))
	}

	got := map[string]string{}
	for _, r := range commits[0].Refs {
		got[r.Name] = r.Kind
	}
	want := map[string]string{
		"HEAD":    domain.RefKindHead,
		"main":    domain.RefKindBranch,
		"feature": domain.RefKindBranch,
		"v1.0.0":  domain.RefKindTag,
	}
	if len(got) != len(want) {
		t.Fatalf("HEAD refs = %v, want %v", got, want)
	}
	for name, kind := range want {
		if got[name] != kind {
			t.Errorf("ref %q kind = %q, want %q", name, got[name], kind)
		}
	}

	if len(commits[1].Refs) != 0 {
		t.Errorf("parent commit refs = %+v, want none", commits[1].Refs)
	}
}

func TestListEmptyRepoDegrades(t *testing.T) {
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q")

	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	commits, total, err := a.List(context.Background(), repoID, nil, 0, 10)
	if err != nil {
		t.Fatalf("List on empty repo: %v", err)
	}
	if total != 0 || len(commits) != 0 {
		t.Fatalf("empty repo = (%d commits, total %d), want (0, 0)", len(commits), total)
	}
}

func TestUnimplementedReturnsTypedError(t *testing.T) {
	a := NewAdapter(&fakeRepoPort{fsPath: t.TempDir()})
	_, err := a.WorktreeList(context.Background(), domain.RepositoryId("x"))
	var appErr domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeNotImplemented {
		t.Fatalf("WorktreeList err = %v, want NOT_IMPLEMENTED", err)
	}
}

func TestBranchList(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	gitRun(t, dir, "branch", "feature")
	head := gitRun(t, dir, "rev-parse", "HEAD")

	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	branches, err := a.BranchList(context.Background(), repoID)
	if err != nil {
		t.Fatalf("BranchList: %v", err)
	}
	if len(branches) != 2 {
		t.Fatalf("len(branches) = %d, want 2 (%+v)", len(branches), branches)
	}

	byName := map[string]domain.Branch{}
	for _, b := range branches {
		byName[b.Name] = b
	}
	main, ok := byName["main"]
	if !ok {
		t.Fatalf("missing main branch in %+v", branches)
	}
	feature, ok := byName["feature"]
	if !ok {
		t.Fatalf("missing feature branch in %+v", branches)
	}

	if !main.IsCurrent {
		t.Errorf("main.IsCurrent = false, want true")
	}
	if feature.IsCurrent {
		t.Errorf("feature.IsCurrent = true, want false")
	}
	if main.RefName.Raw != "refs/heads/main" {
		t.Errorf("main.RefName.Raw = %q, want refs/heads/main", main.RefName.Raw)
	}
	if main.Tip.Hex != head || feature.Tip.Hex != head {
		t.Errorf("tips = %s/%s, want %s", main.Tip.Hex, feature.Tip.Hex, head)
	}
	if main.IsRemote || feature.IsRemote {
		t.Errorf("IsRemote = %v/%v, want false/false", main.IsRemote, feature.IsRemote)
	}
	if main.Upstream != nil {
		t.Errorf("main.Upstream = %+v, want nil", main.Upstream)
	}
}

func TestBranchListDetachedHead(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	gitRun(t, dir, "checkout", "-q", "--detach")

	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	branches, err := a.BranchList(context.Background(), repoID)
	if err != nil {
		t.Fatalf("BranchList: %v", err)
	}
	if len(branches) != 1 {
		t.Fatalf("len(branches) = %d, want 1", len(branches))
	}
	if branches[0].IsCurrent {
		t.Errorf("detached HEAD marked %q as current, want none current", branches[0].Name)
	}
}

func TestRemoteList(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "remote", "add", "origin", "https://example.com/repo.git")
	gitRun(t, dir, "remote", "set-url", "--add", "origin", "git@example.com:repo.git")

	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	remotes, err := a.RemoteList(context.Background(), repoID)
	if err != nil {
		t.Fatalf("RemoteList: %v", err)
	}
	if len(remotes) != 1 {
		t.Fatalf("len(remotes) = %d, want 1 (%+v)", len(remotes), remotes)
	}
	r := remotes[0]
	if r.Name != "origin" {
		t.Errorf("Name = %q, want origin", r.Name)
	}
	if len(r.Urls) != 2 || r.Urls[0] != "https://example.com/repo.git" || r.Urls[1] != "git@example.com:repo.git" {
		t.Errorf("Urls = %v, want the two configured urls", r.Urls)
	}
	wantFetch := "+refs/heads/*:refs/remotes/origin/*"
	if len(r.FetchSpecs) != 1 || r.FetchSpecs[0] != wantFetch {
		t.Errorf("FetchSpecs = %v, want [%s]", r.FetchSpecs, wantFetch)
	}
}

func TestTagList(t *testing.T) {
	dir := initRepo(t)
	head := gitRun(t, dir, "rev-parse", "HEAD")
	gitRun(t, dir, "tag", "light")
	gitRun(t, dir, "tag", "-a", "annotated", "-m", "release one")

	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	tags, err := a.TagList(context.Background(), repoID)
	if err != nil {
		t.Fatalf("TagList: %v", err)
	}
	if len(tags) != 2 {
		t.Fatalf("len(tags) = %d, want 2 (%+v)", len(tags), tags)
	}

	byName := map[string]domain.Tag{}
	for _, tag := range tags {
		byName[tag.Name] = tag
	}

	light, ok := byName["light"]
	if !ok {
		t.Fatalf("missing light tag in %+v", tags)
	}
	if light.Annotated {
		t.Errorf("light.Annotated = true, want false")
	}
	if light.Target.Hex != head {
		t.Errorf("light.Target = %s, want HEAD %s", light.Target.Hex, head)
	}
	if light.RefName.Raw != "refs/tags/light" {
		t.Errorf("light.RefName.Raw = %q, want refs/tags/light", light.RefName.Raw)
	}
	if light.Message != nil || light.Tagger != nil {
		t.Errorf("lightweight tag should have no message/tagger, got %+v", light)
	}

	annotated, ok := byName["annotated"]
	if !ok {
		t.Fatalf("missing annotated tag in %+v", tags)
	}
	if !annotated.Annotated {
		t.Errorf("annotated.Annotated = false, want true")
	}
	// Annotated tags point at a tag object; Target must be the dereferenced commit.
	if annotated.Target.Hex != head {
		t.Errorf("annotated.Target = %s, want dereferenced HEAD %s", annotated.Target.Hex, head)
	}
	if annotated.Message == nil || !strings.Contains(*annotated.Message, "release one") {
		t.Errorf("annotated.Message = %v, want subject containing %q", annotated.Message, "release one")
	}
	if annotated.Tagger == nil {
		t.Fatalf("annotated.Tagger = nil, want Alice <alice@example.com>")
	}
	if annotated.Tagger.Name != "Alice" || annotated.Tagger.Email != "alice@example.com" {
		t.Errorf("annotated.Tagger = %+v, want Alice <alice@example.com>", annotated.Tagger)
	}
	if annotated.Tagger.When.IsZero() {
		t.Errorf("annotated.Tagger.When is zero")
	}
}

func TestListReadsEmptyRepo(t *testing.T) {
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q")

	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()

	branches, err := a.BranchList(ctx, repoID)
	if err != nil {
		t.Fatalf("BranchList on empty repo: %v", err)
	}
	if len(branches) != 0 {
		t.Errorf("branches = %+v, want empty", branches)
	}

	remotes, err := a.RemoteList(ctx, repoID)
	if err != nil {
		t.Fatalf("RemoteList on empty repo: %v", err)
	}
	if len(remotes) != 0 {
		t.Errorf("remotes = %+v, want empty", remotes)
	}

	tags, err := a.TagList(ctx, repoID)
	if err != nil {
		t.Fatalf("TagList on empty repo: %v", err)
	}
	if len(tags) != 0 {
		t.Errorf("tags = %+v, want empty", tags)
	}
}

func TestParseRemotesAllowsDottedNames(t *testing.T) {
	out := strings.Join([]string{
		"remote.my.origin.url https://example.com/a.git",
		"remote.my.origin.fetch +refs/heads/*:refs/remotes/my.origin/*",
	}, "\n")
	remotes := parseRemotes(out)
	if len(remotes) != 1 {
		t.Fatalf("len(remotes) = %d, want 1 (%+v)", len(remotes), remotes)
	}
	if remotes[0].Name != "my.origin" {
		t.Errorf("Name = %q, want my.origin", remotes[0].Name)
	}
	if len(remotes[0].Urls) != 1 || len(remotes[0].FetchSpecs) != 1 {
		t.Errorf("urls/fetch = %v/%v, want one each", remotes[0].Urls, remotes[0].FetchSpecs)
	}
}

func TestParseBranchesCurrent(t *testing.T) {
	out := strings.Join([]string{
		"refs/heads/main" + unitSep + strings.Repeat("a", 40) + unitSep + "origin/main" + unitSep + "refs/remotes/origin/main" + unitSep + "" + recordSep,
		"refs/heads/other" + unitSep + strings.Repeat("b", 40) + unitSep + "" + unitSep + "" + unitSep + "" + recordSep,
	}, "")
	branches := parseBranches(out, "main")
	if len(branches) != 2 {
		t.Fatalf("len(branches) = %d, want 2", len(branches))
	}
	if !branches[0].IsCurrent {
		t.Errorf("main.IsCurrent = false, want true")
	}
	if branches[0].Upstream == nil || branches[0].Upstream.Raw != "refs/remotes/origin/main" {
		t.Errorf("main.Upstream = %+v, want refs/remotes/origin/main", branches[0].Upstream)
	}
	if branches[1].IsCurrent {
		t.Errorf("other.IsCurrent = true, want false")
	}
	if branches[1].Upstream != nil {
		t.Errorf("other.Upstream = %+v, want nil", branches[1].Upstream)
	}
}

// TestBranchListIncludesRemoteRefs proves that remote-tracking refs under
// refs/remotes are enumerated as domain.Branch{IsRemote:true} alongside local
// branches, that the symbolic refs/remotes/origin/HEAD is excluded, and that
// local-branch behavior is unchanged. The refs are created locally with
// `git update-ref` / `git symbolic-ref`, so no network access is required.
func TestBranchListIncludesRemoteRefs(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	head := gitRun(t, dir, "rev-parse", "HEAD")

	// Simulate the state left by a fetch: remote-tracking refs plus the
	// symbolic origin/HEAD that points at the remote's default branch.
	gitRun(t, dir, "update-ref", "refs/remotes/origin/main", head)
	gitRun(t, dir, "update-ref", "refs/remotes/origin/david/testbranches", head)
	gitRun(t, dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")

	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	branches, err := a.BranchList(context.Background(), repoID)
	if err != nil {
		t.Fatalf("BranchList: %v", err)
	}

	byName := map[string]domain.Branch{}
	names := make([]string, 0, len(branches))
	for _, b := range branches {
		byName[b.Name] = b
		names = append(names, b.Name)
	}

	// Local branch remains current and non-remote.
	main, ok := byName["main"]
	if !ok {
		t.Fatalf("missing local main in %+v", names)
	}
	if main.IsRemote {
		t.Errorf("main.IsRemote = true, want false")
	}
	if !main.IsCurrent {
		t.Errorf("main.IsCurrent = false, want true")
	}

	// Remote-tracking branch is enumerated and flagged correctly.
	remote, ok := byName["origin/david/testbranches"]
	if !ok {
		t.Fatalf("missing origin/david/testbranches in %+v", names)
	}
	if !remote.IsRemote {
		t.Errorf("origin/david/testbranches IsRemote = false, want true")
	}
	if remote.IsCurrent {
		t.Errorf("remote branch marked current, want false")
	}
	if remote.RefName.Raw != "refs/remotes/origin/david/testbranches" {
		t.Errorf("remote RefName.Raw = %q, want refs/remotes/origin/david/testbranches", remote.RefName.Raw)
	}
	if remote.Tip.Hex != head {
		t.Errorf("remote Tip = %s, want %s", remote.Tip.Hex, head)
	}
	if remote.Upstream != nil {
		t.Errorf("remote Upstream = %+v, want nil", remote.Upstream)
	}

	// The second remote-tracking branch is present too.
	if _, ok := byName["origin/main"]; !ok {
		t.Errorf("missing origin/main in %+v", names)
	}

	// The symbolic origin/HEAD must not surface as a normal branch.
	if _, ok := byName["origin/HEAD"]; ok {
		t.Errorf("origin/HEAD should be excluded, got %+v", names)
	}
}

// TestParseBranchesRemote is a pure-helper test proving that refs/remotes/*
// records parse to IsRemote:true (never current/no upstream) and that a
// symbolic record (non-empty symref) is skipped.
func TestParseBranchesRemote(t *testing.T) {
	localOid := strings.Repeat("a", 40)
	remoteOid := strings.Repeat("b", 40)
	out := strings.Join([]string{
		"refs/heads/main" + unitSep + localOid + unitSep + "" + unitSep + "" + unitSep + "" + recordSep,
		"refs/remotes/origin/david/testbranches" + unitSep + remoteOid + unitSep + "" + unitSep + "" + unitSep + "" + recordSep,
		// Symbolic origin/HEAD carries a symref target and must be excluded.
		"refs/remotes/origin/HEAD" + unitSep + remoteOid + unitSep + "" + unitSep + "" + unitSep + "refs/remotes/origin/main" + recordSep,
	}, "")

	branches := parseBranches(out, "main")
	if len(branches) != 2 {
		t.Fatalf("len(branches) = %d, want 2 (%+v)", len(branches), branches)
	}

	local := branches[0]
	if local.Name != "main" || local.IsRemote || !local.IsCurrent {
		t.Errorf("local = %+v, want current local main", local)
	}

	remote := branches[1]
	if remote.Name != "origin/david/testbranches" {
		t.Errorf("remote.Name = %q, want origin/david/testbranches", remote.Name)
	}
	if !remote.IsRemote {
		t.Errorf("remote.IsRemote = false, want true")
	}
	if remote.IsCurrent {
		t.Errorf("remote.IsCurrent = true, want false")
	}
	if remote.RefName.Raw != "refs/remotes/origin/david/testbranches" {
		t.Errorf("remote.RefName.Raw = %q, want refs/remotes/origin/david/testbranches", remote.RefName.Raw)
	}
	if remote.Upstream != nil {
		t.Errorf("remote.Upstream = %+v, want nil", remote.Upstream)
	}
	if remote.Tip.Hex != remoteOid {
		t.Errorf("remote.Tip = %s, want %s", remote.Tip.Hex, remoteOid)
	}
}

// TestParseBranchesBehind is a pure-helper test for the optional 6th track
// field: "[behind N]" and "[ahead M, behind N]" set Behind, while "[]", empty
// and "[gone]" leave it at 0. It also proves legacy 5-field records still parse
// with Behind == 0 and that a remote ref with a track value never sets Behind.
func TestParseBranchesBehind(t *testing.T) {
	oid := strings.Repeat("a", 40)
	rec := func(name, upstreamShort, upstreamFull, track string) string {
		return "refs/heads/" + name + unitSep + oid + unitSep + upstreamShort +
			unitSep + upstreamFull + unitSep + "" + unitSep + track + recordSep
	}
	out := strings.Join([]string{
		rec("behind2", "origin/behind2", "refs/remotes/origin/behind2", "[behind 2]"),
		rec("aheadbehind", "origin/aheadbehind", "refs/remotes/origin/aheadbehind", "[ahead 1, behind 7]"),
		rec("uptodate", "origin/uptodate", "refs/remotes/origin/uptodate", ""),
		rec("gone", "origin/gone", "refs/remotes/origin/gone", "[gone]"),
		// Legacy 5-field record: no track field at all.
		"refs/heads/legacy" + unitSep + oid + unitSep + "origin/legacy" + unitSep +
			"refs/remotes/origin/legacy" + unitSep + "" + recordSep,
		// Remote ref carrying a track value must not set Behind.
		"refs/remotes/origin/main" + unitSep + oid + unitSep + "" + unitSep + "" +
			unitSep + "" + unitSep + "[behind 3]" + recordSep,
	}, "")

	branches := parseBranches(out, "behind2")
	byName := map[string]domain.Branch{}
	for _, b := range branches {
		byName[b.Name] = b
	}

	cases := []struct {
		name string
		want int32
	}{
		{"behind2", 2},
		{"aheadbehind", 7},
		{"uptodate", 0},
		{"gone", 0},
		{"legacy", 0},
		{"origin/main", 0},
	}
	for _, tc := range cases {
		b, ok := byName[tc.name]
		if !ok {
			t.Fatalf("missing branch %q in %+v", tc.name, byName)
		}
		if b.Behind != tc.want {
			t.Errorf("%s.Behind = %d, want %d", tc.name, b.Behind, tc.want)
		}
	}
}

// TestBranchListBehind is an integration-style test (no network): it creates a
// remote-tracking ref ahead of the local branch and configures the local
// branch's upstream with `git branch --set-upstream-to`, then asserts
// BranchList reports the expected pull-pending count. The local branch also
// carries its own extra commit so git reports "ahead 1, behind 2".
func TestBranchListBehind(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	local := gitRun(t, dir, "rev-parse", "HEAD")

	// Declare a remote so git treats refs/remotes/origin/* as remote-tracking
	// branches (required by --set-upstream-to). No network is ever touched.
	gitRun(t, dir, "remote", "add", "origin", "https://example.com/repo.git")

	// Build a remote-tracking tip that is two commits ahead of the local branch
	// without any network: create the commits then move the ref via update-ref.
	gitRun(t, dir, "checkout", "-q", "-b", "tmp")
	writeFile(t, filepath.Join(dir, "c.txt"), "three\n")
	gitRun(t, dir, "add", "c.txt")
	gitRun(t, dir, "commit", "-q", "-m", "third")
	writeFile(t, filepath.Join(dir, "d.txt"), "four\n")
	gitRun(t, dir, "add", "d.txt")
	gitRun(t, dir, "commit", "-q", "-m", "fourth")
	remoteTip := gitRun(t, dir, "rev-parse", "HEAD")
	gitRun(t, dir, "update-ref", "refs/remotes/origin/main", remoteTip)
	gitRun(t, dir, "checkout", "-q", "main")
	gitRun(t, dir, "branch", "-D", "tmp")

	// Give the local branch one commit the upstream lacks (ahead 1).
	writeFile(t, filepath.Join(dir, "e.txt"), "five\n")
	gitRun(t, dir, "add", "e.txt")
	gitRun(t, dir, "commit", "-q", "-m", "fifth")
	if now := gitRun(t, dir, "rev-parse", "HEAD"); now == local {
		t.Fatal("local branch did not advance")
	}
	gitRun(t, dir, "branch", "--set-upstream-to=origin/main", "main")

	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	branches, err := a.BranchList(context.Background(), repoID)
	if err != nil {
		t.Fatalf("BranchList: %v", err)
	}
	byName := map[string]domain.Branch{}
	for _, b := range branches {
		byName[b.Name] = b
	}
	main, ok := byName["main"]
	if !ok {
		t.Fatalf("missing main in %+v", branches)
	}
	if main.Upstream == nil || main.Upstream.Raw != "refs/remotes/origin/main" {
		t.Fatalf("main.Upstream = %+v, want refs/remotes/origin/main", main.Upstream)
	}
	if main.Behind != 2 {
		t.Errorf("main.Behind = %d, want 2", main.Behind)
	}
	// Remote-tracking ref has no configured upstream, so Behind stays 0.
	if remote, ok := byName["origin/main"]; !ok {
		t.Errorf("missing origin/main in %+v", branches)
	} else if remote.Behind != 0 {
		t.Errorf("origin/main.Behind = %d, want 0", remote.Behind)
	}
}
