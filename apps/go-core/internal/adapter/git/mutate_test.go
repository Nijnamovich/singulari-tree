package git

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// initEmptyRepoConfig creates a git repository with a deterministic identity but
// no commits. It mirrors initRepo's configuration, for tests that need an
// unborn HEAD or a hand-built history.
func initEmptyRepoConfig(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q")
	gitRun(t, dir, "config", "user.email", "alice@example.com")
	gitRun(t, dir, "config", "user.name", "Alice")
	gitRun(t, dir, "config", "commit.gpgsign", "false")
	return dir
}

// initConflictRepo builds a repository left in a conflicted merge state on
// f.txt, directly on the current (main) branch.
func initConflictRepo(t *testing.T) string {
	t.Helper()
	dir := initEmptyRepoConfig(t)
	writeFile(t, filepath.Join(dir, "f.txt"), "base\n")
	gitRun(t, dir, "add", "f.txt")
	gitRun(t, dir, "commit", "-q", "-m", "base")
	gitRun(t, dir, "branch", "-M", "main")

	gitRun(t, dir, "checkout", "-q", "-b", "side")
	writeFile(t, filepath.Join(dir, "f.txt"), "side\n")
	gitRun(t, dir, "commit", "-q", "-am", "side change")

	gitRun(t, dir, "checkout", "-q", "main")
	writeFile(t, filepath.Join(dir, "f.txt"), "main\n")
	gitRun(t, dir, "commit", "-q", "-am", "main change")

	// The merge is expected to conflict; ignore the non-zero exit.
	if _, err := runGit(context.Background(), dir, "merge", "side"); err == nil {
		t.Fatal("merge side did not conflict, test setup is wrong")
	}
	return dir
}

// TestParseStatusPorcelainV2 is a pure-helper test covering every record kind:
// ordinary, rename (with the extra NUL-separated original path), unmerged,
// untracked and ignored (skipped).
func TestParseStatusPorcelainV2(t *testing.T) {
	out := strings.Join([]string{
		"# branch.oid abcdef",
		"# branch.head main",
		"1 M. N... 100644 100644 100644 aaa bbb staged.txt",
		"2 R. N... 100644 100644 100644 aaa bbb R100 new.txt",
		"orig.txt",
		"u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt",
		"? untracked file.txt",
		"! ignored.txt",
	}, "\x00")

	got := parseStatusPorcelainV2(out)
	if len(got) != 4 {
		t.Fatalf("len(statuses) = %d, want 4 (%+v)", len(got), got)
	}

	want := []domain.FileStatus{
		{Path: "staged.txt", Staged: "M", Unstaged: ".", IsStaged: true},
		{Path: "new.txt", Staged: "R", Unstaged: ".", IsStaged: true},
		{Path: "conflict.txt", Staged: "U", Unstaged: "U", IsStaged: true, IsConflicted: true},
		{Path: "untracked file.txt", Staged: ".", Unstaged: "?"},
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("status[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// TestStatusCleanTree proves a committed, untouched tree yields an empty
// (non-nil) slice and no error.
func TestStatusCleanTree(t *testing.T) {
	dir := initRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	got, err := a.Status(context.Background(), domain.RepositoryId("repo-1"))
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if got == nil {
		t.Fatal("Status returned nil slice, want empty non-nil")
	}
	if len(got) != 0 {
		t.Fatalf("len(statuses) = %d, want 0 (%+v)", len(got), got)
	}
}

// TestStatusUntracked covers untracked files, including one with a space in its
// name (the NUL-separated format must preserve it).
func TestStatusUntracked(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "new.txt"), "new\n")
	writeFile(t, filepath.Join(dir, "with space.txt"), "spaced\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	got, err := a.Status(context.Background(), domain.RepositoryId("repo-1"))
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	byPath := map[string]domain.FileStatus{}
	for _, fs := range got {
		byPath[fs.Path] = fs
	}
	for _, name := range []string{"new.txt", "with space.txt"} {
		fs, ok := byPath[name]
		if !ok {
			t.Fatalf("missing untracked %q in %+v", name, got)
		}
		want := domain.FileStatus{Path: name, Staged: ".", Unstaged: "?"}
		if fs != want {
			t.Errorf("%s = %+v, want %+v", name, fs, want)
		}
	}
}

// TestStatusPartiallyStaged proves the XY split: a file staged then modified
// again reports "MM" with IsStaged true.
func TestStatusPartiallyStaged(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "a.txt"), "staged\n")
	gitRun(t, dir, "add", "a.txt")
	writeFile(t, filepath.Join(dir, "a.txt"), "staged plus\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	got, err := a.Status(context.Background(), domain.RepositoryId("repo-1"))
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len(statuses) = %d, want 1 (%+v)", len(got), got)
	}
	want := domain.FileStatus{Path: "a.txt", Staged: "M", Unstaged: "M", IsStaged: true}
	if got[0] != want {
		t.Fatalf("status = %+v, want %+v", got[0], want)
	}
}

