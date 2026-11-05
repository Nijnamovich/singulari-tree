package git

import (
	"context"
	"strconv"
	"strings"

	"github.com/SingulariTree/go-core/internal/domain"
)

// rawFileSection is one `diff --git` section parsed from raw unified-diff
// output, retaining the exact header lines (and quoted paths) so a patch can be
// reassembled verbatim without re-quoting.
type rawFileSection struct {
	header []string // lines before the first hunk: diff --git, index, ---, +++
	hunks  []rawHunk
}

// rawHunk is one hunk with its raw `@@ ... @@` header and raw content lines
// (each including its ` `/`+`/`-`/`\` prefix).
type rawHunk struct {
	header string
	lines  []string
}

// parseRawDiffSections splits raw `git diff` output into per-file sections. Only
// lines that belong to a hunk (prefix ` `, `+`, `-` or `\`) are retained as
// content; everything between `diff --git` and the first `@@` is header.
func parseRawDiffSections(out string) []rawFileSection {
	var sections []rawFileSection
	var cur *rawFileSection
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "diff --git ") {
			sections = append(sections, rawFileSection{})
			cur = &sections[len(sections)-1]
			cur.header = append(cur.header, line)
			continue
		}
		if cur == nil {
			continue
		}
		if strings.HasPrefix(line, "@@") {
			cur.hunks = append(cur.hunks, rawHunk{header: line})
			continue
		}
		if len(cur.hunks) == 0 {
			cur.header = append(cur.header, line)
			continue
		}
		if line == "" {
			continue
		}
		switch line[0] {
		case ' ', '+', '-', '\\':
			last := &cur.hunks[len(cur.hunks)-1]
			last.lines = append(last.lines, line)
		}
	}
	return sections
}

// findSection returns the section addressing path, matching either the new or
// the old (rename source) path.
func findSection(sections []rawFileSection, path string) (rawFileSection, bool) {
	for i := range sections {
		oldPath, newPath := parseDiffGitPaths(strings.TrimPrefix(sections[i].header[0], "diff --git "))
		if path == newPath || (oldPath != "" && path == oldPath) {
			return sections[i], true
		}
	}
	return rawFileSection{}, false
}

// sectionPatch reassembles a single whole hunk as a minimal patch: the file
// header verbatim plus the requested hunk.
func sectionPatch(sec rawFileSection, hunkIdx int) string {
	var b strings.Builder
	for _, h := range sec.header {
		b.WriteString(h)
		b.WriteByte('\n')
	}
	b.WriteString(sec.hunks[hunkIdx].header)
	b.WriteByte('\n')
	for _, l := range sec.hunks[hunkIdx].lines {
		b.WriteString(l)
		b.WriteByte('\n')
	}
	return b.String()
}

