package git

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// newSequencerRepo creates the standard two-commit repository on main.
func newSequencerRepo(t *testing.T) string {
	t.Helper()
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	return dir
}

// assertAppDetail asserts that err is an AppError carrying key=want in Details.
func assertAppDetail(t *testing.T, err error, key, want string) {
	t.Helper()
	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want typed AppError with %s=%q", err, key, want)
	}
	if got := appErr.Details[key]; got != want {
		t.Fatalf("err detail %s = %q, want %q (err=%v)", key, got, want, err)
	}
}

// TestCherryPickPlainPreservesAuthor proves a clean pick appends the source
// commit's change on the current branch and keeps its author.
func TestCherryPickPlainPreservesAuthor(t *testing.T) {
	dir := newSequencerRepo(t)

	gitRun(t, dir, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(dir, "c.txt"), "three\n")
	gitRun(t, dir, "add", "c.txt")
	gitRun(t, dir, "commit", "-q", "-m", "feature work", "--author", "Bob <bob@example.com>")
	gitRun(t, dir, "checkout", "-q", "main")
	before := gitRun(t, dir, "rev-parse", "HEAD")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()

	res, err := a.CherryPick(ctx, domain.RepositoryId("repo-1"), "feature", false, false)
	if err != nil {
		t.Fatalf("CherryPick: %v", err)
	}
	if res.HasConflict {
		t.Errorf("HasConflict = true, want false")
	}
	head := gitRun(t, dir, "rev-parse", "HEAD")
	if head == before {
		t.Fatal("HEAD did not advance across a clean cherry-pick")
	}
	if res.Oid.Hex != head {
		t.Errorf("result.Oid = %q, want HEAD %q", res.Oid.Hex, head)
	}
	if got := gitRun(t, dir, "log", "-1", "--pretty=%s", "HEAD"); got != "feature work" {
		t.Errorf("subject = %q, want the picked subject", got)
	}
	if got := gitRun(t, dir, "log", "-1", "--pretty=%an <%ae>", "HEAD"); got != "Bob <bob@example.com>" {
		t.Errorf("author = %q, want the picked author", got)
	}
	if got := gitRun(t, dir, "status", "--porcelain"); got != "" {
		t.Errorf("working tree dirty after pick: %q", got)
	}
}

// TestCherryPickRecordOrigin proves -x records the source oid in the body.
func TestCherryPickRecordOrigin(t *testing.T) {
	dir := newSequencerRepo(t)

	gitRun(t, dir, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(dir, "c.txt"), "three\n")
	gitRun(t, dir, "add", "c.txt")
	gitRun(t, dir, "commit", "-q", "-m", "feature work")
	picked := gitRun(t, dir, "rev-parse", "HEAD")
	gitRun(t, dir, "checkout", "-q", "main")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	if _, err := a.CherryPick(context.Background(), domain.RepositoryId("repo-1"), "feature", true, false); err != nil {
		t.Fatalf("CherryPick(-x): %v", err)
	}
	body := gitRun(t, dir, "log", "-1", "--pretty=%B", "HEAD")
	if want := "(cherry picked from commit " + picked + ")"; !strings.Contains(body, want) {
		t.Errorf("body = %q, want it to contain %q", body, want)
	}
}

// TestCherryPickNoCommit proves --no-commit stages the change without creating
// a commit, leaving HEAD where it was.
func TestCherryPickNoCommit(t *testing.T) {
	dir := newSequencerRepo(t)

	gitRun(t, dir, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(dir, "c.txt"), "three\n")
	gitRun(t, dir, "add", "c.txt")
	gitRun(t, dir, "commit", "-q", "-m", "feature work")
	gitRun(t, dir, "checkout", "-q", "main")
	before := gitRun(t, dir, "rev-parse", "HEAD")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	res, err := a.CherryPick(context.Background(), domain.RepositoryId("repo-1"), "feature", false, true)
	if err != nil {
		t.Fatalf("CherryPick(--no-commit): %v", err)
	}
	if got := gitRun(t, dir, "rev-parse", "HEAD"); got != before {
		t.Errorf("HEAD = %q, want unchanged %q (--no-commit must not commit)", got, before)
	}
	if res.Oid.Hex != before {
		t.Errorf("result.Oid = %q, want the unchanged HEAD %q", res.Oid.Hex, before)
	}
	if got := gitRun(t, dir, "diff", "--cached", "--name-only"); got != "c.txt" {
		t.Errorf("staged files = %q, want c.txt", got)
	}
	// The staged change must be visible as a non-empty index: exit 1 on
	// `diff --cached --quiet` is exactly what the post-pick emptiness check
	// treats as "the pick applied something".
	if _, code, _ := runGitAllowExit(context.Background(), dir, "diff", "--cached", "--quiet"); code != 1 {
		t.Errorf("git diff --cached --quiet exit = %d, want 1 (a change is staged)", code)
	}
}

