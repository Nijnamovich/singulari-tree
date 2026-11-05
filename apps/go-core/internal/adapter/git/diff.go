package git

import (
	"context"
	"regexp"
	"strconv"
	"strings"

	"github.com/SingulariTree/go-core/internal/domain"
)

// hunkHeaderRe matches a unified-diff hunk header `@@ -a[,b] +c[,d] @@`. The
// optional counts default to 1 when omitted (git omits `,1`); an explicit 0 is
// valid (e.g. a file creation starts at `-0,0`). Any trailing section heading
// after the closing `@@` is ignored.
var hunkHeaderRe = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)

// Bounded diff payload caps (ADR-0020 (c)). The core never returns an unbounded
// diff: when a cap is reached, parsing stops materializing hunks/lines and
// Diff.Truncated is set to true. Additions/deletions are still counted so the
// aggregate gauge stays accurate.
const (
	// MaxDiffHunks bounds the number of hunks materialized across all files.
	MaxDiffHunks = 500
	// MaxDiffLines bounds the number of diff lines materialized across all
	// hunks (context + added + removed).
	MaxDiffLines = 20000
)

// Diff returns the diff addressed by req (ADR-0020). The empty side carries an
// explicit convention so a root commit (which has no parent, so the renderer
// passes from = "") is diffed the right way round:
//
//   - empty from + non-empty to -> empty tree vs. to: the root-commit case,
//     where every file shows as added. The empty-tree oid is resolved with
//     `git hash-object -t tree --stdin` and returned in Diff.From.
//   - non-empty from + empty to -> from vs. working tree (`git diff <from>`).
//   - empty from + empty to     -> index vs. working tree (`git diff`).
//   - both non-empty            -> from vs. to (`git diff <from> <to>`).
//
// req.Staged selects HEAD->index (`git diff --cached`) instead of the default
// HEAD->worktree. req.Path restricts the diff to one path and is passed with
// `--literal-pathspecs` so pathspec magic in a file name cannot address other
// files. Non-empty oids are validated and failures yield a typed DIFF_FAILED.
//
// The result carries per-file sections (Diff.Files) plus the deprecated flat
// Diff.Hunks (every file's hunks concatenated in git order) for back-compat
// with the legacy viewer.
func (a *Adapter) Diff(ctx context.Context, repoID domain.RepositoryId, req domain.DiffRequest) (*domain.Diff, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}

	from := domain.Oid{}
	if strings.TrimSpace(req.From.Hex) != "" {
		o, oerr := domain.NewOid(req.From.Hex)
		if oerr != nil {
			return nil, diffFailed("invalid from oid: " + req.From.Hex)
		}
		from = o
	}
	to := domain.Oid{}
	if strings.TrimSpace(req.To.Hex) != "" {
		o, oerr := domain.NewOid(req.To.Hex)
		if oerr != nil {
			return nil, diffFailed("invalid to oid: " + req.To.Hex)
		}
		to = o
	}

	args := []string{"--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--unified=3"}
	if req.Staged {
		args = append(args, "--cached")
	}
	switch {
	case from.Hex == "" && to.Hex != "":
		// Root commit: the empty from is the empty tree, not "omit".
		empty, eerr := emptyTreeOid(ctx, fsPath)
		if eerr != nil {
			return nil, diffFailedFromGit(eerr.Error())
		}
		from = empty
		args = append(args, from.Hex, to.Hex)
	case from.Hex != "" && to.Hex == "":
		// Commit vs. working tree.
		args = append(args, from.Hex)
	case from.Hex == "" && to.Hex == "":
		// Index vs. working tree (or HEAD vs. index when staged).
	default:
		// Commit vs. commit.
		args = append(args, from.Hex, to.Hex)
	}
	if req.Path != "" {
		if !validPathArg(req.Path) {
			return nil, diffFailed("invalid path")
		}
		args = append(args, "--", req.Path)
	}

	out, err := runGit(ctx, fsPath, args...)
	if err != nil {
		return nil, diffFailedFromGit(err.Error())
	}

	d := parseUnifiedDiff(out)
	d.From = from
	d.To = to
	return d, nil
}