// TestStatusRenameRecord proves a staged rename maps to the new path only and
// that the extra NUL-separated original-path field is consumed (no phantom
// entry for the old name).
func TestStatusRenameRecord(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "mv", "a.txt", "renamed.txt")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	got, err := a.Status(context.Background(), domain.RepositoryId("repo-1"))
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len(statuses) = %d, want 1 (%+v)", len(got), got)
	}
	want := domain.FileStatus{Path: "renamed.txt", Staged: "R", Unstaged: ".", IsStaged: true}
	if got[0] != want {
		t.Fatalf("status = %+v, want %+v", got[0], want)
	}
}

// TestStatusConflicted proves an unmerged path is reported with IsConflicted.
func TestStatusConflicted(t *testing.T) {
	dir := initConflictRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	got, err := a.Status(context.Background(), domain.RepositoryId("repo-1"))
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len(statuses) = %d, want 1 (%+v)", len(got), got)
	}
	fs := got[0]
	if fs.Path != "f.txt" {
		t.Errorf("Path = %q, want f.txt", fs.Path)
	}
	if !fs.IsConflicted {
		t.Errorf("IsConflicted = false, want true (%+v)", fs)
	}
	if fs.Staged != "U" || fs.Unstaged != "U" {
		t.Errorf("XY = %s/%s, want U/U", fs.Staged, fs.Unstaged)
	}
}

// TestStageUnstageRoundtrip proves a working-tree change can be staged and then
// unstaged, with Status reflecting both transitions.
func TestStageUnstageRoundtrip(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "a.txt"), "modified\n")

	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	if err := a.Stage(ctx, repoID, []string{"a.txt"}); err != nil {
		t.Fatalf("Stage: %v", err)
	}
	got, err := a.Status(ctx, repoID)
	if err != nil {
		t.Fatalf("Status after stage: %v", err)
	}
	if len(got) != 1 || got[0].Staged != "M" || got[0].Unstaged != "." || !got[0].IsStaged {
		t.Fatalf("status after stage = %+v, want staged-only M/.", got)
	}

	if err := a.Unstage(ctx, repoID, []string{"a.txt"}); err != nil {
		t.Fatalf("Unstage: %v", err)
	}
	got, err = a.Status(ctx, repoID)
	if err != nil {
		t.Fatalf("Status after unstage: %v", err)
	}
	if len(got) != 1 || got[0].Staged != "." || got[0].Unstaged != "M" || got[0].IsStaged {
		t.Fatalf("status after unstage = %+v, want unstaged-only ./M", got)
	}
}