// TestCherryPickNoCommitEmptyReportsEmpty proves an already-applied change
// picked with --no-commit is reported as FAILED reason=empty even though git
// exits 0 in that case, and that the index stays clean instead of the dialog
// closing as if a change had been applied.
func TestCherryPickNoCommitEmptyReportsEmpty(t *testing.T) {
	dir := newSequencerRepo(t)

	gitRun(t, dir, "checkout", "-q", "-b", "side")
	writeFile(t, filepath.Join(dir, "c.txt"), "three\n")
	gitRun(t, dir, "add", "c.txt")
	gitRun(t, dir, "commit", "-q", "-m", "side change")
	gitRun(t, dir, "checkout", "-q", "main")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")
	if _, err := a.CherryPick(ctx, repoID, "side", false, false); err != nil {
		t.Fatalf("setup CherryPick: %v", err)
	}

	res, err := a.CherryPick(ctx, repoID, "side", false, true)
	if err == nil {
		t.Fatal("CherryPick(already applied, --no-commit) returned nil error, want CHERRY_PICK_FAILED reason=empty")
	}
	if res != nil {
		t.Errorf("result = %+v, want nil on an empty --no-commit pick", res)
	}
	assertAppCode(t, err, domain.ErrCodeCherryPickFailed)
	assertAppDetail(t, err, "reason", "empty")

	// The emptiness decision is read from the index: exit 0 means nothing is
	// staged relative to HEAD.
	if _, code, derr := runGitAllowExit(ctx, dir, "diff", "--cached", "--quiet"); code != 0 {
		t.Errorf("git diff --cached --quiet exit = %d, want 0 (clean index), err=%v", code, derr)
	}
	if got := gitRun(t, dir, "status", "--porcelain"); got != "" {
		t.Errorf("working tree/index not clean after an empty --no-commit pick: %q", got)
	}
	if _, herr := runGit(ctx, dir, "rev-parse", "--verify", "CHERRY_PICK_HEAD"); herr == nil {
		t.Error("CHERRY_PICK_HEAD resolvable, want no sequencer state on the --no-commit path")
	}
}

// TestCherryPickConflictLeavesSequencerArmed proves a conflicting pick returns a
// result with HasConflict, a typed CHERRY_PICK_CONFLICT error, and leaves
// CHERRY_PICK_HEAD plus a conflicted entry visible to Status.
func TestCherryPickConflictLeavesSequencerArmed(t *testing.T) {
	dir := newSequencerRepo(t)

	gitRun(t, dir, "checkout", "-q", "-b", "other")
	writeFile(t, filepath.Join(dir, "a.txt"), "other\n")
	gitRun(t, dir, "add", "a.txt")
	gitRun(t, dir, "commit", "-q", "-m", "other change")

	gitRun(t, dir, "checkout", "-q", "main")
	writeFile(t, filepath.Join(dir, "a.txt"), "main\n")
	gitRun(t, dir, "add", "a.txt")
	gitRun(t, dir, "commit", "-q", "-m", "main change")
	head := gitRun(t, dir, "rev-parse", "HEAD")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()

	res, err := a.CherryPick(ctx, domain.RepositoryId("repo-1"), "other", false, false)
	if err == nil {
		t.Fatal("CherryPick(conflicting) returned nil error, want CHERRY_PICK_CONFLICT")
	}
	assertAppCode(t, err, domain.ErrCodeCherryPickConflict)
	if res == nil || !res.HasConflict {
		t.Fatalf("result = %+v, want HasConflict true", res)
	}
	if res.Oid.Hex != head {
		t.Errorf("result.Oid = %q, want the unchanged HEAD %q", res.Oid.Hex, head)
	}

	if _, herr := runGit(ctx, dir, "rev-parse", "--verify", "CHERRY_PICK_HEAD"); herr != nil {
		t.Errorf("CHERRY_PICK_HEAD missing: the sequencer was not left armed: %v", herr)
	}
	statuses, serr := a.Status(ctx, domain.RepositoryId("repo-1"))
	if serr != nil {
		t.Fatalf("Status: %v", serr)
	}
	var conflicted bool
	for _, s := range statuses {
		if s.IsConflicted {
			conflicted = true
		}
	}
	if !conflicted {
		t.Errorf("Status = %+v, want at least one IsConflicted entry", statuses)
	}
}

