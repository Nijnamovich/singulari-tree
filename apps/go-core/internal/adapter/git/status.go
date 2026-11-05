package git

import (
	"context"
	"strings"

	"github.com/SingulariTree/go-core/internal/domain"
)

// Status returns the working-tree status for every changed path in the
// repository, parsed from `git status --porcelain=v2 -z`. It is read-only.
//
// The porcelain v2 format is NUL-separated (so paths with spaces/newlines are
// unambiguous). Header records (`# branch...`) are dropped. A clean or empty
// repository yields an empty (non-nil) slice and a nil error rather than a
// failure. Ignored entries (`!`) are intentionally omitted.
func (a *Adapter) Status(ctx context.Context, repoID domain.RepositoryId) ([]domain.FileStatus, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	out, err := runGit(ctx, fsPath,
		"status", "--porcelain=v2", "-z", "--branch", "--untracked-files=normal")
	if err != nil {
		return nil, err
	}
	return parseStatusPorcelainV2(out), nil
}

// parseStatusPorcelainV2 parses NUL-separated `git status --porcelain=v2 -z`
// output. It is a pure helper (unit-tested directly). Record kinds:
//
//	1 <XY> ... <path>            ordinary (index/worktree) change
//	2 <XY> ... <Xscore> <path>   rename/copy; the original path follows as the
//	                             next NUL-separated field and is consumed
//	u <XY> ... <path>            unmerged/conflicted
//	? <path>                     untracked
//	! <path>                     ignored (skipped)
//
// For records carrying an XY code, X is the index (staged) character and Y the
// worktree (unstaged) character; IsStaged is X != '.'. Untracked files report
// Staged "." and Unstaged "?". Header lines start with "# " and are skipped.
func parseStatusPorcelainV2(out string) []domain.FileStatus {
	fields := strings.Split(out, "\x00")
	statuses := make([]domain.FileStatus, 0)
	for i := 0; i < len(fields); i++ {
		rec := fields[i]
		if rec == "" || strings.HasPrefix(rec, "# ") {
			continue
		}
		switch rec[0] {
		case '1':
			// 1 XY sub mH mI mW hH hI path
			parts := strings.SplitN(rec, " ", 9)
			if len(parts) < 9 {
				continue
			}
			statuses = append(statuses, statusFromXY(parts[1], parts[8]))
		case '2':
			// 2 XY sub mH mI mW hH hI Xscore path  (+ orig path field)
			parts := strings.SplitN(rec, " ", 10)
			if len(parts) < 10 {
				continue
			}
			// The original path is the next NUL-separated field; the new path
			// (parts[9]) is the one reported, so skip the extra field.
			i++
			statuses = append(statuses, statusFromXY(parts[1], parts[9]))
		case 'u':
			// u XY sub m1 m2 m3 mW h1 h2 h3 path
			parts := strings.SplitN(rec, " ", 11)
			if len(parts) < 11 {
				continue
			}
			fs := statusFromXY(parts[1], parts[10])
			fs.IsConflicted = true
			statuses = append(statuses, fs)
		case '?':
			statuses = append(statuses, domain.FileStatus{
				Path:     strings.TrimPrefix(rec, "? "),
				Staged:   ".",
				Unstaged: "?",
			})
		case '!':
			// Ignored entry: not part of the working-tree status.
		}
	}
	return statuses
}

// statusFromXY builds a FileStatus from an XY code and a path. A malformed
// (short) XY yields the path with the fields left at their zero value.
func statusFromXY(xy, path string) domain.FileStatus {
	fs := domain.FileStatus{Path: path}
	if len(xy) < 2 {
		return fs
	}
	fs.Staged = string(xy[0])
	fs.Unstaged = string(xy[1])
	fs.IsStaged = xy[0] != '.'
	return fs
}