// buildSelected reconstructs a hunk containing only the selected changed lines
// (0-based indices into hunk.lines; context lines are always kept). It returns a
// patch in the target direction:
//
//   - reverse=false (stage): from the diff's old side toward its new side; an
//     unselected added line is omitted, an unselected removed line becomes
//     context.
//   - reverse=true (unstage/discard): from the diff's new side back toward its
//     old side; an unselected added line becomes context, an unselected removed
//     line is omitted.
//
// Context/line numbering is derived from the diff hunk header so `git apply`
// can locate the hunk in the current content (the diff's new side for reverse,
// its old side for forward).
func buildSelected(sec rawFileSection, hunkIdx int, selected map[int]bool, reverse bool) (string, bool) {
	h := sec.hunks[hunkIdx]
	m := hunkHeaderRe.FindStringSubmatch(h.header)
	if m == nil {
		return "", false
	}
	fromStart := atoiDefault(m[1], 0)
	toStart := atoiDefault(m[3], 0)

	base := fromStart
	if reverse {
		base = toStart
	}

	var (
		out          []string
		oldCount     int
		newCount     int
		prevAppended bool
		anyChange    bool
	)
	for i, line := range h.lines {
		if line == "" {
			continue
		}
		prefix := line[0]
		content := line[1:]
		appended := false
		switch prefix {
		case ' ':
			out = append(out, " "+content)
			oldCount++
			newCount++
			appended = true
		case '+':
			if reverse {
				if selected[i] {
					out = append(out, "-"+content)
					oldCount++
					anyChange = true
				} else {
					out = append(out, " "+content)
					oldCount++
					newCount++
				}
			} else if selected[i] {
				out = append(out, "+"+content)
				newCount++
				anyChange = true
			}
			appended = true
		case '-':
			if reverse {
				if selected[i] {
					out = append(out, "+"+content)
					newCount++
					anyChange = true
					appended = true
				}
			} else if selected[i] {
				out = append(out, "-"+content)
				oldCount++
				anyChange = true
				appended = true
			} else {
				out = append(out, " "+content)
				oldCount++
				newCount++
				appended = true
			}
		case '\\':
			// `\ No newline at end of file`: retain only when the line it
			// follows was kept.
			if prevAppended && len(out) > 0 {
				out = append(out, line)
			}
		default:
			continue
		}
		prevAppended = appended
	}
	if !anyChange || len(out) == 0 {
		return "", false
	}

	var b strings.Builder
	for _, hl := range sec.header {
		b.WriteString(hl)
		b.WriteByte('\n')
	}
	b.WriteString("@@ -" + strconv.Itoa(base) + "," + strconv.Itoa(oldCount) +
		" +" + strconv.Itoa(base) + "," + strconv.Itoa(newCount) + " @@\n")
	for _, l := range out {
		b.WriteString(l)
		b.WriteByte('\n')
	}
	return b.String(), true
}

// applyPatch pipes a core-constructed patch to `git apply`. cached targets the
// index (`--cached`); reverse applies it in the opposite direction (`-R`); all
// invocations carry `--literal-pathspecs` (a global option) for path safety and
// `--recount` so a hand-computed header can never block a valid patch.
func (a *Adapter) applyPatch(ctx context.Context, fsPath, patch string, cached, reverse bool) error {
	args := []string{"--literal-pathspecs", "apply", "--whitespace=nowarn", "--recount"}
	if cached {
		args = append(args, "--cached")
	}
	if reverse {
		args = append(args, "-R")
	}
	_, err := runGitStdin(ctx, fsPath, []byte(patch), args...)
	return err
}

// fileDiffRaw runs `git diff` (or `--cached`) restricted to path and returns the
// raw output. Paths are passed with `--literal-pathspecs`.
func (a *Adapter) fileDiffRaw(ctx context.Context, fsPath, path string, cached bool) (string, error) {
	args := []string{"--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--unified=3"}
	if cached {
		args = append(args, "--cached")
	}
	args = append(args, "--", path)
	return runGit(ctx, fsPath, args...)
}

// selectedIndices turns the wire line_indices into a set. An empty list means
// "the whole hunk" and is handled by the caller (whole-hunk path).
func selectedIndices(lineIndices []uint32) map[int]bool {
	if len(lineIndices) == 0 {
		return nil
	}
	set := make(map[int]bool, len(lineIndices))
	for _, i := range lineIndices {
		set[int(i)] = true
	}
	return set
}