// TestCherryPickEmptyClearsSequencer proves an already-applied pick is reported
// as FAILED reason=empty and that the sequencer is cleared, leaving a clean
// worktree instead of a stuck repository.
func TestCherryPickEmptyClearsSequencer(t *testing.T) {
	dir := newSequencerRepo(t)

	gitRun(t, dir, "checkout", "-q", "-b", "side")
	writeFile(t, filepath.Join(dir, "c.txt"), "three\n")
	gitRun(t, dir, "add", "c.txt")
	gitRun(t, dir, "commit", "-q", "-m", "side change")
	gitRun(t, dir, "checkout", "-q", "main")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	if _, err := a.CherryPick(ctx, domain.RepositoryId("repo-1"), "side", false, false); err != nil {
		t.Fatalf("first CherryPick: %v", err)
	}

	res, err := a.CherryPick(ctx, domain.RepositoryId("repo-1"), "side", false, false)
	if err == nil {
		t.Fatal("CherryPick(already applied) returned nil error, want CHERRY_PICK_FAILED")
	}
	if res != nil {
		t.Errorf("result = %+v, want nil on an empty pick", res)
	}
	assertAppCode(t, err, domain.ErrCodeCherryPickFailed)
	assertAppDetail(t, err, "reason", "empty")

	if _, herr := runGit(ctx, dir, "rev-parse", "--verify", "CHERRY_PICK_HEAD"); herr == nil {
		t.Error("CHERRY_PICK_HEAD still resolvable, want the sequencer cleared")
	}
	if got := gitRun(t, dir, "status", "--porcelain"); got != "" {
		t.Errorf("working tree dirty after an empty pick: %q", got)
	}
}

