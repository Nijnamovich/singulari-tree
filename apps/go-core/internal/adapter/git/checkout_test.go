package git

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/SingulariTree/go-core/internal/domain"
)

// localBranches returns the local branch short names (empty when there are
// none), used to prove DWIM checkout does not create duplicate branches.
func localBranches(t *testing.T, dir string) []string {
	t.Helper()
	out := gitRun(t, dir, "for-each-ref", "--format=%(refname:short)", "refs/heads")
	if strings.TrimSpace(out) == "" {
		return nil
	}
	return strings.Split(out, "\n")
}

// TestCheckoutLocalBranchSwitchesHead covers a plain local branch, both as a
// full refname and as a short name resolved through the DWIM canonicalization.
func TestCheckoutLocalBranchSwitchesHead(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	gitRun(t, dir, "branch", "feature")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	repoID := domain.RepositoryId("repo-1")
	ctx := context.Background()

	if err := a.Checkout(ctx, repoID, domain.RefName{Raw: "refs/heads/feature"}, false, false); err != nil {
		t.Fatalf("Checkout(refs/heads/feature): %v", err)
	}
	if got := gitRun(t, dir, "symbolic-ref", "HEAD"); got != "refs/heads/feature" {
		t.Fatalf("HEAD = %q, want refs/heads/feature", got)
	}

	if err := a.Checkout(ctx, repoID, domain.RefName{Raw: "main"}, false, false); err != nil {
		t.Fatalf("Checkout(main): %v", err)
	}
	if got := gitRun(t, dir, "symbolic-ref", "HEAD"); got != "refs/heads/main" {
		t.Fatalf("HEAD = %q, want refs/heads/main", got)
	}
}

// TestCheckoutRemoteTrackingWithLocalCounterpart proves that a remote-tracking
// ref with an existing local counterpart switches to the local branch without
// creating a new one.
func TestCheckoutRemoteTrackingWithLocalCounterpart(t *testing.T) {
	src := initRepo(t)
	gitRun(t, src, "branch", "-M", "main")
	bare := initBareRemote(t)
	gitRun(t, src, "remote", "add", "origin", bare)
	gitRun(t, src, "push", "-q", "-u", "origin", "main")
	gitRun(t, src, "branch", "feature")
	gitRun(t, src, "push", "-q", "-u", "origin", "feature")
	gitRun(t, src, "checkout", "-q", "main")

	before := localBranches(t, src)

	a := NewAdapter(&fakeRepoPort{fsPath: src})
	if err := a.Checkout(context.Background(), domain.RepositoryId("repo-1"), domain.RefName{Raw: "refs/remotes/origin/feature"}, false, false); err != nil {
		t.Fatalf("Checkout(refs/remotes/origin/feature): %v", err)
	}
	if got := gitRun(t, src, "symbolic-ref", "HEAD"); got != "refs/heads/feature" {
		t.Fatalf("HEAD = %q, want refs/heads/feature", got)
	}
	after := localBranches(t, src)
	if strings.Join(before, ",") != strings.Join(after, ",") {
		t.Fatalf("local branches changed: before=%v after=%v (must reuse the existing branch)", before, after)
	}
}

// TestCheckoutRemoteTrackingCreatesTrackingBranch proves that a remote-tracking
// ref without a local counterpart creates a local branch tracking it, and that
// a short `remote/branch` input (including a slash in the branch name) resolves
// correctly.
func TestCheckoutRemoteTrackingCreatesTrackingBranch(t *testing.T) {
	src := initRepo(t)
	gitRun(t, src, "branch", "-M", "main")
	bare := initBareRemote(t)
	gitRun(t, src, "remote", "add", "origin", bare)
	gitRun(t, src, "push", "-q", "-u", "origin", "main")

	// Push a branch whose name contains a slash, then drop the local branch so
	// only the remote-tracking ref remains.
	gitRun(t, src, "branch", "david/topic")
	gitRun(t, src, "push", "-q", "origin", "david/topic")
	gitRun(t, src, "branch", "-D", "david/topic")
	if _, err := runGit(context.Background(), src, "rev-parse", "--verify", "refs/heads/david/topic"); err == nil {
		t.Fatal("local branch david/topic still exists, test setup is wrong")
	}

	a := NewAdapter(&fakeRepoPort{fsPath: src})
	if err := a.Checkout(context.Background(), domain.RepositoryId("repo-1"), domain.RefName{Raw: "origin/david/topic"}, false, false); err != nil {
		t.Fatalf("Checkout(origin/david/topic): %v", err)
	}
	if got := gitRun(t, src, "symbolic-ref", "HEAD"); got != "refs/heads/david/topic" {
		t.Fatalf("HEAD = %q, want refs/heads/david/topic", got)
	}
	if got := gitRun(t, src, "rev-parse", "--abbrev-ref", "david/topic@{upstream}"); got != "origin/david/topic" {
		t.Fatalf("upstream = %q, want origin/david/topic", got)
	}
}

