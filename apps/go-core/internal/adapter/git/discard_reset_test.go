package git

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// TestDiscardTrackedReverts proves a tracked modification is restored from HEAD
// (index and worktree) leaving a clean tree.
func TestDiscardTrackedReverts(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "a.txt"), "modified\n")
	gitRun(t, dir, "add", "a.txt")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	if err := a.Discard(context.Background(), domain.RepositoryId("repo-1"), []string{"a.txt"}); err != nil {
		t.Fatalf("Discard: %v", err)
	}
	if got := fileContent(t, filepath.Join(dir, "a.txt")); got != "one\n" {
		t.Errorf("worktree = %q, want one", got)
	}
	if got := gitRun(t, dir, "status", "--porcelain"); got != "" {
		t.Errorf("status = %q, want clean", got)
	}
}

// TestDiscardUntrackedRemoves proves an untracked file is removed.
func TestDiscardUntrackedRemoves(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "untracked.txt"), "x\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	if err := a.Discard(context.Background(), domain.RepositoryId("repo-1"), []string{"untracked.txt"}); err != nil {
		t.Fatalf("Discard: %v", err)
	}
	if fileExists(filepath.Join(dir, "untracked.txt")) {
		t.Error("untracked.txt still exists, want removed")
	}
}

// TestDiscardIndexOnlyRemoves proves a newly added (index-only) file is unstaged
// and removed.
func TestDiscardIndexOnlyRemoves(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "staged.txt"), "new\n")
	gitRun(t, dir, "add", "staged.txt")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	if err := a.Discard(context.Background(), domain.RepositoryId("repo-1"), []string{"staged.txt"}); err != nil {
		t.Fatalf("Discard: %v", err)
	}
	if fileExists(filepath.Join(dir, "staged.txt")) {
		t.Error("staged.txt still exists, want removed")
	}
	if got := gitRun(t, dir, "status", "--porcelain"); got != "" {
		t.Errorf("status = %q, want clean", got)
	}
}

// TestDiscardRejectsPathEscape proves a path escaping the repository root is
// rejected without removing anything.
func TestDiscardRejectsPathEscape(t *testing.T) {
	dir := initRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	err := a.Discard(context.Background(), domain.RepositoryId("repo-1"), []string{"../escape.txt"})
	if err == nil {
		t.Fatal("Discard(escape) succeeded, want DISCARD_FAILED")
	}
	assertAppCode(t, err, domain.ErrCodeDiscardFailed)
}

// TestDiscardRejectsSymlinkEscape proves the symlink-aware containment check:
// discarding a path whose parent is a symlink to a directory outside the repo
// is rejected and the outside target is left untouched. The repo and the
// outside directory both live under the OS temp dir (/tmp on Linux), so the
// symlink crosses a real repository boundary on the same filesystem.
func TestDiscardRejectsSymlinkEscape(t *testing.T) {
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	cases := []struct {
		name string
		// setup returns the repo dir, the repo-relative slash path to discard
		// and the outside file that must survive the rejected discard.
		setup func(t *testing.T) (dir, rel, outsideFile string)
	}{
		{
			name: "file directly below symlinked dir",
			setup: func(t *testing.T) (string, string, string) {
				dir := initRepo(t)
				outside := t.TempDir()
				writeFile(t, filepath.Join(outside, "victim.txt"), "keep\n")
				link := filepath.Join(dir, "link")
				if err := os.Symlink(outside, link); err != nil {
					t.Skipf("symlinks unsupported: %v", err)
				}
				return dir, "link/victim.txt", filepath.Join(outside, "victim.txt")
			},
		},
		{
			name: "file below nested dir under symlinked dir",
			setup: func(t *testing.T) (string, string, string) {
				dir := initRepo(t)
				outside := t.TempDir()
				if err := os.Mkdir(filepath.Join(outside, "sub"), 0o755); err != nil {
					t.Fatalf("mkdir: %v", err)
				}
				writeFile(t, filepath.Join(outside, "sub", "victim.txt"), "keep\n")
				link := filepath.Join(dir, "link")
				if err := os.Symlink(outside, link); err != nil {
					t.Skipf("symlinks unsupported: %v", err)
				}
				return dir, "link/sub/victim.txt", filepath.Join(outside, "sub", "victim.txt")
			},
		},
		{
			name: "missing leaf below symlinked dir",
			setup: func(t *testing.T) (string, string, string) {
				dir := initRepo(t)
				outside := t.TempDir()
				writeFile(t, filepath.Join(outside, "keep.txt"), "keep\n")
				link := filepath.Join(dir, "link")
				if err := os.Symlink(outside, link); err != nil {
					t.Skipf("symlinks unsupported: %v", err)
				}
				return dir, "link/missing.txt", filepath.Join(outside, "keep.txt")
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir, rel, outsideFile := tc.setup(t)
			a := NewAdapter(&fakeRepoPort{fsPath: dir})

			err := a.Discard(ctx, repoID, []string{rel})
			if err == nil {
				t.Fatalf("Discard(%s) succeeded, want DISCARD_FAILED", rel)
			}
			assertAppCode(t, err, domain.ErrCodeDiscardFailed)

			if !fileExists(outsideFile) {
				t.Errorf("outside target %s was removed, want untouched", outsideFile)
			} else if got := fileContent(t, outsideFile); got != "keep\n" {
				t.Errorf("outside target content = %q, want keep", got)
			}
			// The symlink itself must survive the rejected discard too.
			if !fileExists(filepath.Join(dir, "link")) {
				t.Errorf("repo symlink link was removed, want untouched")
			}
		})
	}
}

