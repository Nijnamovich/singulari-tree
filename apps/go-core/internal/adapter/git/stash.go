package git

import (
	"context"
	"strconv"
	"strings"

	"github.com/SingulariTree/go-core/internal/domain"
)

// stashPrettyFormat mirrors the field order parsed by parseStashList: the
// reflog selector (stash@{N}), the stash commit oid and the reflog subject
// (e.g. "On main: wip" or "WIP on main: <oid> <subject>"). %x1f emits the
// unit separator byte so a subject containing spaces stays a single field.
const stashPrettyFormat = "%gd%x1f%H%x1f%gs"

// StashList lists stash entries via `git stash list`, newest first (index 0).
// Each entry carries its index, oid, message and the branch it was created on
// (empty when created on a detached HEAD). A repository with no stashes yields
// an empty slice and a nil error.
func (a *Adapter) StashList(ctx context.Context, repoID domain.RepositoryId) ([]domain.Stash, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	out, err := runGit(ctx, fsPath, "stash", "list", "--format="+stashPrettyFormat)
	if err != nil {
		return nil, stashFailedFromGit(err.Error())
	}
	return parseStashList(out), nil
}

// parseStashList parses `git stash list --format=stashPrettyFormat` output into
// Stash entries. It is a pure helper (unit-tested directly). Malformed records
// (unparsable selector/oid) are skipped rather than failing the whole listing.
func parseStashList(out string) []domain.Stash {
	lines := strings.Split(out, "\n")
	stashes := make([]domain.Stash, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.SplitN(line, unitSep, 3)
		if len(fields) < 2 {
			continue
		}
		index, ok := parseStashSelector(fields[0])
		if !ok {
			continue
		}
		st := domain.Stash{Index: index}
		if oid, oerr := domain.NewOid(strings.TrimSpace(fields[1])); oerr == nil {
			st.Oid = oid
		}
		subject := ""
		if len(fields) >= 3 {
			subject = fields[2]
		}
		branch, message := parseStashSubject(subject)
		st.Message = message
		if branch != "" {
			b := branch
			st.BranchName = &b
		}
		stashes = append(stashes, st)
	}
	return stashes
}

// parseStashSelector extracts N from a reflog selector such as "stash@{0}".
func parseStashSelector(sel string) (int, bool) {
	open := strings.IndexByte(sel, '{')
	if open < 0 {
		return 0, false
	}
	rest := sel[open+1:]
	close := strings.IndexByte(rest, '}')
	if close < 0 {
		return 0, false
	}
	n, err := strconv.Atoi(rest[:close])
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}

// parseStashSubject splits a stash reflog subject into the branch it was
// created on and its message. It handles both git forms — "On <branch>:
// <message>" (explicit `stash push -m`) and "WIP on <branch>: <oid> <subject>"
// (auto-generated) — and treats "(no branch)" as a detached HEAD (no branch).
func parseStashSubject(subject string) (branch, message string) {
	s := strings.TrimSpace(subject)
	switch {
	case strings.HasPrefix(s, "WIP on "):
		s = strings.TrimPrefix(s, "WIP on ")
	case strings.HasPrefix(s, "On "):
		s = strings.TrimPrefix(s, "On ")
	default:
		return "", s
	}
	if i := strings.Index(s, ": "); i >= 0 {
		branch, message = s[:i], strings.TrimSpace(s[i+2:])
	} else {
		branch = strings.TrimSuffix(s, ":")
	}
	if branch == "(no branch)" {
		branch = ""
	}
	return branch, message
}

// StashApply applies stash entry index via `git stash apply [--index]
// stash@{N}`. The stash is retained (unlike Pop). restoreIndex maps to
// --index (reapply the staged state too).
func (a *Adapter) StashApply(ctx context.Context, repoID domain.RepositoryId, index int, restoreIndex bool) error {
	return a.stashCommand(ctx, repoID, "apply", index, restoreIndex)
}

// StashPop applies and drops stash entry index via `git stash pop stash@{N}`.
func (a *Adapter) StashPop(ctx context.Context, repoID domain.RepositoryId, index int) error {
	return a.stashCommand(ctx, repoID, "pop", index, false)
}

// StashDrop removes stash entry index via `git stash drop stash@{N}`.
func (a *Adapter) StashDrop(ctx context.Context, repoID domain.RepositoryId, index int) error {
	return a.stashCommand(ctx, repoID, "drop", index, false)
}

// stashCommand runs `git stash <verb> [--index] stash@{N}`. A negative index is
// rejected up front; an absent/out-of-range entry surfaces git's failure as a
// typed STASH_FAILED.
func (a *Adapter) stashCommand(ctx context.Context, repoID domain.RepositoryId, verb string, index int, restoreIndex bool) error {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return err
	}
	if index < 0 {
		return stashFailed("invalid stash index")
	}
	args := []string{"stash", verb}
	if verb == "apply" && restoreIndex {
		args = append(args, "--index")
	}
	args = append(args, "stash@{"+strconv.Itoa(index)+"}")
	if _, err := runGit(ctx, fsPath, args...); err != nil {
		return stashFailedFromGit(err.Error())
	}
	return nil
}