// TestStageUnstageLiteralPathspec proves a path that looks like pathspec magic
// is staged and unstaged literally. A worktree file named "*.txt" must not make
// git also stage the unrelated tracked a.txt, and a file named ":top"
// (top-level pathspec magic) must remain addressable. Positional pathspecs (or
// the from-file mechanism without --literal-pathspecs) let git expand/consume
// the magic, staging extra files or failing to find the path.
func TestStageUnstageLiteralPathspec(t *testing.T) {
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	for _, name := range []string{"*.txt", ":top"} {
		t.Run(name, func(t *testing.T) {
			dir := initRepo(t)
			// a.txt is tracked by initRepo; modify it so that, were "*.txt"
			// glob-expanded, a.txt would be staged too.
			writeFile(t, filepath.Join(dir, "a.txt"), "modified\n")
			if err := os.WriteFile(filepath.Join(dir, name), []byte("literal\n"), 0o644); err != nil {
				t.Skipf("platform cannot create a file named %q: %v", name, err)
			}

			a := NewAdapter(&fakeRepoPort{fsPath: dir})

			if err := a.Stage(ctx, repoID, []string{name}); err != nil {
				t.Fatalf("Stage(%q): %v", name, err)
			}
			byPath := statusByPath(t, a, ctx, repoID)
			lit, ok := byPath[name]
			if !ok {
				t.Fatalf("literal %q missing from status %+v", name, byPath)
			}
			if !lit.IsStaged || lit.Staged != "A" {
				t.Errorf("literal %q staged = %+v, want staged A", name, lit)
			}
			if unrelated := byPath["a.txt"]; unrelated.IsStaged {
				t.Errorf("unrelated a.txt was staged: %+v", unrelated)
			}

			// Round-trip: unstaging restores the literal file to untracked and
			// leaves the unrelated a.txt untouched.
			if err := a.Unstage(ctx, repoID, []string{name}); err != nil {
				t.Fatalf("Unstage(%q): %v", name, err)
			}
			byPath = statusByPath(t, a, ctx, repoID)
			lit, ok = byPath[name]
			if !ok {
				t.Fatalf("literal %q missing after unstage in %+v", name, byPath)
			}
			if lit.IsStaged || lit.Staged != "." || lit.Unstaged != "?" {
				t.Errorf("literal %q after unstage = %+v, want untracked", name, lit)
			}
			if unrelated := byPath["a.txt"]; unrelated.IsStaged || unrelated.Unstaged != "M" {
				t.Errorf("unrelated a.txt after unstage = %+v, want unstaged M", unrelated)
			}
		})
	}
}

// statusByPath indexes Status output by path for the staging tests.
func statusByPath(t *testing.T, a *Adapter, ctx context.Context, repoID domain.RepositoryId) map[string]domain.FileStatus {
	t.Helper()
	got, err := a.Status(ctx, repoID)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	byPath := make(map[string]domain.FileStatus, len(got))
	for _, f := range got {
		byPath[f.Path] = f
	}
	return byPath
}

// TestStageEmptyPathsIsNoop proves nil/empty path lists do nothing.
func TestStageEmptyPathsIsNoop(t *testing.T) {
	dir := initRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	if err := a.Stage(ctx, repoID, nil); err != nil {
		t.Fatalf("Stage(nil): %v", err)
	}
	if err := a.Stage(ctx, repoID, []string{}); err != nil {
		t.Fatalf("Stage(empty): %v", err)
	}
	if err := a.Unstage(ctx, repoID, nil); err != nil {
		t.Fatalf("Unstage(nil): %v", err)
	}
}

// TestStageRejectsControlChars proves a malformed path yields STAGE_FAILED for
// both Stage and Unstage before any git call is made.
func TestStageRejectsControlChars(t *testing.T) {
	dir := initRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	for _, p := range []string{"", "bad\x00path", "bad\npath"} {
		if err := a.Stage(ctx, repoID, []string{p}); err == nil {
			t.Errorf("Stage(%q) succeeded, want STAGE_FAILED", p)
		} else {
			assertAppCode(t, err, domain.ErrCodeStageFailed)
		}
		if err := a.Unstage(ctx, repoID, []string{p}); err == nil {
			t.Errorf("Unstage(%q) succeeded, want STAGE_FAILED", p)
		} else {
			assertAppCode(t, err, domain.ErrCodeStageFailed)
		}
	}
}

// TestStageMissingPathFails proves a git refusal is surfaced as typed
// STAGE_FAILED with bounded raw diagnostics.
func TestStageMissingPathFails(t *testing.T) {
	dir := initRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	err := a.Stage(context.Background(), domain.RepositoryId("repo-1"), []string{"does-not-exist.txt"})
	if err == nil {
		t.Fatal("Stage(missing path) succeeded, want STAGE_FAILED")
	}
	assertAppCode(t, err, domain.ErrCodeStageFailed)
}