// applyHunk is the shared engine for StageHunk/UnstageHunk/DiscardHunk. It
// re-derives the diff for path, selects the requested hunk (and lines), builds
// the minimal patch and applies it:
//
//   - stage:   worktree diff -> patch index->index+sel, `git apply --cached`.
//   - unstage: cached diff   -> patch HEAD->index (whole hunk) or index->index-sel
//     (line-level), `git apply --cached [-R]`.
//   - discard: worktree diff -> patch index->worktree (whole hunk) or
//     worktree->worktree-sel (line-level), `git apply [-R]` on the worktree.
func (a *Adapter) applyHunk(ctx context.Context, repoID domain.RepositoryId, path string, hunkIndex uint32, lineIndices []uint32, op hunkOp) error {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return err
	}
	if path == "" || !validPathArg(path) {
		return a.hunkOpError(op, "invalid path")
	}
	cached := op == opUnstage
	raw, err := a.fileDiffRaw(ctx, fsPath, path, cached)
	if err != nil {
		return a.hunkOpErrorFromGit(op, err.Error())
	}
	sections := parseRawDiffSections(raw)
	sec, ok := findSection(sections, path)
	if !ok {
		return a.hunkOpError(op, "no diff for path (untracked files are file-level only)")
	}
	if int(hunkIndex) >= len(sec.hunks) {
		return a.hunkOpError(op, "hunk index out of range")
	}

	selected := selectedIndices(lineIndices)
	whole := len(selected) == 0

	var patch string
	switch {
	case op == opStage:
		patch = sectionPatch(sec, int(hunkIndex))
		if !whole {
			var built bool
			patch, built = buildSelected(sec, int(hunkIndex), selected, false)
			if !built {
				return a.hunkOpError(op, "no selected lines to stage")
			}
		}
		if err := a.applyPatch(ctx, fsPath, patch, true, false); err != nil {
			return a.hunkOpErrorFromGit(op, err.Error())
		}
	case op == opUnstage:
		if whole {
			if err := a.applyPatch(ctx, fsPath, sectionPatch(sec, int(hunkIndex)), true, true); err != nil {
				return a.hunkOpErrorFromGit(op, err.Error())
			}
		} else {
			built, ok := buildSelected(sec, int(hunkIndex), selected, true)
			if !ok {
				return a.hunkOpError(op, "no selected lines to unstage")
			}
			if err := a.applyPatch(ctx, fsPath, built, true, false); err != nil {
				return a.hunkOpErrorFromGit(op, err.Error())
			}
		}
	case op == opDiscard:
		if whole {
			if err := a.applyPatch(ctx, fsPath, sectionPatch(sec, int(hunkIndex)), false, true); err != nil {
				return a.hunkOpErrorFromGit(op, err.Error())
			}
		} else {
			built, ok := buildSelected(sec, int(hunkIndex), selected, true)
			if !ok {
				return a.hunkOpError(op, "no selected lines to discard")
			}
			if err := a.applyPatch(ctx, fsPath, built, false, false); err != nil {
				return a.hunkOpErrorFromGit(op, err.Error())
			}
		}
	}
	return nil
}

// hunkOp names which staging operation applyHunk runs.
type hunkOp int

const (
	opStage hunkOp = iota
	opUnstage
	opDiscard
)

// hunkOpError builds the typed error for a hunk operation (STAGE_FAILED for
// stage/unstage, DISCARD_FAILED for discard).
func (a *Adapter) hunkOpError(op hunkOp, message string) domain.AppError {
	if op == opDiscard {
		return discardFailed(message)
	}
	return stageFailed(message)
}

// hunkOpErrorFromGit builds the typed error for a failed hunk git command.
func (a *Adapter) hunkOpErrorFromGit(op hunkOp, rawErr string) domain.AppError {
	fallback := "git apply failed"
	if op == opDiscard {
		return discardFailedFromGit(rawErr)
	}
	return stageFailedFromGit(rawErr, fallback)
}

// StageHunk stages one hunk (or selected lines) of path from the working tree
// into the index (ADR-0020).
func (a *Adapter) StageHunk(ctx context.Context, repoID domain.RepositoryId, path string, hunkIndex uint32, lineIndices []uint32) error {
	return a.applyHunk(ctx, repoID, path, hunkIndex, lineIndices, opStage)
}

// UnstageHunk removes one hunk (or selected lines) of path from the index
// (ADR-0020).
func (a *Adapter) UnstageHunk(ctx context.Context, repoID domain.RepositoryId, path string, hunkIndex uint32, lineIndices []uint32) error {
	return a.applyHunk(ctx, repoID, path, hunkIndex, lineIndices, opUnstage)
}

// DiscardHunk reverts one hunk (or selected lines) of path in the working tree
// (ADR-0020).
func (a *Adapter) DiscardHunk(ctx context.Context, repoID domain.RepositoryId, path string, hunkIndex uint32, lineIndices []uint32) error {
	return a.applyHunk(ctx, repoID, path, hunkIndex, lineIndices, opDiscard)
}