// TestCheckoutOidDetachesHead covers the OID fallback: a commit hash that
// `rev-parse --symbolic-full-name` does not resolve still detaches HEAD at it.
func TestCheckoutOidDetachesHead(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	gitRun(t, dir, "checkout", "-q", "-b", "feature")
	target := gitRun(t, dir, "rev-parse", "HEAD~1")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	if err := a.Checkout(context.Background(), domain.RepositoryId("repo-1"), domain.RefName{Raw: target}, false, false); err != nil {
		t.Fatalf("Checkout(%s): %v", target, err)
	}
	if got := gitRun(t, dir, "rev-parse", "HEAD"); got != target {
		t.Fatalf("HEAD = %q, want %q", got, target)
	}
	if got := currentBranch(context.Background(), dir); got != "" {
		t.Fatalf("HEAD branch = %q, want detached", got)
	}
}

// TestCheckoutRejectsUnsafeAndMissingRefs covers the option-injection guard and
// the git-failure path: every rejected input must be a typed CHECKOUT_FAILED.
func TestCheckoutRejectsUnsafeAndMissingRefs(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	cases := []string{
		"",                         // empty ref
		"-evil",                    // option injection before rev-parse
		"refs/remotes/origin/HEAD", // symbolic remote HEAD is not a branch
		"refs/heads/",              // empty branch name
		"refs/heads/nope",          // nonexistent local branch
	}
	for _, raw := range cases {
		err := a.Checkout(ctx, repoID, domain.RefName{Raw: raw}, false, false)
		if err == nil {
			t.Errorf("Checkout(%q) succeeded, want CHECKOUT_FAILED", raw)
			continue
		}
		assertAppCode(t, err, domain.ErrCodeCheckoutFailed)
	}
}

// TestCheckoutDirtyWorkingTreeReportsPaths proves that git's dirty-tree refusal
// is preserved (HEAD does not move) while the failure becomes legible: a
// friendly headline plus the complete list of conflicting paths in Details.
func TestCheckoutDirtyWorkingTreeReportsPaths(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")

	// A branch whose tip modifies two files already tracked on main.
	gitRun(t, dir, "checkout", "-q", "-b", "other")
	writeFile(t, filepath.Join(dir, "a.txt"), "other a\n")
	writeFile(t, filepath.Join(dir, "b.txt"), "other b\n")
	gitRun(t, dir, "add", "a.txt", "b.txt")
	gitRun(t, dir, "commit", "-q", "-m", "change both files")

	// Back on main, dirty the same two files so switching would overwrite them.
	gitRun(t, dir, "checkout", "-q", "main")
	writeFile(t, filepath.Join(dir, "a.txt"), "local a\n")
	writeFile(t, filepath.Join(dir, "b.txt"), "local b\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	err := a.Checkout(context.Background(), domain.RepositoryId("repo-1"), domain.RefName{Raw: "refs/heads/other"}, false, false)
	if err == nil {
		t.Fatal("Checkout over a dirty working tree succeeded, want CHECKOUT_FAILED")
	}
	assertAppCode(t, err, domain.ErrCodeCheckoutFailed)

	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want typed AppError", err)
	}
	if got := appErr.Details["reason"]; got != "dirty_working_tree" {
		t.Errorf("details[reason] = %q, want dirty_working_tree", got)
	}
	// The friendly headline must survive in Message in addition to the
	// structured details.
	if !strings.Contains(appErr.Message, "would be overwritten by checkout") {
		t.Errorf("Message = %q, want the friendly 'would be overwritten by checkout' headline", appErr.Message)
	}

	// The path list must be complete: exactly a.txt and b.txt, one per line.
	want := map[string]bool{"a.txt": false, "b.txt": false}
	for _, p := range strings.Split(appErr.Details["paths"], "\n") {
		if _, ok := want[p]; ok {
			want[p] = true
			continue
		}
		t.Errorf("unexpected path in details[paths]: %q (all=%q)", p, appErr.Details["paths"])
	}
	for p, seen := range want {
		if !seen {
			t.Errorf("details[paths] missing %q (all=%q)", p, appErr.Details["paths"])
		}
	}
	if strings.TrimSpace(appErr.Details["raw"]) == "" {
		t.Error("details[raw] is empty, want bounded diagnostics")
	}
	if got := gitRun(t, dir, "symbolic-ref", "--short", "HEAD"); got != "main" {
		t.Errorf("HEAD = %q, want main (checkout must not have switched)", got)
	}
}