// TestCherryPickRejections covers the ordered pre-flight validation.
func TestCherryPickRejections(t *testing.T) {
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	t.Run("empty source", func(t *testing.T) {
		dir := newSequencerRepo(t)
		a := NewAdapter(&fakeRepoPort{fsPath: dir})
		_, err := a.CherryPick(ctx, repoID, "   ", false, false)
		assertAppCode(t, err, domain.ErrCodeCherryPickFailed)
		assertAppDetail(t, err, "reason", "invalid-source")
	})

	t.Run("leading dash", func(t *testing.T) {
		dir := newSequencerRepo(t)
		a := NewAdapter(&fakeRepoPort{fsPath: dir})
		_, err := a.CherryPick(ctx, repoID, "-oops", false, false)
		assertAppCode(t, err, domain.ErrCodeCherryPickFailed)
		assertAppDetail(t, err, "reason", "invalid-source")
	})

	t.Run("unresolvable", func(t *testing.T) {
		dir := newSequencerRepo(t)
		a := NewAdapter(&fakeRepoPort{fsPath: dir})
		_, err := a.CherryPick(ctx, repoID, "no-such-rev", false, false)
		assertAppCode(t, err, domain.ErrCodeCommitNotFound)
		assertAppDetail(t, err, "source", "no-such-rev")
	})

	t.Run("merge commit", func(t *testing.T) {
		dir := newSequencerRepo(t)
		gitRun(t, dir, "checkout", "-q", "-b", "feature")
		writeFile(t, filepath.Join(dir, "c.txt"), "three\n")
		gitRun(t, dir, "add", "c.txt")
		gitRun(t, dir, "commit", "-q", "-m", "feature commit")
		gitRun(t, dir, "checkout", "-q", "main")
		writeFile(t, filepath.Join(dir, "d.txt"), "four\n")
		gitRun(t, dir, "add", "d.txt")
		gitRun(t, dir, "commit", "-q", "-m", "main commit")
		gitRun(t, dir, "merge", "-q", "--no-ff", "-m", "merge feature", "feature")

		a := NewAdapter(&fakeRepoPort{fsPath: dir})
		_, err := a.CherryPick(ctx, repoID, "HEAD", false, false)
		assertAppCode(t, err, domain.ErrCodeCherryPickFailed)
		assertAppDetail(t, err, "reason", "merge-commit")
	})

	t.Run("detached head", func(t *testing.T) {
		dir := newSequencerRepo(t)
		gitRun(t, dir, "checkout", "-q", "--detach", "main")

		a := NewAdapter(&fakeRepoPort{fsPath: dir})
		_, err := a.CherryPick(ctx, repoID, "main", false, false)
		assertAppCode(t, err, domain.ErrCodeDetachedHead)
	})

	t.Run("busy sequencer", func(t *testing.T) {
		dir := newSequencerRepo(t)
		gitRun(t, dir, "checkout", "-q", "-b", "other")
		writeFile(t, filepath.Join(dir, "a.txt"), "other\n")
		gitRun(t, dir, "add", "a.txt")
		gitRun(t, dir, "commit", "-q", "-m", "other change")
		gitRun(t, dir, "checkout", "-q", "main")
		writeFile(t, filepath.Join(dir, "a.txt"), "main\n")
		gitRun(t, dir, "add", "a.txt")
		gitRun(t, dir, "commit", "-q", "-m", "main change")

		a := NewAdapter(&fakeRepoPort{fsPath: dir})
		// Leave a real conflicted pick in progress.
		if _, err := a.CherryPick(ctx, repoID, "other", false, false); err == nil {
			t.Fatal("setup pick did not conflict")
		}

		_, err := a.CherryPick(ctx, repoID, "HEAD~1", false, false)
		assertAppCode(t, err, domain.ErrCodeCherryPickFailed)
		assertAppDetail(t, err, "reason", "in-progress")
	})
}