// emptyTreeOid resolves the repository's empty-tree object id via
// `git hash-object -t tree --stdin` (empty stdin). Diff uses it as the left
// side of a root-commit diff, so an empty `from` means "empty tree" rather
// than the working tree. It is a single extra git call per root diff.
func emptyTreeOid(ctx context.Context, fsPath string) (domain.Oid, error) {
	out, err := runGitStdin(ctx, fsPath, nil, "hash-object", "-t", "tree", "--stdin")
	if err != nil {
		return domain.Oid{}, err
	}
	o, oerr := domain.NewOid(strings.TrimSpace(out))
	if oerr != nil {
		return domain.Oid{}, diffFailed("could not resolve empty tree oid")
	}
	return o, nil
}

// parseUnifiedDiff parses `git diff` output into a domain.Diff, grouping hunks
// per file (ADR-0020) while also populating the deprecated flat Hunks list. It
// is a pure helper (unit-tested directly). It recognises `diff --git` file
// boundaries, rename/copy/mode lines, binary markers (`Binary files ... differ`
// and `GIT binary patch`), hunk headers and the ` `, `+`, `-` line prefixes.
// `\ No newline at end of file` marks the preceding line's NoNewline.
// Additions/Deletions count `+`/`-` lines; HasConflictMarkers is set when any
// added line begins with a conflict marker (`<<<<<<<` or `>>>>>>>`). The bare
// `=======` separator is not treated as a conflict marker because ordinary
// content (e.g. a Markdown setext heading underline) uses the same characters.
// The payload is capped at MaxDiffHunks/MaxDiffLines; Diff.Truncated reports a
// cap hit.
func parseUnifiedDiff(out string) *domain.Diff {
	d := &domain.Diff{Hunks: []domain.Hunk{}, Files: []domain.FileDiff{}}
	acc := &diffAccumulator{d: d}
	for _, line := range strings.Split(out, "\n") {
		acc.consume(line)
	}
	// The deprecated flat Hunks list is the concatenation of every file's hunks
	// in git order; it is rebuilt here so it shares the per-file hunk content
	// (the per-file slices are the source of truth).
	for i := range d.Files {
		d.Hunks = append(d.Hunks, d.Files[i].Hunks...)
	}
	return d
}

// diffAccumulator is the single-pass state machine behind parseUnifiedDiff.
type diffAccumulator struct {
	d *domain.Diff

	cur *domain.FileDiff // file currently being parsed

	inHunk    bool
	curHunk   *domain.Hunk // materialized hunk, or nil when capped
	hunkCount int
	lineCount int
}

// consume processes one diff line.
func (acc *diffAccumulator) consume(line string) {
	switch {
	case strings.HasPrefix(line, "diff --git "):
		acc.startFile(line)
	case strings.HasPrefix(line, "@@"):
		acc.startHunk(line)
	case strings.HasPrefix(line, "GIT binary patch"):
		acc.setBinary()
	case strings.HasPrefix(line, "Binary files "):
		acc.setBinary()
	case !acc.inHunk:
		// File header metadata (mode, index, similarity, rename/copy, ---/+++).
		acc.fileMeta(line)
	case strings.HasPrefix(line, "\\"):
		acc.noNewline()
	case strings.HasPrefix(line, "+"):
		acc.addLine(domain.DiffLine{Kind: "added", Text: line[1:]}, true)
	case strings.HasPrefix(line, "-"):
		acc.addLine(domain.DiffLine{Kind: "removed", Text: line[1:]}, false)
	case strings.HasPrefix(line, " "):
		acc.addLine(domain.DiffLine{Kind: "context", Text: line[1:]}, false)
	}
}

// startFile begins a new FileDiff from a `diff --git` header line.
func (acc *diffAccumulator) startFile(line string) {
	acc.inHunk = false
	acc.curHunk = nil
	rest := strings.TrimPrefix(line, "diff --git ")
	oldPath, newPath := parseDiffGitPaths(rest)
	acc.cur = &domain.FileDiff{
		Path:    newPath,
		OldPath: "",
		Status:  "M",
		Hunks:   []domain.Hunk{},
	}
	if oldPath != "" && oldPath != newPath {
		acc.cur.OldPath = oldPath
	}
	acc.d.Files = append(acc.d.Files, *acc.cur)
	acc.cur = &acc.d.Files[len(acc.d.Files)-1]
}