// TestCheckoutFailedTruncatesOnRuneBoundary proves a long multi-byte message is
// bounded to valid UTF-8: proto3 string fields reject invalid UTF-8, so slicing
// mid-rune would lose the typed CHECKOUT_FAILED code at marshal time.
func TestCheckoutFailedTruncatesOnRuneBoundary(t *testing.T) {
	msg := strings.Repeat("é", maxCheckoutErrLen) // 2 bytes per rune
	got := checkoutFailed(msg)
	if len(got.Message) > maxCheckoutErrLen {
		t.Fatalf("message length %d exceeds cap %d", len(got.Message), maxCheckoutErrLen)
	}
	if !utf8.ValidString(got.Message) {
		t.Fatalf("message is not valid UTF-8: %q", got.Message)
	}
}

// TestCheckoutFailedFromGitBoundsPathsAndRaw proves the structured dirty-tree
// details are bounded by bytes as well as by count: the gRPC
// x-app-error-details trailer is a size-limited HTTP/2 header, so an oversized
// paths value could otherwise be silently dropped. It calls the pure error
// builder directly with synthesized stderr and asserts the paths are valid
// UTF-8, cut on a path boundary, end with the "… and N more" sentinel and stay
// within maxCheckoutPathsBytes; the oversized raw must be cut on a line
// boundary and end with "… (truncated)".
func TestCheckoutFailedFromGitBoundsPathsAndRaw(t *testing.T) {
	const headerLine = "error: Your local changes to the following files would be overwritten by checkout:"
	const commitLine = "Please commit your changes or stash them before you switch branches."
	const pathCount = 40
	// ~400 ASCII bytes per path, so the byte cap triggers long before the count
	// cap (40 << maxCheckoutPaths = 500).
	padding := strings.Repeat("x", 380)
	paths := make([]string, 0, pathCount)
	originalLines := map[string]bool{headerLine: true, commitLine: true}
	var stderr strings.Builder
	stderr.WriteString(headerLine + "\n")
	for i := 0; i < pathCount; i++ {
		p := fmt.Sprintf("dir%03d/filename_%s.txt", i, padding)
		paths = append(paths, p)
		stderr.WriteString("\t" + p + "\n")
		originalLines["\t"+p] = true
	}
	stderr.WriteString(commitLine + "\n")

	err := checkoutFailedFromGit(stderr.String())
	if err.Code != domain.ErrCodeCheckoutFailed {
		t.Fatalf("code = %q, want %q", err.Code, domain.ErrCodeCheckoutFailed)
	}
	if got := err.Details["reason"]; got != "dirty_working_tree" {
		t.Fatalf("details[reason] = %q, want dirty_working_tree", got)
	}

	joined := err.Details["paths"]
	if len(joined) > maxCheckoutPathsBytes {
		t.Fatalf("details[paths] length %d exceeds byte cap %d", len(joined), maxCheckoutPathsBytes)
	}
	if !utf8.ValidString(joined) {
		t.Fatal("details[paths] is not valid UTF-8")
	}

	entries := strings.Split(joined, "\n")
	sentinel := entries[len(entries)-1]
	if !strings.Contains(sentinel, "… and ") || !strings.HasSuffix(sentinel, "more") {
		t.Fatalf("details[paths] must end with an omitted-paths sentinel, last = %q", sentinel)
	}
	// Every entry before the sentinel must be a complete original path, never a
	// split fragment.
	valid := make(map[string]bool, len(paths))
	for _, p := range paths {
		valid[p] = true
	}
	for i, e := range entries[:len(entries)-1] {
		if !valid[e] {
			t.Fatalf("details[paths] entry %d is not a complete original path: %q", i, e)
		}
	}
	// The sentinel count must account for exactly the omitted paths.
	numStr := strings.TrimSuffix(strings.TrimPrefix(sentinel, "… and "), " more")
	omitted, convErr := strconv.Atoi(numStr)
	if convErr != nil {
		t.Fatalf("sentinel %q is not parseable: %v", sentinel, convErr)
	}
	if got := (len(entries) - 1) + omitted; got != pathCount {
		t.Fatalf("sentinel accounts for %d paths, want %d", got, pathCount)
	}

	// raw is bounded on a line boundary and explicitly marked as truncated.
	raw := err.Details["raw"]
	if !strings.HasSuffix(raw, "… (truncated)") {
		t.Fatalf("details[raw] must end with the truncation marker, got %q", raw)
	}
	if !utf8.ValidString(raw) {
		t.Fatal("details[raw] is not valid UTF-8")
	}
	body := strings.TrimSuffix(raw, "\n… (truncated)")
	if body == raw {
		t.Fatal("details[raw] truncation marker is not on its own line")
	}
	for _, line := range strings.Split(body, "\n") {
		if !originalLines[line] {
			t.Fatalf("details[raw] was cut mid-line: %q is not a complete original line", line)
		}
	}
}