// TestDiscardRemovesSymlinkItselfSafely proves the final component is not
// resolved for deletion: discarding a symlink that points outside the repo
// removes the link itself and leaves the outside target intact.
func TestDiscardRemovesSymlinkItselfSafely(t *testing.T) {
	dir := initRepo(t)
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "victim.txt"), "keep\n")
	link := filepath.Join(dir, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	if err := a.Discard(context.Background(), domain.RepositoryId("repo-1"), []string{"link"}); err != nil {
		t.Fatalf("Discard(symlink): %v", err)
	}
	if fileExists(link) {
		t.Error("repo symlink link still exists, want removed")
	}
	if !fileExists(filepath.Join(outside, "victim.txt")) {
		t.Error("outside target was removed, want untouched")
	}
}

// TestDiscardEmptyIsNoop proves an empty path list does nothing.
func TestDiscardEmptyIsNoop(t *testing.T) {
	dir := initRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	if err := a.Discard(context.Background(), domain.RepositoryId("repo-1"), nil); err != nil {
		t.Fatalf("Discard(nil): %v", err)
	}
}

// TestResetModes is table-driven over soft/mixed/hard and asserts git's exact
// semantics: soft = HEAD only, mixed = HEAD + index, hard = HEAD + index +
// worktree.
func TestResetModes(t *testing.T) {
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")
	cases := []struct {
		name         string
		mode         domain.ResetMode
		wantStatus   string
		wantWorktree string
	}{
		// Reset to the current HEAD isolates the mode semantics from unrelated
		// commits: soft keeps the index, mixed resets it, hard also resets the
		// worktree.
		{"soft", domain.ResetModeSoft, "M  a.txt", "modified\n"},
		{"mixed", domain.ResetModeMixed, "M a.txt", "modified\n"},
		{"hard", domain.ResetModeHard, "", "one\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := initRepo(t)
			head := gitRun(t, dir, "rev-parse", "HEAD")
			writeFile(t, filepath.Join(dir, "a.txt"), "modified\n")
			gitRun(t, dir, "add", "a.txt")

			a := NewAdapter(&fakeRepoPort{fsPath: dir})
			if err := a.Reset(ctx, repoID, head, tc.mode); err != nil {
				t.Fatalf("Reset(%s): %v", tc.name, err)
			}
			if got := gitRun(t, dir, "rev-parse", "HEAD"); got != head {
				t.Errorf("HEAD = %s, want %s", got, head)
			}
			if got := gitRun(t, dir, "status", "--porcelain"); got != tc.wantStatus {
				t.Errorf("status = %q, want %q", got, tc.wantStatus)
			}
			if got := fileContent(t, filepath.Join(dir, "a.txt")); got != tc.wantWorktree {
				t.Errorf("worktree = %q, want %q", got, tc.wantWorktree)
			}
		})
	}
}

// TestResetAcceptssRef proves a ref (not just an oid) is resolved in core.
func TestResetAcceptsRef(t *testing.T) {
	dir := initRepo(t)
	head := gitRun(t, dir, "rev-parse", "HEAD")
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	if err := a.Reset(context.Background(), domain.RepositoryId("repo-1"), "HEAD~1", domain.ResetModeMixed); err != nil {
		t.Fatalf("Reset(ref): %v", err)
	}
	if got := gitRun(t, dir, "rev-parse", "HEAD"); got == head {
		t.Error("HEAD unchanged after reset to HEAD~1")
	}
}

// TestResetErrors proves an unspecified mode, an unresolvable target and a
// leading-dash target all fail with RESET_FAILED.
func TestResetErrors(t *testing.T) {
	dir := initRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	cases := []struct {
		name string
		to   string
		mode domain.ResetMode
	}{
		{"unspecified mode", "HEAD~1", domain.ResetModeUnspecified},
		{"unresolvable target", "no-such-ref", domain.ResetModeSoft},
		{"leading dash", "-dash", domain.ResetModeSoft},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := a.Reset(ctx, repoID, tc.to, tc.mode); err == nil {
				t.Fatalf("Reset(%s) succeeded, want RESET_FAILED", tc.name)
			} else {
				assertAppCode(t, err, domain.ErrCodeResetFailed)
			}
		})
	}
}
