package git

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// TestParseUnifiedDiffPerFile proves a multi-file raw diff is grouped into
// Files with per-file paths, statuses and counts, while the deprecated flat
// Hunks list stays the concatenation of every file's hunks.
func TestParseUnifiedDiffPerFile(t *testing.T) {
	raw := strings.Join([]string{
		"diff --git a/a.txt b/a.txt",
		"index 111..222 100644",
		"--- a/a.txt",
		"+++ b/a.txt",
		"@@ -1,2 +1,3 @@",
		" one",
		"-two",
		"+TWO",
		"+three",
		"diff --git a/new.txt b/new.txt",
		"new file mode 100644",
		"index 000..333",
		"--- /dev/null",
		"+++ b/new.txt",
		"@@ -0,0 +1,1 @@",
		"+fresh",
		"",
	}, "\n")

	d := parseUnifiedDiff(raw)
	if len(d.Files) != 2 {
		t.Fatalf("len(Files) = %d, want 2 (%+v)", len(d.Files), d.Files)
	}
	a := d.Files[0]
	if a.Path != "a.txt" || a.Status != "M" || a.Additions != 2 || a.Deletions != 1 {
		t.Errorf("file[0] = %+v, want a.txt M +2 -1", a)
	}
	if len(a.Hunks) != 1 {
		t.Errorf("file[0] hunks = %d, want 1", len(a.Hunks))
	}
	n := d.Files[1]
	if n.Path != "new.txt" || n.Status != "A" || n.Additions != 1 || n.Deletions != 0 {
		t.Errorf("file[1] = %+v, want new.txt A +1 -0", n)
	}
	// Flat list is the concatenation of both files' hunks.
	if len(d.Hunks) != 2 {
		t.Errorf("flat len(Hunks) = %d, want 2", len(d.Hunks))
	}
	if d.Additions != 3 || d.Deletions != 1 {
		t.Errorf("aggregate +%d -%d, want +3 -1", d.Additions, d.Deletions)
	}
}

// TestParseUnifiedDiffRenameAndBinary proves rename status/old_path and per-file
// binary detection.
func TestParseUnifiedDiffRenameAndBinary(t *testing.T) {
	raw := strings.Join([]string{
		"diff --git a/old.txt b/new.txt",
		"similarity index 100%",
		"rename from old.txt",
		"rename to new.txt",
		"diff --git a/img.bin b/img.bin",
		"index aaa..bbb 100644",
		"Binary files a/img.bin and b/img.bin differ",
		"",
	}, "\n")

	d := parseUnifiedDiff(raw)
	if len(d.Files) != 2 {
		t.Fatalf("len(Files) = %d, want 2", len(d.Files))
	}
	if r := d.Files[0]; r.Status != "R" || r.Path != "new.txt" || r.OldPath != "old.txt" {
		t.Errorf("rename file = %+v, want R new.txt<-old.txt", r)
	}
	if b := d.Files[1]; !b.IsBinary {
		t.Errorf("binary file = %+v, want IsBinary", b)
	}
	if !d.IsBinary {
		t.Error("aggregate IsBinary = false, want true")
	}
}

// TestParseUnifiedDiffTruncation proves the bounded payload cap sets Truncated
// and stops materializing hunks past MaxDiffHunks.
func TestParseUnifiedDiffTruncation(t *testing.T) {
	var b strings.Builder
	b.WriteString("diff --git a/big.txt b/big.txt\n@@ -0,0 +1,1 @@\n")
	for i := 0; i < MaxDiffHunks+10; i++ {
		b.WriteString("@@ -")
		b.WriteString("1")
		b.WriteString(",1 +1,1 @@\n")
		b.WriteString("+line\n")
	}
	d := parseUnifiedDiff(b.String())
	if !d.Truncated {
		t.Fatal("Truncated = false, want true")
	}
	if len(d.Files) != 1 {
		t.Fatalf("len(Files) = %d, want 1", len(d.Files))
	}
	if got := len(d.Files[0].Hunks); got != MaxDiffHunks {
		t.Errorf("materialized hunks = %d, want %d", got, MaxDiffHunks)
	}
	if len(d.Hunks) != MaxDiffHunks {
		t.Errorf("flat hunks = %d, want %d", len(d.Hunks), MaxDiffHunks)
	}
}

// TestDiffGroupsFiles proves the integration path groups a two-file working-tree
// diff per file.
func TestDiffGroupsFiles(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "a.txt"), "changed\n")
	writeFile(t, filepath.Join(dir, "b.txt"), "changed too\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	d, err := a.Diff(context.Background(), domain.RepositoryId("repo-1"), domain.DiffRequest{})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if len(d.Files) != 2 {
		t.Fatalf("len(Files) = %d, want 2 (%+v)", len(d.Files), d.Files)
	}
	paths := map[string]bool{}
	for _, f := range d.Files {
		paths[f.Path] = true
	}
	if !paths["a.txt"] || !paths["b.txt"] {
		t.Errorf("paths = %v, want a.txt and b.txt", paths)
	}
}

// TestDiffSingleFileSelector proves GetDiffRequest.path restricts the diff to
// one path and uses literal pathspecs.
func TestDiffSingleFileSelector(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "a.txt"), "changed\n")
	writeFile(t, filepath.Join(dir, "b.txt"), "changed too\n")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	d, err := a.Diff(context.Background(), domain.RepositoryId("repo-1"), domain.DiffRequest{Path: "a.txt"})
	if err != nil {
		t.Fatalf("Diff(path): %v", err)
	}
	if len(d.Files) != 1 || d.Files[0].Path != "a.txt" {
		t.Fatalf("Files = %+v, want only a.txt", d.Files)
	}
}

// TestDiffStagedSelector proves the staged flag diffs HEAD->index.
func TestDiffStagedSelector(t *testing.T) {
	dir := initRepo(t)
	writeFile(t, filepath.Join(dir, "a.txt"), "staged change\n")
	gitRun(t, dir, "add", "a.txt")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	d, err := a.Diff(context.Background(), domain.RepositoryId("repo-1"), domain.DiffRequest{Staged: true})
	if err != nil {
		t.Fatalf("Diff(staged): %v", err)
	}
	if len(d.Files) != 1 || d.Files[0].Path != "a.txt" {
		t.Fatalf("Files = %+v, want only staged a.txt", d.Files)
	}
	if d.Files[0].Additions < 1 {
		t.Errorf("staged additions = %d, want >= 1", d.Files[0].Additions)
	}
}

// TestDiffRenameOldPath proves a staged rename reports Status R and OldPath.
func TestDiffRenameOldPath(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "mv", "a.txt", "renamed.txt")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	d, err := a.Diff(context.Background(), domain.RepositoryId("repo-1"), domain.DiffRequest{Staged: true})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	var found bool
	for _, f := range d.Files {
		if f.Path == "renamed.txt" {
			found = true
			if f.Status != "R" || f.OldPath != "a.txt" {
				t.Errorf("rename = %+v, want R a.txt->renamed.txt", f)
			}
		}
	}
	if !found {
		t.Fatalf("renamed.txt missing from %+v", d.Files)
	}
}

// indexContent reads the staged (index) content of path.
func indexContent(t *testing.T, dir, path string) string {
	t.Helper()
	return gitRun(t, dir, "show", ":"+path)
}

// fileExists reports whether path exists.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// fileContent reads a worktree file, failing the test on error.
func fileContent(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}
