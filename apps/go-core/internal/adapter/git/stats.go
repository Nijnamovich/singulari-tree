package git

import (
	"context"
	"strconv"
	"strings"

	"github.com/SingulariTree/go-core/internal/domain"
)

// CommitStats computes the change-size counts for each requested oid (ADR-0023):
// `git diff --numstat <oid>^ <oid>` against the first parent, or against the
// empty tree for a root commit. Merge commits diff against the first parent by
// policy. Only counts are returned — never Git objects/blobs.
func (a *Adapter) CommitStats(ctx context.Context, repoID domain.RepositoryId, oids []string) ([]domain.CommitStats, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	out := make([]domain.CommitStats, 0, len(oids))
	for _, hex := range oids {
		hex = strings.TrimSpace(hex)
		if hex == "" {
			continue
		}
		if _, err := domain.NewOid(hex); err != nil {
			return nil, domain.ErrCommitNotFound.WithDetail("oid", hex)
		}
		st, err := a.commitStatsOne(ctx, fsPath, hex)
		if err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, nil
}

// commitStatsOne measures one commit against its first parent (or the empty
// tree when it has none).
func (a *Adapter) commitStatsOne(ctx context.Context, fsPath, oidHex string) (domain.CommitStats, error) {
	if _, err := runGit(ctx, fsPath, "cat-file", "-e", oidHex+"^{commit}"); err != nil {
		return domain.CommitStats{}, domain.ErrCommitNotFound.WithDetail("oid", oidHex)
	}
	left := oidHex + "^"
	if _, err := runGit(ctx, fsPath, "rev-parse", "--verify", "--quiet", left); err != nil {
		empty, eerr := emptyTreeOid(ctx, fsPath)
		if eerr != nil {
			return domain.CommitStats{}, diffFailedFromGit(eerr.Error())
		}
		left = empty.Hex
	}
	out, err := runGit(ctx, fsPath, "diff", "--numstat", left, oidHex)
	if err != nil {
		return domain.CommitStats{}, diffFailedFromGit(err.Error())
	}
	return parseNumstat(oidHex, out), nil
}

// parseNumstat sums a `git diff --numstat` listing into CommitStats. Each line
// is `<added>\t<deleted>\t<path>`; a binary file reports `-` for both counts,
// which contributes a files-changed entry with zero additions/deletions.
func parseNumstat(oidHex, out string) domain.CommitStats {
	st := domain.CommitStats{Oid: oidHex}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		fields := strings.SplitN(line, "\t", 3)
		if len(fields) < 3 {
			continue
		}
		st.FilesChanged++
		if n, err := strconv.Atoi(fields[0]); err == nil {
			st.Additions += n
		}
		if n, err := strconv.Atoi(fields[1]); err == nil {
			st.Deletions += n
		}
	}
	return st
}
