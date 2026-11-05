package git

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// TestParseUnifiedDiff is a pure-helper test covering hunk/line parsing,
// additions/deletions and the no-newline marker.
func TestParseUnifiedDiff(t *testing.T) {
	raw := strings.Join([]string{
		"diff --git a/f.txt b/f.txt",
		"index 83db48f..bac6ef6 100644",
		"--- a/f.txt",
		"+++ b/f.txt",
		"@@ -1,3 +1,4 @@",
		" line1",
		"-line2",
		"+CHANGED",
		" line3",
		"+line4",
		"\\ No newline at end of file",
		"",
	}, "\n")

	d := parseUnifiedDiff(raw)
	if d.IsBinary {
		t.Error("IsBinary = true, want false")
	}
	if d.HasConflictMarkers {
		t.Error("HasConflictMarkers = true, want false")
	}
	if d.Additions != 2 || d.Deletions != 1 {
		t.Errorf("Additions/Deletions = %d/%d, want 2/1", d.Additions, d.Deletions)
	}
	if len(d.Hunks) != 1 {
		t.Fatalf("len(Hunks) = %d, want 1", len(d.Hunks))
	}
	h := d.Hunks[0]
	if h.FromStart != 1 || h.FromLines != 3 || h.ToStart != 1 || h.ToLines != 4 {
		t.Errorf("hunk range = -%d,%d +%d,%d, want -1,3 +1,4", h.FromStart, h.FromLines, h.ToStart, h.ToLines)
	}

	want := []domain.DiffLine{
		{Kind: "context", Text: "line1"},
		{Kind: "removed", Text: "line2"},
		{Kind: "added", Text: "CHANGED"},
		{Kind: "context", Text: "line3"},
		{Kind: "added", Text: "line4", NoNewline: true},
	}
	if len(h.Lines) != len(want) {
		t.Fatalf("len(Lines) = %d, want %d (%+v)", len(h.Lines), len(want), h.Lines)
	}
	for i := range want {
		if h.Lines[i] != want[i] {
			t.Errorf("line[%d] = %+v, want %+v", i, h.Lines[i], want[i])
		}
	}
}

// TestParseUnifiedDiffHunkCountDefaults proves omitted counts default to 1,
// explicit 0 is preserved, and a multi-hunk diff concatenates hunks.
func TestParseUnifiedDiffHunkCountDefaults(t *testing.T) {
	raw := strings.Join([]string{
		"diff --git a/new.txt b/new.txt",
		"new file mode 100644",
		"--- /dev/null",
		"+++ b/new.txt",
		"@@ -0,0 +1,2 @@",
		"+first",
		"+second",
		"diff --git a/g.txt b/g.txt",
		"@@ -5 +6 @@",
		"-old",
		"+new",
		"",
	}, "\n")

	d := parseUnifiedDiff(raw)
	if len(d.Hunks) != 2 {
		t.Fatalf("len(Hunks) = %d, want 2", len(d.Hunks))
	}
	if got := d.Hunks[0]; got.FromStart != 0 || got.FromLines != 0 || got.ToStart != 1 || got.ToLines != 2 {
		t.Errorf("hunk[0] = -%d,%d +%d,%d, want -0,0 +1,2", got.FromStart, got.FromLines, got.ToStart, got.ToLines)
	}
	if got := d.Hunks[1]; got.FromStart != 5 || got.FromLines != 1 || got.ToStart != 6 || got.ToLines != 1 {
		t.Errorf("hunk[1] = -%d,%d +%d,%d, want -5,1 +6,1", got.FromStart, got.FromLines, got.ToStart, got.ToLines)
	}
}

// TestParseUnifiedDiffBinary proves both binary markers set IsBinary.
func TestParseUnifiedDiffBinary(t *testing.T) {
	for _, raw := range []string{
		"diff --git a/img.bin b/img.bin\nindex a..b 100644\nBinary files a/img.bin and b/img.bin differ\n",
		"diff --git a/img.bin b/img.bin\nindex a..b 100644\nGIT binary patch\nliteral 17\nYcmZQzWK\n\n",
	} {
		d := parseUnifiedDiff(raw)
		if !d.IsBinary {
			t.Errorf("IsBinary = false, want true for %q", raw)
		}
		if len(d.Hunks) != 0 || d.Additions != 0 || d.Deletions != 0 {
			t.Errorf("binary diff produced hunks/additions: %+v", d)
		}
	}
}