// fileMeta applies the file-header metadata lines that refine path/status:
// mode lines, rename/copy lines and the `---`/`+++` path lines.
func (acc *diffAccumulator) fileMeta(line string) {
	if acc.cur == nil {
		return
	}
	switch {
	case strings.HasPrefix(line, "new file mode"):
		acc.cur.Status = "A"
	case strings.HasPrefix(line, "deleted file mode"):
		acc.cur.Status = "D"
	case strings.HasPrefix(line, "rename from "):
		acc.cur.OldPath = unquoteDiffPath(strings.TrimPrefix(line, "rename from "))
		acc.cur.Status = "R"
	case strings.HasPrefix(line, "rename to "):
		acc.cur.Path = unquoteDiffPath(strings.TrimPrefix(line, "rename to "))
		acc.cur.Status = "R"
	case strings.HasPrefix(line, "copy from "):
		acc.cur.OldPath = unquoteDiffPath(strings.TrimPrefix(line, "copy from "))
		acc.cur.Status = "C"
	case strings.HasPrefix(line, "copy to "):
		acc.cur.Path = unquoteDiffPath(strings.TrimPrefix(line, "copy to "))
		acc.cur.Status = "C"
	case strings.HasPrefix(line, "--- "):
		p := unquoteDiffPath(strings.TrimPrefix(line, "--- "))
		if p == "/dev/null" {
			acc.cur.Status = "A"
		} else if acc.cur.Status == "M" {
			acc.cur.Path = stripDiffPrefix(p)
		}
	case strings.HasPrefix(line, "+++ "):
		p := unquoteDiffPath(strings.TrimPrefix(line, "+++ "))
		if p == "/dev/null" {
			acc.cur.Status = "D"
		} else {
			acc.cur.Path = stripDiffPrefix(p)
		}
	}
}

// startHunk begins a hunk, applying the bounded cap. When a cap is already
// reached the hunk is not materialized and the diff is marked truncated.
func (acc *diffAccumulator) startHunk(line string) {
	if acc.cur == nil {
		return
	}
	acc.inHunk = true
	m := hunkHeaderRe.FindStringSubmatch(line)
	if m == nil {
		acc.curHunk = nil
		return
	}
	if acc.hunkCount >= MaxDiffHunks || acc.lineCount >= MaxDiffLines {
		acc.d.Truncated = true
		acc.curHunk = nil
		return
	}
	h := domain.Hunk{
		FromStart: atoiDefault(m[1], 0),
		FromLines: atoiDefault(m[2], 1),
		ToStart:   atoiDefault(m[3], 0),
		ToLines:   atoiDefault(m[4], 1),
	}
	acc.cur.Hunks = append(acc.cur.Hunks, h)
	acc.curHunk = &acc.cur.Hunks[len(acc.cur.Hunks)-1]
	acc.hunkCount++
}

// setBinary flags the current file (and the aggregate diff) as binary.
func (acc *diffAccumulator) setBinary() {
	if acc.cur == nil {
		return
	}
	acc.cur.IsBinary = true
	acc.d.IsBinary = true
}

// noNewline marks the last materialized line of the current hunk.
func (acc *diffAccumulator) noNewline() {
	if acc.curHunk == nil {
		return
	}
	if n := len(acc.curHunk.Lines); n > 0 {
		acc.curHunk.Lines[n-1].NoNewline = true
	}
}