// TestCheckoutFailedFromGitClassifiesSingularUntracked proves the untracked
// detection also matches git's singular form ("Untracked working tree file ...
// would be overwritten by checkout."), not only the plural form, while leaving
// the tracked-dirty classification unchanged. The tab-indented path list is
// synthesized so the structured (paths-present) branch is exercised.
func TestCheckoutFailedFromGitClassifiesSingularUntracked(t *testing.T) {
	const headerLine = "error: Untracked working tree file 'c.txt' would be overwritten by checkout."
	stderr := headerLine + "\n\tc.txt\n"

	err := checkoutFailedFromGit(stderr)
	if err.Code != domain.ErrCodeCheckoutFailed {
		t.Fatalf("code = %q, want %q", err.Code, domain.ErrCodeCheckoutFailed)
	}
	if got := err.Details["reason"]; got != "untracked_working_tree" {
		t.Fatalf("details[reason] = %q, want untracked_working_tree", got)
	}
	if got := err.Details["paths"]; !strings.Contains(got, "c.txt") {
		t.Fatalf("details[paths] = %q, want it to contain c.txt", got)
	}
}

// readFile returns a file's content, failing the test on error.
func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// TestCheckoutForceDiscardsTrackedModifications proves force=true maps to
// `git checkout -f`: a local modification to a tracked file is discarded and
// the file matches the target branch's committed content.
func TestCheckoutForceDiscardsTrackedModifications(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")

	// Target branch changes a.txt; main diverges only by a local modification.
	gitRun(t, dir, "checkout", "-q", "-b", "other")
	writeFile(t, filepath.Join(dir, "a.txt"), "other a\n")
	gitRun(t, dir, "add", "a.txt")
	gitRun(t, dir, "commit", "-q", "-m", "change a on other")

	gitRun(t, dir, "checkout", "-q", "main")
	writeFile(t, filepath.Join(dir, "a.txt"), "local dirty\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	if err := a.Checkout(context.Background(), domain.RepositoryId("repo-1"), domain.RefName{Raw: "refs/heads/other"}, true, false); err != nil {
		t.Fatalf("Checkout(force): %v", err)
	}
	if got := gitRun(t, dir, "symbolic-ref", "HEAD"); got != "refs/heads/other" {
		t.Fatalf("HEAD = %q, want refs/heads/other", got)
	}
	if got := readFile(t, filepath.Join(dir, "a.txt")); got != "other a\n" {
		t.Fatalf("a.txt = %q, want the target content %q (local change must be discarded)", got, "other a\n")
	}
	if got := gitRun(t, dir, "status", "--porcelain"); got != "" {
		t.Fatalf("working tree not clean after force checkout: %q", got)
	}
}

