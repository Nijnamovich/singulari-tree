package service

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	gitadapter "github.com/SingulariTree/go-core/internal/adapter/git"
	"github.com/SingulariTree/go-core/internal/domain"
)

// This file holds the real-git parity guard for GraphService.Lanes: it builds
// actual repositories with the `git` binary and asserts the lane index computed
// in Go equals the `*` column that `git log --graph --oneline --topo-order`
// draws for the same commit. It is intentionally end-to-end at the Git layer
// (no mocked DAG) because the DoD is "lanes match `git log --graph`".

// parityRepoPort is a minimal domain.RepoPort that resolves any id to a fixed
// repository path, mirroring adapter/git tests.
type parityRepoPort struct{ fsPath string }

func (p *parityRepoPort) Open(context.Context, string) (*domain.Repository, error) {
	return nil, domain.ErrRepoNotFound
}
func (p *parityRepoPort) List(context.Context) ([]domain.Repository, error) { return nil, nil }
func (p *parityRepoPort) Remove(context.Context, domain.RepositoryId) error { return nil }
func (p *parityRepoPort) Get(_ context.Context, id domain.RepositoryId) (*domain.Repository, error) {
	return &domain.Repository{ID: id, FsPath: p.fsPath}, nil
}
func (p *parityRepoPort) Relocate(_ context.Context, id domain.RepositoryId, fsPath string) (*domain.Repository, error) {
	return &domain.Repository{ID: id, FsPath: fsPath}, nil
}

// parityGit runs `git -C dir <args...>` with deterministic identity/date env and
// fails the test on error.
func parityGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	full := append([]string{"-C", dir}, args...)
	cmd := exec.Command("git", full...)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Parity Test",
		"GIT_AUTHOR_EMAIL=parity@example.com",
		"GIT_COMMITTER_NAME=Parity Test",
		"GIT_COMMITTER_EMAIL=parity@example.com",
		// Fixed dates keep the repo hash-stable without asserting on hashes.
		"GIT_AUTHOR_DATE=2020-01-01T00:00:00Z",
		"GIT_COMMITTER_DATE=2020-01-01T00:00:00Z",
		"GIT_TERMINAL_PROMPT=0",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// pinNoAutocrlf forces LF line endings for every git process spawned by this
// test binary: parityGit's own commands and, through os.Environ(), the
// production git adapter's subprocesses (internal/adapter/git/adapter.go). Git
// for Windows defaults to core.autocrlf=true, so without this a
// checkout/merge can materialise CRLF bytes and make byte-level fixtures
// non-portable. The environment-config form is used rather than a
// `-c core.autocrlf=false` argv flag because the adapter spawns its own git
// with an env built from os.Environ(), which never sees a flag passed to
// parityGit. Identical to the grpc package's fix and to commit 947c552's
// fs.realpathSync.native precedent.
func pinNoAutocrlf(t *testing.T) {
	t.Helper()
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "core.autocrlf")
	t.Setenv("GIT_CONFIG_VALUE_0", "false")
}

// parityInitRepo creates an empty repo whose initial branch is `main`.
func parityInitRepo(t *testing.T) string {
	t.Helper()
	pinNoAutocrlf(t)
	dir := t.TempDir()
	parityGit(t, dir, "init", "-q")
	parityGit(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")
	parityGit(t, dir, "config", "user.email", "parity@example.com")
	parityGit(t, dir, "config", "user.name", "Parity Test")
	parityGit(t, dir, "config", "commit.gpgsign", "false")
	return dir
}

// parityCommit writes a distinct file (so merges never conflict) and commits it.
func parityCommit(t *testing.T, dir, file, msg string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, file), []byte(msg+"\n"), 0o644); err != nil {
		t.Fatalf("write %s: %v", file, err)
	}
	parityGit(t, dir, "add", file)
	parityGit(t, dir, "commit", "-q", "-m", msg)
}

// graphRow is one commit row parsed out of `git log --graph --oneline`.
type graphRow struct {
	column int
	hash   string
}

// parseGraphRows extracts the commit rows from `git log --graph --oneline`
// output. Each commit row has the form <prefix>*<connectors><abbrev-hash><subject>,
// where the graph prefix uses two characters per column, so the column is
// len(prefix)/2. Rows without a commit node (e.g. "|\", "|/") are skipped.
func parseGraphRows(t *testing.T, out string) []graphRow {
	t.Helper()
	const connectors = " |-/\\.*"
	var rows []graphRow
	for _, line := range strings.Split(out, "\n") {
		star := strings.IndexByte(line, '*')
		if star < 0 {
			continue
		}
		rest := line[star+1:]
		i := 0
		for i < len(rest) && strings.IndexByte(connectors, rest[i]) >= 0 {
			i++
		}
		tok := rest[i:]
		if j := strings.IndexByte(tok, ' '); j >= 0 {
			tok = tok[:j]
		}
		if len(tok) < 7 || strings.Trim(tok, "0123456789abcdef") != "" {
			continue // not a commit row
		}
		rows = append(rows, graphRow{column: star / 2, hash: tok})
	}
	return rows
}