// TestUnstageUnbornHead proves Unstage falls back to `git rm --cached` on an
// unborn HEAD: the staged new file becomes untracked again.
func TestUnstageUnbornHead(t *testing.T) {
	dir := initEmptyRepoConfig(t)
	writeFile(t, filepath.Join(dir, "new.txt"), "new\n")
	gitRun(t, dir, "add", "new.txt")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	if err := a.Unstage(context.Background(), domain.RepositoryId("repo-1"), []string{"new.txt"}); err != nil {
		t.Fatalf("Unstage on unborn HEAD: %v", err)
	}
	if got := gitRun(t, dir, "status", "--porcelain"); got != "?? new.txt" {
		t.Fatalf("status after unborn unstage = %q, want %q", got, "?? new.txt")
	}
}

// TestCommitReturnsNewCommit proves Commit creates the commit, returns the
// fully populated domain.Commit and leaves a clean tree.
func TestCommitReturnsNewCommit(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "a.txt"), "modified\n")

	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	if err := a.Stage(ctx, repoID, []string{"a.txt"}); err != nil {
		t.Fatalf("Stage: %v", err)
	}
	c, err := a.Commit(ctx, repoID, "my subject\n\nbody with -dash", nil)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	head := gitRun(t, dir, "rev-parse", "HEAD")
	if c.Oid.Hex != head {
		t.Errorf("commit oid = %s, want HEAD %s", c.Oid.Hex, head)
	}
	if !strings.Contains(c.Message, "my subject") || !strings.Contains(c.Message, "body with -dash") {
		t.Errorf("message = %q, want subject and body preserved", c.Message)
	}
	if c.Author.Name != "Alice" || c.Author.Email != "alice@example.com" {
		t.Errorf("author = %+v, want Alice <alice@example.com>", c.Author)
	}
	if c.TreeOid.Hex == "" || c.CommittedAt.IsZero() {
		t.Errorf("commit missing tree/date: %+v", c)
	}
	if got := gitRun(t, dir, "status", "--porcelain"); got != "" {
		t.Fatalf("working tree not clean after commit: %q", got)
	}
}

// TestCommitAuthorOverride proves a non-nil author is passed through as
// --author and reflected in the created commit.
func TestCommitAuthorOverride(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "a.txt"), "modified\n")

	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	if err := a.Stage(ctx, repoID, []string{"a.txt"}); err != nil {
		t.Fatalf("Stage: %v", err)
	}
	c, err := a.Commit(ctx, repoID, "authored", &domain.Signature{Name: "Bob", Email: "bob@example.com"})
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if c.Author.Name != "Bob" || c.Author.Email != "bob@example.com" {
		t.Fatalf("author = %+v, want Bob <bob@example.com>", c.Author)
	}
}

// TestCommitFailures proves empty messages, invalid author identities and
// empty-index commits all yield typed COMMIT_FAILED.
func TestCommitFailures(t *testing.T) {
	dir := initRepo(t)
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	// Empty message (no git call).
	if _, err := a.Commit(ctx, repoID, "   ", nil); err == nil {
		t.Error("Commit(empty message) succeeded, want COMMIT_FAILED")
	} else {
		assertAppCode(t, err, domain.ErrCodeCommitFailed)
	}

	// Invalid author identity (control character), rejected before git runs.
	writeFile(t, filepath.Join(dir, "a.txt"), "modified\n")
	if err := a.Stage(ctx, repoID, []string{"a.txt"}); err != nil {
		t.Fatalf("Stage: %v", err)
	}
	if _, err := a.Commit(ctx, repoID, "msg", &domain.Signature{Name: "Bad\nName", Email: "b@c.d"}); err == nil {
		t.Error("Commit(newline author) succeeded, want COMMIT_FAILED")
	} else {
		assertAppCode(t, err, domain.ErrCodeCommitFailed)
	}

	// Nothing staged: git refuses (clean tree, separate repo).
	cleanDir := initRepo(t)
	clean := NewAdapter(&fakeRepoPort{fsPath: cleanDir})
	if _, err := clean.Commit(ctx, repoID, "msg", nil); err == nil {
		t.Error("Commit(nothing staged) succeeded, want COMMIT_FAILED")
	} else {
		assertAppCode(t, err, domain.ErrCodeCommitFailed)
	}
}