// TestCheckoutForceKeepsUntrackedFiles proves the boundary of the force flag:
// force maps only to `git checkout -f` (discard tracked modifications), NOT to
// an implicit `git clean`. An unrelated untracked scratch file must survive a
// forced checkout to a valid branch.
func TestCheckoutForceKeepsUntrackedFiles(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	gitRun(t, dir, "branch", "feature")

	scratch := filepath.Join(dir, "scratch.txt")
	writeFile(t, scratch, "junk\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	if err := a.Checkout(context.Background(), domain.RepositoryId("repo-1"), domain.RefName{Raw: "refs/heads/feature"}, true, false); err != nil {
		t.Fatalf("Checkout(force): %v", err)
	}
	if got := gitRun(t, dir, "symbolic-ref", "HEAD"); got != "refs/heads/feature" {
		t.Fatalf("HEAD = %q, want refs/heads/feature", got)
	}
	if _, err := os.Stat(scratch); err != nil {
		t.Fatalf("untracked scratch file was removed by a force checkout: %v", err)
	}
	if got := readFile(t, scratch); got != "junk\n" {
		t.Fatalf("scratch.txt = %q, want %q", got, "junk\n")
	}
}

// TestCheckoutUntrackedConflictReportsReason proves a checkout blocked by an
// untracked file colliding with a target-branch file yields a typed
// CHECKOUT_FAILED whose reason distinguishes it from the tracked-dirty case.
func TestCheckoutUntrackedConflictReportsReason(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")

	gitRun(t, dir, "checkout", "-q", "-b", "other")
	writeFile(t, filepath.Join(dir, "c.txt"), "from other\n")
	gitRun(t, dir, "add", "c.txt")
	gitRun(t, dir, "commit", "-q", "-m", "add c on other")

	gitRun(t, dir, "checkout", "-q", "main")
	writeFile(t, filepath.Join(dir, "c.txt"), "untracked local\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	err := a.Checkout(context.Background(), domain.RepositoryId("repo-1"), domain.RefName{Raw: "refs/heads/other"}, false, false)
	if err == nil {
		t.Fatal("Checkout over a colliding untracked file succeeded, want CHECKOUT_FAILED")
	}
	assertAppCode(t, err, domain.ErrCodeCheckoutFailed)

	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want typed AppError", err)
	}
	if got := appErr.Details["reason"]; got != "untracked_working_tree" {
		t.Errorf("details[reason] = %q, want untracked_working_tree", got)
	}
	if paths := appErr.Details["paths"]; strings.TrimSpace(paths) == "" {
		t.Error("details[paths] is empty, want the colliding path")
	} else if !strings.Contains(paths, "c.txt") {
		t.Errorf("details[paths] = %q, want it to contain c.txt", paths)
	}
	if got := gitRun(t, dir, "symbolic-ref", "--short", "HEAD"); got != "main" {
		t.Errorf("HEAD = %q, want main (checkout must not have switched)", got)
	}
}