// assertLanesMatchGitGraph is the parity oracle: it lists commits through the
// production git adapter (same --topo-order the service consumes), computes
// lanes, then checks each row's lane index against the `*` column from
// `git log --graph --oneline --topo-order`.
func assertLanesMatchGitGraph(t *testing.T, dir string) {
	t.Helper()
	ctx := context.Background()
	repoID := domain.RepositoryId("parity-repo")

	adapter := gitadapter.NewAdapter(&parityRepoPort{fsPath: dir})
	commits, total, err := adapter.List(ctx, repoID, nil, 0, 1000)
	if err != nil {
		t.Fatalf("adapter.List: %v", err)
	}
	if total != len(commits) {
		t.Fatalf("adapter.List total = %d, len = %d", total, len(commits))
	}

	lanes, err := NewGraphService(nil, nil).Lanes(ctx, repoID, commits)
	if err != nil {
		t.Fatalf("Lanes: %v", err)
	}

	graph := parityGit(t, dir, "log", "--graph", "--oneline", "--topo-order")
	rows := parseGraphRows(t, graph)
	if len(rows) != len(commits) {
		t.Fatalf("parsed %d graph rows, adapter listed %d commits\n%s", len(rows), len(commits), graph)
	}
	for i := range rows {
		if !strings.HasPrefix(commits[i].Oid.Hex, rows[i].hash) {
			t.Fatalf("row %d: graph hash %q does not match adapter commit %s (order mismatch)\n%s",
				i, rows[i].hash, commits[i].Oid.Hex, graph)
		}
		if lanes[i].Index != rows[i].column {
			t.Errorf("commit %s: lane index = %d, git graph column = %d\n%s",
				rows[i].hash, lanes[i].Index, rows[i].column, graph)
		}
	}
	// Log the lane vector for each topology to make failures easy to read.
	idx := make([]string, len(lanes))
	for i := range lanes {
		idx[i] = strconv.Itoa(lanes[i].Index)
	}
	t.Logf("parity ok (%d rows): lanes=[%s]", len(lanes), strings.Join(idx, ","))
}

// TestLanesParityWithGitGraph is the real-git parity guard for the DoD "lanes
// match `git log --graph`". It covers a linear chain, a simple branch+merge
// (the convergence counterexample), and a 3-parent octopus merge. Branches use
// disjoint files so no merge conflicts arise.
//
// Known gap (out of scope here): git dynamically *shifts* column positions when
// a new branch is opened while an unrelated side lane already occupies the slot
// to the right, whereas Lanes uses fixed slots and the lowest free column. For
// a topology where that matters (two stacked branch+merge pairs forked at the
// same base), Lanes can place a side lane one column to the right of git. That
// is a pre-existing limitation of the fixed-slot model, independent of the
// convergence fix, and is documented on GraphService.Lanes; the topologies
// below are the committed contract.
func TestLanesParityWithGitGraph(t *testing.T) {
	cases := []struct {
		name  string
		build func(t *testing.T, dir string)
	}{
		{"linear", buildParityLinear},
		{"branch_merge", buildParityBranchMerge},
		{"octopus", buildParityOctopus},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := parityInitRepo(t)
			tc.build(t, dir)
			assertLanesMatchGitGraph(t, dir)
		})
	}
}

// buildParityLinear: base -> c2 -> c3 (newest last).
func buildParityLinear(t *testing.T, dir string) {
	parityCommit(t, dir, "base.txt", "base")
	parityCommit(t, dir, "c2.txt", "c2")
	parityCommit(t, dir, "c3.txt", "c3")
}

// buildParityBranchMerge is the counterexample topology (branch off a1, land
// a2 on main, merge, then tail):
//
//   - tail
//   - merge
//     |\
//     | * b2
//     | * b1
//   - | a2
//     |/
//   - a1
//   - base
func buildParityBranchMerge(t *testing.T, dir string) {
	parityCommit(t, dir, "base.txt", "base")
	parityCommit(t, dir, "a1.txt", "a1")
	parityGit(t, dir, "checkout", "-q", "-b", "b")
	parityCommit(t, dir, "b1.txt", "b1")
	parityCommit(t, dir, "b2.txt", "b2")
	parityGit(t, dir, "checkout", "-q", "main")
	parityCommit(t, dir, "a2.txt", "a2")
	parityGit(t, dir, "merge", "-q", "--no-ff", "b", "-m", "merge")
	parityCommit(t, dir, "tail.txt", "tail")
}

// buildParityOctopus builds a real 3-parent octopus merge:
//
//	*-.   merge
//	|\ \
//	| | * x
//	| * | b
//	| |/
//	* / a
//	|/
//	* base
func buildParityOctopus(t *testing.T, dir string) {
	parityCommit(t, dir, "base.txt", "base")
	parityGit(t, dir, "checkout", "-q", "-b", "a")
	parityCommit(t, dir, "a.txt", "a")
	parityGit(t, dir, "checkout", "-q", "-b", "b", "main")
	parityCommit(t, dir, "b.txt", "b")
	parityGit(t, dir, "checkout", "-q", "-b", "x", "main")
	parityCommit(t, dir, "x.txt", "x")
	parityGit(t, dir, "checkout", "-q", "a")
	parityGit(t, dir, "merge", "-q", "b", "x", "-m", "merge")
}