// TestParseUnifiedDiffConflictMarkers proves the conflict-marker detection:
// a real `<<<<<<<`/`>>>>>>>` block sets HasConflictMarkers while a lone
// `=======` separator (e.g. a Markdown setext heading underline) does not.
func TestParseUnifiedDiffConflictMarkers(t *testing.T) {
	t.Run("real block", func(t *testing.T) {
		raw := strings.Join([]string{
			"diff --git a/f.txt b/f.txt",
			"@@ -1,3 +1,7 @@",
			" context",
			"+<<<<<<< HEAD",
			"+ours",
			"+=======",
			"+theirs",
			"+>>>>>>> side",
			"",
		}, "\n")

		d := parseUnifiedDiff(raw)
		if !d.HasConflictMarkers {
			t.Fatal("HasConflictMarkers = false, want true")
		}
		if d.Additions != 5 {
			t.Errorf("Additions = %d, want 5", d.Additions)
		}
	})

	t.Run("lone separator", func(t *testing.T) {
		// A Markdown setext heading: text followed by an H1 underline of
		// '=' characters. The added `=======` line must not be mistaken for a
		// conflict marker.
		raw := strings.Join([]string{
			"diff --git a/doc.md b/doc.md",
			"@@ -1,2 +1,3 @@",
			" # Title",
			"+=======",
			" body",
			"",
		}, "\n")

		d := parseUnifiedDiff(raw)
		if d.HasConflictMarkers {
			t.Fatal("HasConflictMarkers = true, want false for a lone ======= line")
		}
		if d.Additions != 1 {
			t.Errorf("Additions = %d, want 1", d.Additions)
		}
	})
}

// TestDiffHeadToWorktree proves an empty `to` omits the right side, yielding
// `git diff <head>` (commit vs. working tree) with From/To populated correctly.
func TestDiffHeadToWorktree(t *testing.T) {
	dir := initRepo(t)
	headHex := gitRun(t, dir, "rev-parse", "HEAD")
	writeFile(t, filepath.Join(dir, "a.txt"), "changed\n")

	from, err := domain.NewOid(headHex)
	if err != nil {
		t.Fatalf("NewOid: %v", err)
	}

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	d, err := a.Diff(context.Background(), domain.RepositoryId("repo-1"), domain.DiffRequest{From: from})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if d.From.Hex != headHex {
		t.Errorf("From = %s, want %s", d.From.Hex, headHex)
	}
	if d.To.Hex != "" {
		t.Errorf("To = %s, want zero", d.To.Hex)
	}
	if d.Additions != 1 || d.Deletions != 1 {
		t.Errorf("Additions/Deletions = %d/%d, want 1/1", d.Additions, d.Deletions)
	}
	if len(d.Hunks) != 1 {
		t.Fatalf("len(Hunks) = %d, want 1", len(d.Hunks))
	}
}

// TestDiffTwoCommits proves a diff between two oids reports the added file.
func TestDiffTwoCommits(t *testing.T) {
	dir := initRepo(t)
	parentHex := gitRun(t, dir, "rev-parse", "HEAD~1")
	headHex := gitRun(t, dir, "rev-parse", "HEAD")

	from, _ := domain.NewOid(parentHex)
	to, _ := domain.NewOid(headHex)

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	d, err := a.Diff(context.Background(), domain.RepositoryId("repo-1"), domain.DiffRequest{From: from, To: to})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if d.From.Hex != parentHex || d.To.Hex != headHex {
		t.Errorf("From/To = %s/%s, want %s/%s", d.From.Hex, d.To.Hex, parentHex, headHex)
	}
	if d.Additions != 1 || d.Deletions != 0 {
		t.Errorf("Additions/Deletions = %d/%d, want 1/0", d.Additions, d.Deletions)
	}
}

// gitEmptyTreeOid resolves the empty-tree object id independently of the
// adapter, so a test can assert Diff's root-commit From without reusing the
// production helper.
func gitEmptyTreeOid(t *testing.T, dir string) string {
	t.Helper()
	cmd := exec.Command("git", "-C", dir, "hash-object", "-t", "tree", "--stdin")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("hash-object empty tree: %v", err)
	}
	return strings.TrimSpace(string(out))
}