// addLine counts an addition/removal and, space permitting, materializes the
// line into the current hunk. Counting continues even after the cap so the
// aggregate additions/deletions stay accurate.
func (acc *diffAccumulator) addLine(dl domain.DiffLine, added bool) {
	if added {
		acc.d.Additions++
		if acc.cur != nil {
			acc.cur.Additions++
		}
		if hasConflictMarker(dl.Text) {
			acc.d.HasConflictMarkers = true
			if acc.cur != nil {
				acc.cur.HasConflictMarkers = true
			}
		}
	} else if dl.Kind == "removed" {
		acc.d.Deletions++
		if acc.cur != nil {
			acc.cur.Deletions++
		}
	}
	if acc.curHunk == nil {
		return
	}
	if acc.lineCount >= MaxDiffLines {
		acc.d.Truncated = true
		acc.curHunk = nil
		return
	}
	acc.curHunk.Lines = append(acc.curHunk.Lines, dl)
	acc.lineCount++
}

// parseDiffGitPaths extracts the old and new paths from the remainder of a
// `diff --git ` line. Unquoted paths contain no spaces (git quotes any path
// with special characters), so splitting on the first space is unambiguous;
// quoted paths are parsed as two C-style quoted tokens.
func parseDiffGitPaths(rest string) (oldPath, newPath string) {
	if strings.HasPrefix(rest, `"`) {
		first, remainder, ok := consumeCQuoted(rest)
		if !ok {
			return "", ""
		}
		second, _, ok2 := consumeCQuoted(strings.TrimLeft(remainder, " "))
		if !ok2 {
			return "", ""
		}
		return stripDiffPrefix(first), stripDiffPrefix(second)
	}
	sp := strings.IndexByte(rest, ' ')
	if sp < 0 {
		p := stripDiffPrefix(rest)
		return p, p
	}
	return stripDiffPrefix(rest[:sp]), stripDiffPrefix(rest[sp+1:])
}

// consumeCQuoted parses one C-style quoted token at the start of s, returning
// the unquoted content and the remainder. It scans for the matching closing
// quote honouring backslash escapes.
func consumeCQuoted(s string) (value, rest string, ok bool) {
	if !strings.HasPrefix(s, `"`) {
		return "", s, false
	}
	end := -1
	escaped := false
	for i := 1; i < len(s); i++ {
		c := s[i]
		if escaped {
			escaped = false
			continue
		}
		if c == '\\' {
			escaped = true
			continue
		}
		if c == '"' {
			end = i
			break
		}
	}
	if end < 0 {
		return "", s, false
	}
	token := s[:end+1]
	if unquoted, err := strconv.Unquote(token); err == nil {
		return unquoted, s[end+1:], true
	}
	// Fall back to the raw inner text when Unquote rejects the escape sequence.
	return s[1:end], s[end+1:], true
}

// unquoteDiffPath decodes a `---`/`+++`/rename path token if it is quoted.
func unquoteDiffPath(p string) string {
	if strings.HasPrefix(p, `"`) {
		if v, _, ok := consumeCQuoted(p); ok {
			return v
		}
	}
	return p
}

// stripDiffPrefix removes git's default `a/` or `b/` source/destination prefix.
func stripDiffPrefix(p string) string {
	if strings.HasPrefix(p, "a/") || strings.HasPrefix(p, "b/") {
		return p[2:]
	}
	return p
}

// hasConflictMarker reports whether a diff line's content begins with a merge
// conflict marker. Only the distinctive 7-character start/end markers count;
// the central `=======` is intentionally excluded because a lone separator line
// (e.g. a Markdown setext heading underline) is common, non-conflicting content.
func hasConflictMarker(text string) bool {
	return strings.HasPrefix(text, "<<<<<<<") ||
		strings.HasPrefix(text, ">>>>>>>")
}

// atoiDefault parses s, returning def when s is empty or not a number.
func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

// diffFailed builds a typed DIFF_FAILED error with a trimmed, bounded message.
func diffFailed(message string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeDiffFailed,
		Message: truncateValidUTF8(strings.TrimSpace(message), maxCheckoutErrLen),
	}
}

// diffFailedFromGit builds the DIFF_FAILED error for a failed `git diff`: a
// short summary plus the bounded raw text.
func diffFailedFromGit(rawErr string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeDiffFailed,
		Message: shortGitSummaryWithFallback(rawErr, "git diff failed"),
		Details: map[string]string{"raw": boundCheckoutRaw(rawErr)},
	}
}