// TestCheckoutDiscardUntrackedCleansAndSwitches proves discard_untracked=true
// runs `git clean -fd` before a forced checkout: the colliding untracked file's
// local content is discarded (replaced by the target branch's) and any other
// untracked file is removed.
func TestCheckoutDiscardUntrackedCleansAndSwitches(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")

	gitRun(t, dir, "checkout", "-q", "-b", "other")
	writeFile(t, filepath.Join(dir, "c.txt"), "from other\n")
	gitRun(t, dir, "add", "c.txt")
	gitRun(t, dir, "commit", "-q", "-m", "add c on other")

	gitRun(t, dir, "checkout", "-q", "main")
	writeFile(t, filepath.Join(dir, "c.txt"), "untracked local\n")
	writeFile(t, filepath.Join(dir, "scratch.txt"), "junk\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	if err := a.Checkout(context.Background(), domain.RepositoryId("repo-1"), domain.RefName{Raw: "refs/heads/other"}, true, true); err != nil {
		t.Fatalf("Checkout(force, discardUntracked): %v", err)
	}
	if got := gitRun(t, dir, "symbolic-ref", "HEAD"); got != "refs/heads/other" {
		t.Fatalf("HEAD = %q, want refs/heads/other", got)
	}
	// c.txt now comes from the target branch; the untracked local content is gone.
	if got := readFile(t, filepath.Join(dir, "c.txt")); got != "from other\n" {
		t.Fatalf("c.txt = %q, want the target content %q", got, "from other\n")
	}
	// An unrelated untracked file must have been removed by `git clean -fd`.
	if _, err := os.Stat(filepath.Join(dir, "scratch.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("scratch.txt still present after discard-untracked checkout (stat err=%v)", err)
	}
	if got := gitRun(t, dir, "status", "--porcelain"); got != "" {
		t.Fatalf("working tree not clean after discard-untracked checkout: %q", got)
	}
}

// TestCheckoutDiscardUntrackedInvalidRefKeepsUntracked proves the
// destructive-safety boundary: when the target ref does not resolve,
// discard_untracked=true must fail with CHECKOUT_FAILED before `git clean -fd`
// runs, so untracked data survives a failed switch.
func TestCheckoutDiscardUntrackedInvalidRefKeepsUntracked(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")

	scratch := filepath.Join(dir, "scratch.txt")
	writeFile(t, scratch, "junk\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	err := a.Checkout(context.Background(), domain.RepositoryId("repo-1"), domain.RefName{Raw: "refs/heads/does-not-exist"}, true, true)
	if err == nil {
		t.Fatal("Checkout(discard_untracked, invalid ref) succeeded, want CHECKOUT_FAILED")
	}
	assertAppCode(t, err, domain.ErrCodeCheckoutFailed)
	if _, statErr := os.Stat(scratch); statErr != nil {
		t.Fatalf("untracked scratch file was destroyed before the ref was verified: %v", statErr)
	}
	if got := currentBranch(context.Background(), dir); got != "main" {
		t.Fatalf("HEAD branch = %q, want main (checkout must not have switched)", got)
	}
}

// TestCheckoutRemoteTrackingWithForce proves the remote-tracking DWIM and its
// duplicate-branch guard are unaffected by force: the ref still resolves and
// switches to the existing local branch.
func TestCheckoutRemoteTrackingWithForce(t *testing.T) {
	src := initRepo(t)
	gitRun(t, src, "branch", "-M", "main")
	bare := initBareRemote(t)
	gitRun(t, src, "remote", "add", "origin", bare)
	gitRun(t, src, "push", "-q", "-u", "origin", "main")
	gitRun(t, src, "branch", "feature")
	gitRun(t, src, "push", "-q", "-u", "origin", "feature")
	gitRun(t, src, "checkout", "-q", "main")

	before := localBranches(t, src)

	a := NewAdapter(&fakeRepoPort{fsPath: src})
	if err := a.Checkout(context.Background(), domain.RepositoryId("repo-1"), domain.RefName{Raw: "refs/remotes/origin/feature"}, true, false); err != nil {
		t.Fatalf("Checkout(remote-tracking, force): %v", err)
	}
	if got := gitRun(t, src, "symbolic-ref", "HEAD"); got != "refs/heads/feature" {
		t.Fatalf("HEAD = %q, want refs/heads/feature", got)
	}
	after := localBranches(t, src)
	if strings.Join(before, ",") != strings.Join(after, ",") {
		t.Fatalf("local branches changed: before=%v after=%v (force must reuse the existing branch)", before, after)
	}
}
