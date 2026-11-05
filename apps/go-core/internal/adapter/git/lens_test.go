package git

import (
	"context"
	"errors"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// initDivergedRepo builds a repository in which `main` and `feature` diverge
// from a shared base:
//
//	base
//	├─ main1    (main, HEAD)
//	└─ feature1 (feature)
//
// It returns the repo path and the three oids.
func initDivergedRepo(t *testing.T) (dir, base, mainTip, featureTip string) {
	t.Helper()
	dir = t.TempDir()
	gitRun(t, dir, "init", "-q")
	gitRun(t, dir, "config", "user.email", "alice@example.com")
	gitRun(t, dir, "config", "user.name", "Alice")
	gitRun(t, dir, "config", "commit.gpgsign", "false")
	gitRun(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")

	writeFile(t, filepath.Join(dir, "base.txt"), "base\n")
	gitRun(t, dir, "add", "base.txt")
	gitRun(t, dir, "commit", "-q", "-m", "base")
	base = gitRun(t, dir, "rev-parse", "HEAD")

	gitRun(t, dir, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(dir, "feature.txt"), "feature\n")
	gitRun(t, dir, "add", "feature.txt")
	gitRun(t, dir, "commit", "-q", "-m", "feature1")
	featureTip = gitRun(t, dir, "rev-parse", "HEAD")

	gitRun(t, dir, "checkout", "-q", "main")
	writeFile(t, filepath.Join(dir, "main.txt"), "main\n")
	gitRun(t, dir, "add", "main.txt")
	gitRun(t, dir, "commit", "-q", "-m", "main1")
	mainTip = gitRun(t, dir, "rev-parse", "HEAD")
	return dir, base, mainTip, featureTip
}

// TestListEmptyRefsStaysHeadOnly pins the signed-off invariant: with no refs
// the walk is the historical HEAD walk, so every pre-lens caller (graph,
// pagination, totals) keeps exactly the same window.
func TestListEmptyRefsStaysHeadOnly(t *testing.T) {
	dir, base, mainTip, _ := initDivergedRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	wantCount := gitRun(t, dir, "rev-list", "--count", "HEAD")

	for _, refs := range [][]string{nil, {}, {""}} {
		commits, total, err := a.List(ctx, repoID, refs, 0, 10)
		if err != nil {
			t.Fatalf("List(refs=%q): %v", refs, err)
		}
		if total != 2 {
			t.Fatalf("List(refs=%q) total = %d, want 2 (HEAD-only count %s)", refs, total, wantCount)
		}
		if len(commits) != 2 {
			t.Fatalf("List(refs=%q) len = %d, want 2", refs, len(commits))
		}
		if commits[0].Oid.Hex != mainTip {
			t.Errorf("List(refs=%q) first oid = %s, want HEAD %s", refs, commits[0].Oid.Hex, mainTip)
		}
		if commits[1].Oid.Hex != base {
			t.Errorf("List(refs=%q) second oid = %s, want base %s", refs, commits[1].Oid.Hex, base)
		}
	}
}

// TestListLensReturnsUnion proves the lensed walk is HEAD ∪ refs and that the
// total is the union's `git rev-list --count <refs...>`. The window is exactly
// full (limit == union size), so the total comes from the separate count read,
// not from the short-walk derivation.
func TestListLensReturnsUnion(t *testing.T) {
	dir, base, mainTip, featureTip := initDivergedRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	wantTotal := gitRun(t, dir, "rev-list", "--count", "main", "feature")

	commits, total, err := a.List(ctx, repoID, []string{"feature"}, 0, 3)
	if err != nil {
		t.Fatalf("List(feature): %v", err)
	}
	if total != 3 {
		t.Fatalf("total = %d, want 3 (rev-list count main feature = %s)", total, wantTotal)
	}
	// The literal proves the fixture; the equality proves the contract: total
	// is the live union's reachable count, not a value pinned to this repo.
	if got, want := strconv.Itoa(total), wantTotal; got != want {
		t.Fatalf("total = %s, want the live rev-list count %s for main feature", got, want)
	}
	if len(commits) != 3 {
		t.Fatalf("len(commits) = %d, want 3 (union HEAD u feature)", len(commits))
	}

	got := make(map[string]bool, len(commits))
	for _, c := range commits {
		got[c.Oid.Hex] = true
	}
	for _, want := range []string{mainTip, featureTip, base} {
		if !got[want] {
			t.Errorf("union window is missing %s", want)
		}
	}
	if len(got) != 3 {
		t.Errorf("union window has %d distinct oids, want 3", len(got))
	}
}

// TestListLensPagination walks the lensed union one commit at a time and
// asserts the pages concatenate to the one-shot window: no duplicates and no
// gaps.
func TestListLensPagination(t *testing.T) {
	dir, _, _, _ := initDivergedRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	oneShot, total, err := a.List(ctx, repoID, []string{"feature"}, 0, 10)
	if err != nil {
		t.Fatalf("List(one-shot): %v", err)
	}
	if total != len(oneShot) {
		t.Fatalf("one-shot total = %d, len = %d", total, len(oneShot))
	}

	seen := make(map[string]bool, total)
	for off := 0; off < total; off++ {
		page, pageTotal, err := a.List(ctx, repoID, []string{"feature"}, off, 1)
		if err != nil {
			t.Fatalf("List(offset=%d): %v", off, err)
		}
		if pageTotal != total {
			t.Errorf("List(offset=%d) total = %d, want %d", off, pageTotal, total)
		}
		if len(page) != 1 {
			t.Fatalf("List(offset=%d) len = %d, want 1", off, len(page))
		}
		oid := page[0].Oid.Hex
		if oid != oneShot[off].Oid.Hex {
			t.Errorf("page[offset=%d] oid = %s, want %s", off, oid, oneShot[off].Oid.Hex)
		}
		if seen[oid] {
			t.Errorf("oid %s appeared in two windows (duplicate)", oid)
		}
		seen[oid] = true
	}
	if len(seen) != total {
		t.Fatalf("paged %d distinct oids, want %d (gap)", len(seen), total)
	}
}

// TestListRejectsUnsafeRefs proves a lexically unsafe ref never reaches git:
// both the window walk and the membership walk reject it with the read path's
// typed INVALID_OID error, carrying the offending value.
func TestListRejectsUnsafeRefs(t *testing.T) {
	dir, _, _, _ := initDivergedRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	cases := []string{"-x", "feature one", "feature\tone"}
	for _, ref := range cases {
		_, _, err := a.List(ctx, repoID, []string{ref}, 0, 10)
		assertInvalidRef(t, err, ref)

		_, err = a.LensOids(ctx, repoID, []string{ref})
		assertInvalidRef(t, err, ref)
	}
}

func assertInvalidRef(t *testing.T, err error, ref string) {
	t.Helper()
	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want domain.AppError", err)
	}
	if appErr.Code != domain.ErrCodeInvalidOid {
		t.Errorf("code = %q, want %q", appErr.Code, domain.ErrCodeInvalidOid)
	}
	if appErr.Message != "invalid ref" {
		t.Errorf("message = %q, want %q", appErr.Message, "invalid ref")
	}
	if appErr.Details["ref"] != ref {
		t.Errorf("details[ref] = %q, want %q", appErr.Details["ref"], ref)
	}
}

// TestListMissingLensRefFails proves a lensed walk that fails is surfaced as an
// error, not masked as an empty window with total 0: the empty-repository
// fallback is restricted to the un-lensed walk.
func TestListMissingLensRefFails(t *testing.T) {
	dir, _, _, _ := initDivergedRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	commits, total, err := a.List(context.Background(), domain.RepositoryId("repo-1"), []string{"refs/heads/ghost"}, 0, 10)
	if err == nil {
		t.Fatalf("List(missing lens ref) = (%d commits, total %d), nil error; want an error", len(commits), total)
	}
	if commits != nil || total != 0 {
		t.Errorf("List(missing lens ref) = (%d commits, total %d), want (nil, 0) alongside the error", len(commits), total)
	}
}

// TestListUnbornRepoNoRefsStillEmptyWindow proves the un-lensed fallback is
// unchanged: an empty/unborn repository with no refs still reports an empty
// window and a nil error.
func TestListUnbornRepoNoRefsStillEmptyWindow(t *testing.T) {
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	commits, total, err := a.List(context.Background(), domain.RepositoryId("repo-1"), nil, 0, 10)
	if err != nil {
		t.Fatalf("List(unborn repo, no refs): %v", err)
	}
	if len(commits) != 0 || total != 0 {
		t.Errorf("List(unborn repo, no refs) = (%d commits, total %d), want (0, 0)", len(commits), total)
	}
}

// TestLensOidsMissingRefIsTypedCommitNotFound proves a lens ref that git cannot
// resolve is reported as a typed COMMIT_NOT_FOUND (which the transport maps to
// a not-found status) rather than a raw git error that would surface as
// Internal. Details carry the validated, space-joined refs.
func TestLensOidsMissingRefIsTypedCommitNotFound(t *testing.T) {
	dir, _, _, _ := initDivergedRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})

	_, err := a.LensOids(context.Background(), domain.RepositoryId("repo-1"),
		[]string{" feature ", "refs/heads/ghost"})
	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want a typed domain.AppError", err)
	}
	if appErr.Code != domain.ErrCodeCommitNotFound {
		t.Errorf("code = %q, want %q", appErr.Code, domain.ErrCodeCommitNotFound)
	}
	if appErr.Message != "cannot resolve the lens ref" {
		t.Errorf("message = %q, want %q", appErr.Message, "cannot resolve the lens ref")
	}
	if got, want := appErr.Details["refs"], "feature refs/heads/ghost"; got != want {
		t.Errorf("details[refs] = %q, want %q (validated refs, space-joined)", got, want)
	}
}

// TestLensOidsFeatureMembership proves the membership set is exactly the
// feature-reachable history: the feature tip and the shared base, and nothing
// from main-only history. Empty refs spawn no walk and yield an empty result.
func TestLensOidsFeatureMembership(t *testing.T) {
	dir, base, mainTip, featureTip := initDivergedRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	oids, err := a.LensOids(ctx, repoID, []string{"feature"})
	if err != nil {
		t.Fatalf("LensOids(feature): %v", err)
	}
	got := make(map[string]bool, len(oids))
	for _, oid := range oids {
		got[oid] = true
	}
	if len(got) != 2 {
		t.Fatalf("LensOids(feature) = %v, want 2 oids", oids)
	}
	if !got[featureTip] {
		t.Errorf("LensOids(feature) missing feature tip %s", featureTip)
	}
	if !got[base] {
		t.Errorf("LensOids(feature) missing shared base %s", base)
	}
	if got[mainTip] {
		t.Errorf("LensOids(feature) includes main-only commit %s", mainTip)
	}

	empty, err := a.LensOids(ctx, repoID, nil)
	if err != nil {
		t.Fatalf("LensOids(nil): %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("LensOids(nil) = %v, want empty", empty)
	}
}