// TestDiffRootCommit proves a root commit (empty `from`, non-empty `to`) is
// diffed empty-tree -> commit: all-added hunks and the empty-tree oid in
// From. Before the fix an empty `from` was omitted, so `git diff <to>` rendered
// the inverse commit -> working-tree diff and folded in working-tree changes.
func TestDiffRootCommit(t *testing.T) {
	dir := initRepo(t)
	rootHex := gitRun(t, dir, "rev-parse", "HEAD~1")
	emptyTree := gitEmptyTreeOid(t, dir)

	to, err := domain.NewOid(rootHex)
	if err != nil {
		t.Fatalf("NewOid: %v", err)
	}

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	d, err := a.Diff(ctx, repoID, domain.DiffRequest{To: to})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if d.From.Hex != emptyTree {
		t.Errorf("From = %s, want empty tree %s", d.From.Hex, emptyTree)
	}
	if d.To.Hex != rootHex {
		t.Errorf("To = %s, want %s", d.To.Hex, rootHex)
	}
	// The root commit adds a.txt ("one\n"): one added line, no deletions.
	if d.Additions != 1 || d.Deletions != 0 {
		t.Errorf("Additions/Deletions = %d/%d, want 1/0", d.Additions, d.Deletions)
	}
	if len(d.Hunks) != 1 {
		t.Fatalf("len(Hunks) = %d, want 1", len(d.Hunks))
	}
	if got := d.Hunks[0].Lines; len(got) != 1 || got[0].Kind != "added" || got[0].Text != "one" {
		t.Errorf("lines = %+v, want a single added %q", got, "one")
	}

	// A dirty working tree must not leak into the root-commit diff: the left
	// side is the empty tree, not the working tree.
	writeFile(t, filepath.Join(dir, "a.txt"), "changed\n")
	dirty, err := a.Diff(ctx, repoID, domain.DiffRequest{To: to})
	if err != nil {
		t.Fatalf("Diff(dirty): %v", err)
	}
	if dirty.Additions != 1 || dirty.Deletions != 0 {
		t.Errorf("dirty root diff Additions/Deletions = %d/%d, want 1/0", dirty.Additions, dirty.Deletions)
	}
	if dirty.From.Hex != emptyTree {
		t.Errorf("dirty From = %s, want empty tree %s", dirty.From.Hex, emptyTree)
	}
}

// TestDiffBothEmpty proves both-empty produces `git diff` (index vs. working
// tree): empty on a clean tree, populated once a tracked file is modified.
func TestDiffBothEmpty(t *testing.T) {
	dir := initRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	d, err := a.Diff(ctx, repoID, domain.DiffRequest{})
	if err != nil {
		t.Fatalf("Diff(clean): %v", err)
	}
	if len(d.Hunks) != 0 || d.Additions != 0 || d.Deletions != 0 {
		t.Fatalf("clean diff = %+v, want empty", d)
	}

	writeFile(t, filepath.Join(dir, "a.txt"), "changed\n")
	d, err = a.Diff(ctx, repoID, domain.DiffRequest{})
	if err != nil {
		t.Fatalf("Diff(dirty): %v", err)
	}
	if d.Additions != 1 || d.Deletions != 1 {
		t.Errorf("dirty Additions/Deletions = %d/%d, want 1/1", d.Additions, d.Deletions)
	}
}

// TestDiffBinary proves a changed binary file is flagged IsBinary.
func TestDiffBinary(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "img.bin"), "\x00\x01\x02binary")
	gitRun(t, dir, "add", "img.bin")
	gitRun(t, dir, "commit", "-q", "-m", "add binary")
	writeFile(t, filepath.Join(dir, "img.bin"), "\x00\x01\x03changed")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	d, err := a.Diff(context.Background(), domain.RepositoryId("repo-1"), domain.DiffRequest{})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if !d.IsBinary {
		t.Fatalf("IsBinary = false, want true (%+v)", d)
	}
}

// TestDiffInvalidOid proves an invalid hex oid yields a typed DIFF_FAILED.
func TestDiffInvalidOid(t *testing.T) {
	dir := initRepo(t)
	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	if _, err := a.Diff(ctx, repoID, domain.DiffRequest{From: domain.Oid{Hex: "not-a-hash"}}); err == nil {
		t.Error("Diff(invalid from) succeeded, want DIFF_FAILED")
	} else {
		assertAppCode(t, err, domain.ErrCodeDiffFailed)
	}
	if _, err := a.Diff(ctx, repoID, domain.DiffRequest{To: domain.Oid{Hex: "zzz"}}); err == nil {
		t.Error("Diff(invalid to) succeeded, want DIFF_FAILED")
	} else {
		assertAppCode(t, err, domain.ErrCodeDiffFailed)
	}
}