// TestCherryPickDirtyTreeRefused proves local changes that the pick would
// overwrite are refused with the overwrite reason.
func TestCherryPickDirtyTreeRefused(t *testing.T) {
	dir := newSequencerRepo(t)

	gitRun(t, dir, "checkout", "-q", "-b", "side")
	writeFile(t, filepath.Join(dir, "a.txt"), "side\n")
	gitRun(t, dir, "add", "a.txt")
	gitRun(t, dir, "commit", "-q", "-m", "side change")
	gitRun(t, dir, "checkout", "-q", "main")
	writeFile(t, filepath.Join(dir, "a.txt"), "local-dirty\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	_, err := a.CherryPick(context.Background(), domain.RepositoryId("repo-1"), "side", false, false)
	assertAppCode(t, err, domain.ErrCodeCherryPickFailed)
	assertAppDetail(t, err, "reason", "overwrite-local-changes")
}

// TestRevertPlain proves a clean revert undoes the change in a new commit.
func TestRevertPlain(t *testing.T) {
	dir := newSequencerRepo(t)
	writeFile(t, filepath.Join(dir, "a.txt"), "two\n")
	gitRun(t, dir, "add", "a.txt")
	gitRun(t, dir, "commit", "-q", "-m", "second")
	target := gitRun(t, dir, "rev-parse", "HEAD")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	res, err := a.Revert(context.Background(), domain.RepositoryId("repo-1"), target)
	if err != nil {
		t.Fatalf("Revert: %v", err)
	}
	if res.HasConflict {
		t.Errorf("HasConflict = true, want false")
	}
	if got := readRepoFile(t, filepath.Join(dir, "a.txt")); got != "one\n" {
		t.Errorf("a.txt = %q, want the pre-commit content", got)
	}
	head := gitRun(t, dir, "rev-parse", "HEAD")
	if head == target {
		t.Fatal("HEAD did not advance across a revert")
	}
	if res.Oid.Hex != head {
		t.Errorf("result.Oid = %q, want HEAD %q", res.Oid.Hex, head)
	}
	if got := gitRun(t, dir, "log", "-1", "--pretty=%s", "HEAD"); !strings.Contains(got, "Revert") {
		t.Errorf("subject = %q, want a Revert commit", got)
	}
}

// TestRevertConflictLeavesSequencerArmed proves a conflicting revert returns
// HasConflict plus REVERT_CONFLICT and leaves REVERT_HEAD armed.
func TestRevertConflictLeavesSequencerArmed(t *testing.T) {
	dir := newSequencerRepo(t)
	writeFile(t, filepath.Join(dir, "a.txt"), "two\n")
	gitRun(t, dir, "add", "a.txt")
	gitRun(t, dir, "commit", "-q", "-m", "second")
	second := gitRun(t, dir, "rev-parse", "HEAD")
	writeFile(t, filepath.Join(dir, "a.txt"), "three\n")
	gitRun(t, dir, "add", "a.txt")
	gitRun(t, dir, "commit", "-q", "-m", "third")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	res, err := a.Revert(ctx, domain.RepositoryId("repo-1"), second)
	if err == nil {
		t.Fatal("Revert(conflicting) returned nil error, want REVERT_CONFLICT")
	}
	assertAppCode(t, err, domain.ErrCodeRevertConflict)
	if res == nil || !res.HasConflict {
		t.Fatalf("result = %+v, want HasConflict true", res)
	}
	if _, herr := runGit(ctx, dir, "rev-parse", "--verify", "REVERT_HEAD"); herr != nil {
		t.Errorf("REVERT_HEAD missing: the sequencer was not left armed: %v", herr)
	}
	statuses, serr := a.Status(ctx, domain.RepositoryId("repo-1"))
	if serr != nil {
		t.Fatalf("Status: %v", serr)
	}
	var conflicted bool
	for _, s := range statuses {
		if s.IsConflicted && s.Path == "a.txt" {
			conflicted = true
		}
	}
	if !conflicted {
		t.Errorf("Status = %+v, want a.txt reported IsConflicted", statuses)
	}
}

// TestRevertEmptyClearsSequencer proves reverting an already-absent change is
// reported as FAILED reason=empty with a clean tree and no sequencer state.
func TestRevertEmptyClearsSequencer(t *testing.T) {
	dir := newSequencerRepo(t)
	writeFile(t, filepath.Join(dir, "b2.txt"), "bee\n")
	gitRun(t, dir, "add", "b2.txt")
	gitRun(t, dir, "commit", "-q", "-m", "add b2")
	addB := gitRun(t, dir, "rev-parse", "HEAD")
	gitRun(t, dir, "rm", "-q", "b2.txt")
	gitRun(t, dir, "commit", "-q", "-m", "remove b2")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	res, err := a.Revert(ctx, domain.RepositoryId("repo-1"), addB)
	if err == nil {
		t.Fatal("Revert(already absent) returned nil error, want REVERT_FAILED")
	}
	if res != nil {
		t.Errorf("result = %+v, want nil on an empty revert", res)
	}
	assertAppCode(t, err, domain.ErrCodeRevertFailed)
	assertAppDetail(t, err, "reason", "empty")
	if _, herr := runGit(ctx, dir, "rev-parse", "--verify", "REVERT_HEAD"); herr == nil {
		t.Error("REVERT_HEAD still resolvable, want the sequencer cleared")
	}
	if got := gitRun(t, dir, "status", "--porcelain"); got != "" {
		t.Errorf("working tree dirty after an empty revert: %q", got)
	}
}

// TestRevertRejections covers the ordered pre-flight validation for revert.
func TestRevertRejections(t *testing.T) {
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	t.Run("empty source", func(t *testing.T) {
		dir := newSequencerRepo(t)
		a := NewAdapter(&fakeRepoPort{fsPath: dir})
		_, err := a.Revert(ctx, repoID, "  ")
		assertAppCode(t, err, domain.ErrCodeRevertFailed)
		assertAppDetail(t, err, "reason", "invalid-source")
	})

	t.Run("unresolvable", func(t *testing.T) {
		dir := newSequencerRepo(t)
		a := NewAdapter(&fakeRepoPort{fsPath: dir})
		absent := strings.Repeat("deadbeef", 5)
		for _, rev := range []string{"nope-not-a-ref", absent} {
			_, err := a.Revert(ctx, repoID, rev)
			assertAppCode(t, err, domain.ErrCodeCommitNotFound)
			assertAppDetail(t, err, "source", rev)
		}
	})

	t.Run("merge commit", func(t *testing.T) {
		dir := newSequencerRepo(t)
		gitRun(t, dir, "checkout", "-q", "-b", "feature")
		writeFile(t, filepath.Join(dir, "c.txt"), "three\n")
		gitRun(t, dir, "add", "c.txt")
		gitRun(t, dir, "commit", "-q", "-m", "feature commit")
		gitRun(t, dir, "checkout", "-q", "main")
		writeFile(t, filepath.Join(dir, "d.txt"), "four\n")
		gitRun(t, dir, "add", "d.txt")
		gitRun(t, dir, "commit", "-q", "-m", "main commit")
		gitRun(t, dir, "merge", "-q", "--no-ff", "-m", "merge feature", "feature")

		a := NewAdapter(&fakeRepoPort{fsPath: dir})
		_, err := a.Revert(ctx, repoID, "HEAD")
		assertAppCode(t, err, domain.ErrCodeRevertFailed)
		assertAppDetail(t, err, "reason", "merge-commit")
	})

	t.Run("detached head", func(t *testing.T) {
		dir := newSequencerRepo(t)
		gitRun(t, dir, "checkout", "-q", "--detach", "main")

		a := NewAdapter(&fakeRepoPort{fsPath: dir})
		_, err := a.Revert(ctx, repoID, "main")
		assertAppCode(t, err, domain.ErrCodeDetachedHead)
	})

	t.Run("busy sequencer", func(t *testing.T) {
		dir := newSequencerRepo(t)
		writeFile(t, filepath.Join(dir, "a.txt"), "two\n")
		gitRun(t, dir, "add", "a.txt")
		gitRun(t, dir, "commit", "-q", "-m", "second")
		second := gitRun(t, dir, "rev-parse", "HEAD")
		writeFile(t, filepath.Join(dir, "a.txt"), "three\n")
		gitRun(t, dir, "add", "a.txt")
		gitRun(t, dir, "commit", "-q", "-m", "third")

		a := NewAdapter(&fakeRepoPort{fsPath: dir})
		if _, err := a.Revert(ctx, repoID, second); err == nil {
			t.Fatal("setup revert did not conflict")
		}
		_, err := a.Revert(ctx, repoID, "HEAD")
		assertAppCode(t, err, domain.ErrCodeRevertFailed)
		assertAppDetail(t, err, "reason", "in-progress")
	})
}

// TestResolveRevision covers full/short sha, branch, lightweight and annotated
// tag resolution plus the unusable and unresolvable rejections.
func TestResolveRevision(t *testing.T) {
	dir := newSequencerRepo(t)
	full := gitRun(t, dir, "rev-parse", "HEAD")
	short := gitRun(t, dir, "rev-parse", "--short=8", "HEAD")
	parent := gitRun(t, dir, "rev-parse", "HEAD~1")
	gitRun(t, dir, "branch", "feature", "HEAD~1")
	gitRun(t, dir, "tag", "v1", "HEAD")
	gitRun(t, dir, "tag", "-a", "v2", "-m", "annotated", "HEAD~1")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	cases := []struct {
		revision string
		want     string
	}{
		{"HEAD", full},
		{full, full},
		{short, full},
		{"main", full},
		{"feature", parent},
		{"v1", full},
		{"v2", parent},
		{"HEAD~1", parent},
	}
	for _, tc := range cases {
		got, err := a.ResolveRevision(ctx, repoID, tc.revision)
		if err != nil {
			t.Errorf("ResolveRevision(%q): %v", tc.revision, err)
			continue
		}
		if got.Oid.Hex != tc.want {
			t.Errorf("ResolveRevision(%q) = %q, want %q", tc.revision, got.Oid.Hex, tc.want)
		}
	}

	_, err := a.ResolveRevision(ctx, repoID, "no-such-rev")
	assertAppCode(t, err, domain.ErrCodeCommitNotFound)
	assertAppDetail(t, err, "revision", "no-such-rev")

	_, err = a.ResolveRevision(ctx, repoID, "-oops")
	assertAppCode(t, err, domain.ErrCodeInvalidOid)
}

// readRepoFile reads a fixture file, failing the test on error.
func readRepoFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}
