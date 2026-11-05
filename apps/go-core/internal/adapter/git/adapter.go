// Package git implements the read side of domain.GitPort by shelling out to the
// system `git` binary (ADR-007/R7: exec git, not go-git). All invocations pass
// the repository path via `-C` and never build a shell string, so paths are not
// subject to shell interpolation.
//
// Phase 0 implemented the read path (Resolve / List / Get). M1 adds the
// working-tree operations Status / Stage / Unstage / Commit / Diff. M3 (ADR-028)
// adds branch CRUD, merge, tag CRUD and stash list/apply/pop/drop. The
// remaining auxiliary operations (WorktreeList) return
// domain.ErrCodeNotImplemented explicitly rather than faking success.
package git

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/SingulariTree/go-core/internal/domain"
)

const (
	// recordSep (0x1e) terminates each commit record; unitSep (0x1f) separates
	// fields. The message (%B) is the last field and may contain newlines.
	recordSep = "\x1e"
	unitSep   = "\x1f"

	// logPrettyFormat mirrors the field order parsed by parseCommits:
	// H,P,an,ae,aI,cn,ce,cI,T,B.
	logPrettyFormat = "%H" + unitSep + "%P" + unitSep + "%an" + unitSep + "%ae" + unitSep +
		"%aI" + unitSep + "%cn" + unitSep + "%ce" + unitSep + "%cI" + unitSep +
		"%T" + unitSep + "%B" + recordSep

	// refPrettyFormat mirrors the field order parsed by parseRefs:
	// objectname, refname, *objectname (dereferenced annotated-tag target).
	// For a lightweight tag the third field is empty; for an annotated tag it
	// holds the tagged commit so the decoration lands on the commit, not on the
	// tag object.
	refPrettyFormat = "%(objectname)" + unitSep + "%(refname)" + unitSep + "%(*objectname)"

	// branchPrettyFormat mirrors the field order parsed by parseBranches:
	// refname, objectname (tip), upstream:short, upstream (full refname),
	// symref (target refname for a symbolic ref such as refs/remotes/origin/HEAD,
	// empty for ordinary refs), and upstream:track (git's ahead/behind/gone
	// summary, e.g. "[behind 2]", "[ahead 1, behind 2]", "[gone]" or empty for
	// refs without an upstream). Symrefs are skipped: only real branches are
	// listed. Ref names cannot contain control characters, so unitSep/recordSep
	// are unambiguous field/record separators.
	branchPrettyFormat = "%(refname)" + unitSep + "%(objectname)" + unitSep +
		"%(upstream:short)" + unitSep + "%(upstream)" + unitSep + "%(symref)" +
		unitSep + "%(upstream:track)" + recordSep

	// tagPrettyFormat mirrors the field order parsed by parseTags: refname,
	// objectname, objecttype, dereferenced objectname (*objectname, empty for
	// lightweight tags), tagger name, tagger email, tagger date (ISO strict)
	// and the message subject. The subject is the last field so it may contain
	// any separator that somehow slips into the tag message.
	tagPrettyFormat = "%(refname)" + unitSep + "%(objectname)" + unitSep +
		"%(objecttype)" + unitSep + "%(*objectname)" + unitSep +
		"%(taggername)" + unitSep + "%(taggeremail)" + unitSep +
		"%(taggerdate:iso-strict)" + unitSep + "%(contents:subject)" + recordSep

	// defaultListLimit guards against unbounded reads when the caller omits a
	// limit (the read path must always be paginated).
	defaultListLimit = 200

	// gitOptionalLocksEnv disables git's optional index lock for every command
	// the adapter runs. Read-only commands (status, diff, log, …) would
	// otherwise take the optional lock and rewrite .git/index during
	// inspection; the fsnotify watcher reports that write as a change, the
	// renderer reloads status/diff, and the core re-runs the read-only command,
	// producing a self-sustaining reload storm. The variable is advisory: it
	// only suppresses the optional lock, so mutating commands (add, commit,
	// branch, checkout, merge, reset, stash, …) still take the mandatory lock
	// and behave identically.
	gitOptionalLocksEnv = "GIT_OPTIONAL_LOCKS=0"
)

// behindTrackRe extracts N from git's `%(upstream:track)` summary (e.g.
// "[behind 2]" or "[ahead 1, behind 2]"). "gone" and empty track produce no
// match, leaving Behind at 0.
var behindTrackRe = regexp.MustCompile(`behind (\d+)`)

// Adapter implements domain.GitPort over the system git executable.
type Adapter struct {
	repoPort domain.RepoPort
}

// NewAdapter creates a git adapter that resolves repository IDs to filesystem
// paths through the given RepoPort.
func NewAdapter(repoPort domain.RepoPort) *Adapter {
	return &Adapter{repoPort: repoPort}
}

var _ domain.GitPort = (*Adapter)(nil)

// Resolve returns the repository top-level directory and its git common dir for
// the given filesystem path. Returns domain.ErrNotAGitRepo when the path is not
// a git repository.
func (a *Adapter) Resolve(ctx context.Context, fsPath string) (topLevel, commonDir string, err error) {
	topLevel, err = runGit(ctx, fsPath, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", "", domain.ErrNotAGitRepo.WithDetail("fs_path", fsPath)
	}
	commonDir, err = runGit(ctx, fsPath, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return "", "", domain.ErrNotAGitRepo.WithDetail("fs_path", fsPath)
	}
	return strings.TrimSpace(topLevel), strings.TrimSpace(commonDir), nil
}

// validateLensRefs trims and validates caller-supplied lens refs before they
// reach git. Refs are appended to the argument list as revisions (after the
// flags, never after `--`), so each one must be a safe bare argument: non-empty,
// without a leading '-' (which git would parse as an option) and without
// whitespace or control characters. Blank entries are dropped. An unsafe ref is
// a typed INVALID_OID error carrying the offending value, mirroring how the read
// path rejects malformed oids.
func validateLensRefs(refs []string) ([]string, error) {
	valid := make([]string, 0, len(refs))
	for _, raw := range refs {
		ref := strings.TrimSpace(raw)
		if ref == "" {
			continue
		}
		if !checkSafeArg(ref) {
			return nil, domain.AppError{
				Code:    domain.ErrCodeInvalidOid,
				Message: "invalid ref",
				Details: map[string]string{"ref": ref},
			}
		}
		valid = append(valid, ref)
	}
	return valid, nil
}

// List returns a window of commits (topological order, newest first) plus the
// total number of reachable commits. offset/limit are applied via
// --skip/--max-count so the full history is never loaded.
//
// With empty refs the walk starts at HEAD, exactly as the graph has always read
// it. With non-empty refs it is a branch lens: the walk is the union HEAD ∪ refs
// and the total is that union's reachable count, so a branch's history can be
// inspected without checking it out. `git log` only defaults to HEAD while no
// revision is named, so a lensed walk names HEAD explicitly before appending the
// refs; without that the HEAD-only commits would drop out of the window and
// in_refs would have nothing to report as outside the lens. The refs are
// revisions and therefore go after the flags, never after `--` (which would
// turn them into path filters). With no refs nothing is appended, so the
// argument list is byte-identical to the un-lensed historical invocation.
func (a *Adapter) List(ctx context.Context, repoID domain.RepositoryId, refs []string, offset, limit int) ([]domain.Commit, int, error) {
	validRefs, err := validateLensRefs(refs)
	if err != nil {
		return nil, 0, err
	}
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, 0, err
	}
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 {
		limit = defaultListLimit
	}

	args := []string{"-c", "log.showSignature=false", "log",
		"--pretty=format:" + logPrettyFormat,
		"--topo-order",
		"--skip=" + strconv.Itoa(offset),
		"--max-count=" + strconv.Itoa(limit),
	}
	if len(validRefs) > 0 {
		args = append(args, "HEAD")
		args = append(args, validRefs...)
	}
	out, err := runGit(ctx, fsPath, args...)
	if err != nil {
		// An empty repository has no HEAD; report an empty window, not an error.
		// That fallback is only valid for the un-lensed walk: a lensed walk
		// that failed (e.g. its ref was deleted after validation) is a real
		// failure, and an empty window would mask it.
		if len(validRefs) > 0 {
			return nil, 0, err
		}
		total, countErr := a.countCommits(ctx, fsPath, validRefs)
		if countErr != nil || total == 0 {
			return []domain.Commit{}, 0, nil
		}
		return nil, 0, err
	}

	commits, err := parseCommits(out)
	if err != nil {
		return nil, 0, err
	}
	// Ref decorations are attached after parsing; the `git log` pretty format
	// stays 10 fields so parseCommits/buildCommit are unaffected. A failure to
	// enumerate refs (empty/unborn repo) degrades to no decorations rather than
	// failing the read path.
	a.attachRefs(ctx, fsPath, commits)

	// (items, total) must describe ONE snapshot. A walk that returned fewer
	// commits than the effective limit reached the end of history, so that walk
	// IS its own count: total = offset + len(commits). Deriving it here instead
	// of from a separate countCommits read closes the TOCTOU window in which a
	// commit landing between the walk and the count produced a stale window
	// paired with a fresh total (e.g. {[second, initial], total: 3}). Only a
	// window that came back full needs the separate count, where it is a pure
	// paging hint (hasMore = len < total).
	if len(commits) < limit {
		return commits, offset + len(commits), nil
	}

	total, err := a.countCommits(ctx, fsPath, validRefs)
	if err != nil {
		return nil, 0, err
	}
	return commits, total, nil
}

// LensOids returns the oids reachable from refs (the branch-lens membership
// set) as `git rev-list <refs...>`. It reads reachability only and never checks
// a ref out. Validation matches the lensed walk, so an unsafe ref is rejected
// with the same typed error. Empty refs mean "no lens", which has no reachable
// oids, so no git process is spawned. A walk that fails (e.g. a ref deleted
// after validation) is a typed COMMIT_NOT_FOUND carrying the validated refs, so
// the transport maps it to a not-found status instead of a raw Internal. The
// output is used solely for membership tests: lines are split, trimmed and
// blank lines skipped without further parsing (a `rev-list` oid is opaque to
// the service).
func (a *Adapter) LensOids(ctx context.Context, repoID domain.RepositoryId, refs []string) ([]string, error) {
	validRefs, err := validateLensRefs(refs)
	if err != nil {
		return nil, err
	}
	if len(validRefs) == 0 {
		return []string{}, nil
	}
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	out, err := runGit(ctx, fsPath, append([]string{"rev-list"}, validRefs...)...)
	if err != nil {
		// A raw git error would reach the wire as an untranslated Internal
		// status. A lens ref that no longer resolves is a not-found condition,
		// so report it as a typed COMMIT_NOT_FOUND carrying the validated refs.
		return nil, domain.AppError{
			Code:    domain.ErrCodeCommitNotFound,
			Message: "cannot resolve the lens ref",
			Details: map[string]string{"refs": strings.Join(validRefs, " ")},
		}
	}
	oids := make([]string, 0, strings.Count(out, "\n")+1)
	for _, line := range strings.Split(out, "\n") {
		if oid := strings.TrimSpace(line); oid != "" {
			oids = append(oids, oid)
		}
	}
	return oids, nil
}

// attachRefs populates Commit.Refs in place for the listed commits: branch,
// remote and tag decorations from a single for-each-ref call, plus a synthetic
// {Name:"HEAD", Kind:"head"} on the commit HEAD currently points at. Any error
// degrades to leaving refs unset (the read path never fails on decorations).
func (a *Adapter) attachRefs(ctx context.Context, fsPath string, commits []domain.Commit) {
	if len(commits) == 0 {
		return
	}
	byOid := map[string][]domain.RefLabel{}
	if out, err := runGit(ctx, fsPath, "for-each-ref", "--format="+refPrettyFormat); err == nil {
		byOid = parseRefs(out)
	}
	head := a.headOid(ctx, fsPath)

	for i := range commits {
		oid := commits[i].Oid.Hex
		var refs []domain.RefLabel
		if head != "" && oid == head {
			refs = append(refs, domain.RefLabel{Name: "HEAD", Kind: domain.RefKindHead})
		}
		refs = append(refs, byOid[oid]...)
		commits[i].Refs = refs
	}
}

// headOid returns the oid HEAD resolves to, or "" when HEAD is unborn/absent.
func (a *Adapter) headOid(ctx context.Context, fsPath string) string {
	out, err := runGit(ctx, fsPath, "rev-parse", "--verify", "--quiet", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// parseRefs parses `git for-each-ref --format=refPrettyFormat` output into a
// map from commit oid hex to its decorations. It is a pure helper (unit-tested
// directly). Lines that do not classify as head/branch/remote/tag are ignored.
func parseRefs(out string) map[string][]domain.RefLabel {
	byOid := map[string][]domain.RefLabel{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		fields := strings.Split(line, unitSep)
		if len(fields) < 2 {
			continue
		}
		objectOid := strings.TrimSpace(fields[0])
		ref := strings.TrimSpace(fields[1])
		derefOid := ""
		if len(fields) >= 3 {
			derefOid = strings.TrimSpace(fields[2])
		}
		name, kind, ok := classifyRef(ref)
		if !ok {
			continue
		}
		target := objectOid
		// Annotated tags point at a tag object; decorate the tagged commit.
		if kind == domain.RefKindTag && derefOid != "" {
			target = derefOid
		}
		if target == "" {
			continue
		}
		byOid[target] = append(byOid[target], domain.RefLabel{Name: name, Kind: kind})
	}
	return byOid
}

// classifyRef maps a full refname to its short label and unambiguous kind.
func classifyRef(ref string) (name, kind string, ok bool) {
	switch {
	case strings.HasPrefix(ref, "refs/heads/"):
		return strings.TrimPrefix(ref, "refs/heads/"), domain.RefKindBranch, true
	case strings.HasPrefix(ref, "refs/remotes/"):
		return strings.TrimPrefix(ref, "refs/remotes/"), domain.RefKindRemote, true
	case strings.HasPrefix(ref, "refs/tags/"):
		return strings.TrimPrefix(ref, "refs/tags/"), domain.RefKindTag, true
	default:
		return "", "", false
	}
}

// Get returns a single commit by oid.
func (a *Adapter) Get(ctx context.Context, repoID domain.RepositoryId, oid domain.Oid) (*domain.Commit, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	out, err := runGit(ctx, fsPath, "-c", "log.showSignature=false", "log",
		"-1", "--pretty=format:"+logPrettyFormat, oid.Hex)
	if err != nil {
		return nil, domain.ErrCommitNotFound.WithDetail("oid", oid.Hex)
	}
	commits, err := parseCommits(out)
	if err != nil {
		return nil, err
	}
	if len(commits) == 0 {
		return nil, domain.ErrCommitNotFound.WithDetail("oid", oid.Hex)
	}
	return &commits[0], nil
}

// countCommits returns the number of commits reachable from HEAD or, when refs
// is non-empty, from the lensed union HEAD ∪ refs. With no refs the invocation
// is exactly `git rev-list --count HEAD`; with refs HEAD is named again so the
// count covers the same union the window walk covers.
func (a *Adapter) countCommits(ctx context.Context, fsPath string, refs []string) (int, error) {
	args := []string{"rev-list", "--count", "HEAD"}
	if len(refs) > 0 {
		args = append(args, refs...)
	}
	out, err := runGit(ctx, fsPath, args...)
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		return 0, fmt.Errorf("parse rev-list count %q: %w", out, err)
	}
	return n, nil
}

func (a *Adapter) resolvePath(ctx context.Context, repoID domain.RepositoryId) (string, error) {
	if a.repoPort == nil {
		return "", domain.ErrRepoNotFound
	}
	repo, err := a.repoPort.Get(ctx, repoID)
	if err != nil {
		return "", err
	}
	if repo == nil || repo.FsPath == "" {
		return "", domain.ErrRepoNotFound.WithDetail("repo_id", string(repoID))
	}
	return repo.FsPath, nil
}

// gitCommandEnv returns the environment for an adapter git invocation: the
// process environment plus GIT_OPTIONAL_LOCKS=0. Setting it here (rather than
// on a single command) keeps every invocation through this adapter from taking
// git's optional index lock and rewriting .git/index during read-only
// inspection. See gitOptionalLocksEnv.
func gitCommandEnv() []string {
	return append(os.Environ(), gitOptionalLocksEnv)
}

// runGit executes `git -C <dir> <args...>` and returns trimmed stdout.
func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	full := append([]string{"-C", dir}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Env = gitCommandEnv()
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// runGitStdin executes `git -C <dir> <args...>` with stdin fed from the given
// bytes and returns trimmed stdout. It mirrors runGit's error envelope
// (`git <args>: <err>: <stderr>`) so callers get identical diagnostics whether
// or not a git command needs stdin. Like runGit it never builds a shell string.
func runGitStdin(ctx context.Context, dir string, stdin []byte, args ...string) (string, error) {
	full := append([]string{"-C", dir}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Env = gitCommandEnv()
	cmd.Stdin = bytes.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// runGitAllowExit is like runGit but also reports the process exit code so
// callers can treat specific non-zero exits (e.g. `git config --get-regexp` with
// no matches, exit 1) as an empty result rather than an error. stdout is
// returned even on failure; code is -1 when the failure was not an exit status.
func runGitAllowExit(ctx context.Context, dir string, args ...string) (stdout string, code int, err error) {
	full := append([]string{"-C", dir}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Env = gitCommandEnv()
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	err = cmd.Run()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return out.String(), exitErr.ExitCode(), fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
		}
		return out.String(), -1, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return out.String(), 0, nil
}

func parseCommits(out string) ([]domain.Commit, error) {
	parts := strings.Split(out, recordSep)
	commits := make([]domain.Commit, 0, len(parts))
	for _, part := range parts {
		part = strings.Trim(part, "\n\r")
		if part == "" {
			continue
		}
		fields := strings.SplitN(part, unitSep, 10)
		if len(fields) != 10 {
			return nil, fmt.Errorf("git log: expected 10 fields, got %d", len(fields))
		}
		c, err := buildCommit(fields)
		if err != nil {
			return nil, err
		}
		commits = append(commits, c)
	}
	return commits, nil
}

func buildCommit(f []string) (domain.Commit, error) {
	oid, err := domain.NewOid(f[0])
	if err != nil {
		return domain.Commit{}, err
	}
	tree, err := domain.NewOid(f[8])
	if err != nil {
		return domain.Commit{}, err
	}

	parents := make([]domain.Oid, 0)
	for _, raw := range strings.Fields(f[1]) {
		p, err := domain.NewOid(raw)
		if err != nil {
			return domain.Commit{}, err
		}
		parents = append(parents, p)
	}

	authorWhen, err := time.Parse(time.RFC3339, strings.TrimSpace(f[4]))
	if err != nil {
		return domain.Commit{}, fmt.Errorf("parse author date %q: %w", f[4], err)
	}
	committerWhen, err := time.Parse(time.RFC3339, strings.TrimSpace(f[7]))
	if err != nil {
		return domain.Commit{}, fmt.Errorf("parse committer date %q: %w", f[7], err)
	}

	return domain.Commit{
		Oid:     oid,
		Parents: parents,
		Author:  domain.Signature{Name: f[2], Email: f[3], When: authorWhen},
		Committer: domain.Signature{
			Name:  f[5],
			Email: f[6],
			When:  committerWhen,
		},
		Message:     f[9],
		TreeOid:     tree,
		CommittedAt: committerWhen,
	}, nil
}

func notImplemented(op string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeNotImplemented,
		Message: op + " is not implemented in Phase 0 (read path only)",
	}
}

// BranchList lists local branches (refs/heads) and remote-tracking branches
// (refs/remotes) in a repository. It is read-only: the current branch is
// detected through `git symbolic-ref`, which reports an empty name on a
// detached HEAD (no branch is marked IsCurrent). Remote-tracking branches are
// always IsRemote:true and never IsCurrent. Symbolic refs such as
// refs/remotes/origin/HEAD are filtered out by parseBranches. An empty/unborn
// repository yields an empty slice and a nil error.
func (a *Adapter) BranchList(ctx context.Context, repoID domain.RepositoryId) ([]domain.Branch, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	current := currentBranch(ctx, fsPath)
	// A single call enumerates both namespaces; a pattern that matches nothing
	// (e.g. no refs/remotes in a fresh repo) contributes no records and is not
	// an error, so local-branch behavior is unchanged.
	out, err := runGit(ctx, fsPath, "for-each-ref", "--format="+branchPrettyFormat, "refs/heads", "refs/remotes")
	if err != nil {
		return nil, err
	}
	return parseBranches(out, current), nil
}

// currentBranch returns the short name of the branch HEAD points at, or "" when
// HEAD is detached or unborn (symbolic-ref exits non-zero).
func currentBranch(ctx context.Context, fsPath string) string {
	out, err := runGit(ctx, fsPath, "symbolic-ref", "--short", "-q", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// parseBranches parses `git for-each-ref --format=branchPrettyFormat` output.
// It is a pure helper (unit-tested directly). Malformed records (e.g. an
// unparsable oid) are skipped rather than failing the whole listing. Remote-ness
// is derived from the ref prefix: refs/remotes/* are remote-tracking branches
// (IsRemote:true, never current, no upstream); refs/heads/* are local branches.
// The skip applies to any symbolic ref (non-empty symref), including both the
// symbolic refs/remotes/origin/HEAD and a local refs/heads symbolic ref; they
// are not real branches and are excluded. Ordinary refs have an empty symref.
// The optional track field (index 5) yields Behind: the pull-pending count is
// decimal-extracted from git's "[behind N]"/"[ahead M, behind N]" summary, and
// only set for local branches with a configured upstream. Legacy 5-field
// records (and "[gone]"/empty track) parse with Behind == 0.
func parseBranches(out, current string) []domain.Branch {
	records := strings.Split(out, recordSep)
	branches := make([]domain.Branch, 0, len(records))
	for _, rec := range records {
		rec = strings.Trim(rec, "\n\r")
		if rec == "" {
			continue
		}
		fields := strings.Split(rec, unitSep)
		if len(fields) < 4 {
			continue
		}
		ref := strings.TrimSpace(fields[0])
		oidHex := strings.TrimSpace(fields[1])
		upstreamShort := strings.TrimSpace(fields[2])
		upstreamFull := strings.TrimSpace(fields[3])
		symref := ""
		if len(fields) >= 5 {
			symref = strings.TrimSpace(fields[4])
		}
		track := ""
		if len(fields) >= 6 {
			track = strings.TrimSpace(fields[5])
		}
		if symref != "" {
			// Symbolic ref (e.g. refs/remotes/origin/HEAD): not a branch.
			continue
		}

		oid, err := domain.NewOid(oidHex)
		if err != nil {
			continue
		}
		isRemote := strings.HasPrefix(ref, "refs/remotes/")
		b := domain.Branch{
			Name:      domain.RefName{Raw: ref}.Short(),
			RefName:   domain.RefName{Raw: ref},
			Tip:       oid,
			IsCurrent: !isRemote && current != "" && ref == "refs/heads/"+current,
			IsRemote:  isRemote,
		}
		// Remote-tracking refs have no configured upstream; for-each-ref already
		// reports an empty upstream for them, so only local branches can set it.
		if !isRemote {
			upstreamRaw := upstreamFull
			if upstreamRaw == "" {
				upstreamRaw = upstreamShort
			}
			if upstreamRaw != "" {
				up := domain.RefName{Raw: upstreamRaw}
				b.Upstream = &up
				// Behind is only meaningful with a configured upstream; git
				// emits the count in the track field natively (no extra calls).
				// Absent/malformed track (5-field records) leaves Behind at 0.
				if m := behindTrackRe.FindStringSubmatch(track); m != nil {
					if n, perr := strconv.Atoi(m[1]); perr == nil && n > 0 {
						b.Behind = int32(n)
					}
				}
			}
		}
		branches = append(branches, b)
	}
	return branches
}

// maxCheckoutErrLen bounds the short CHECKOUT_FAILED message (validation
// errors and one-line git summaries) so a noisy git stderr cannot bloat the
// wire response. Path lists are never carried here, so this cap can never cut
// a user-facing path; complete paths travel in Details.
const maxCheckoutErrLen = 512

// maxCheckoutRawLen bounds the raw git stderr retained for diagnostics only.
// It is deliberately generous and applied on a line boundary so a conflicting
// path is never cut mid-way.
const maxCheckoutRawLen = 4096

// maxCheckoutPaths bounds how many conflicting paths are listed in Details.
// It sits far above realistic dirty-tree sizes; when exceeded, the list ends
// with a single "… and N more" line rather than being truncated mid-path.
const maxCheckoutPaths = 500

// maxCheckoutPathsBytes bounds the total joined size of the path list carried
// in Details["paths"]. The gRPC x-app-error-details trailer is an HTTP/2 header
// and therefore size-limited, so a very large (yet count-bounded) list could be
// silently dropped. The cap is applied on a path boundary; when hit, a single
// "… and N more" line replaces the omitted paths, which are counted in full.
const maxCheckoutPathsBytes = 8192

// dirtyCheckoutMarker is the git stderr fragment emitted when checkout refuses
// because uncommitted local changes would be overwritten. The conflicting paths
// follow on tab-indented lines. It also matches the untracked-files refusal.
const dirtyCheckoutMarker = "would be overwritten by checkout"

// untrackedCheckoutMarker is the shared fragment of git's untracked-files
// refusal. It distinguishes that refusal from the tracked-dirty one, which
// shares dirtyCheckoutMarker. Git emits the plural form ("untracked working
// tree files would be overwritten by checkout") and, in some versions, the
// singular ("Untracked working tree file 'x' would be overwritten by
// checkout."), so match this lowercase fragment against rawErr lowercased.
const untrackedCheckoutMarker = "untracked working tree file"

// truncateValidUTF8 returns s unchanged when it fits within limit bytes;
// otherwise it cuts at the largest rune boundary not exceeding limit. proto3
// string fields must be valid UTF-8, so a mid-rune cut would make proto.Marshal
// fail and lose the typed CHECKOUT_FAILED code.
func truncateValidUTF8(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && !utf8.ValidString(s[:cut]) {
		cut--
	}
	return s[:cut]
}

// checkoutFailed builds a typed CHECKOUT_FAILED error with a trimmed, bounded
// message. It is used for validation errors and other short, path-free
// summaries.
func checkoutFailed(message string) domain.AppError {
	msg := truncateValidUTF8(strings.TrimSpace(message), maxCheckoutErrLen)
	return domain.AppError{Code: domain.ErrCodeCheckoutFailed, Message: msg}
}

// boundCheckoutRaw bounds the raw git stderr kept for diagnostics. It trims the
// string, then cuts at the last line boundary within maxCheckoutRawLen (rune
// safe) and marks the cut explicitly, so a path is never split across the
// truncation.
func boundCheckoutRaw(raw string) string {
	raw = strings.TrimSpace(raw)
	if len(raw) <= maxCheckoutRawLen {
		return raw
	}
	head := truncateValidUTF8(raw, maxCheckoutRawLen)
	if i := strings.LastIndexByte(head, '\n'); i >= 0 {
		head = head[:i]
	}
	return head + "\n… (truncated)"
}

// boundCheckoutPaths bounds the conflicting-path list carried in
// Details["paths"]. It applies both the count cap (maxCheckoutPaths) and the
// joined-size cap (maxCheckoutPathsBytes): paths are accumulated while the
// running total, including the joining newline, stays within the byte budget,
// so no individual path is ever cut mid-way. When at least one path is omitted
// a single "… and N more" sentinel line is appended, where N counts every
// omitted path (both byte- and count-capped). The sentinel itself is kept
// inside the byte budget by dropping trailing paths if necessary, so the fully
// joined value never exceeds maxCheckoutPathsBytes. It is a pure helper,
// unit-tested without a git setup.
func boundCheckoutPaths(paths []string) []string {
	if len(paths) == 0 {
		return paths
	}
	included := len(paths)
	if included > maxCheckoutPaths {
		included = maxCheckoutPaths
	}
	bounded := make([]string, 0, included)
	total := 0 // sum of len(path)+1 per entry, i.e. joined length + 1
	for _, p := range paths[:included] {
		// The +1 accounts for the newline that joins adjacent entries.
		if total+len(p)+1 > maxCheckoutPathsBytes {
			break
		}
		bounded = append(bounded, p)
		total += len(p) + 1
	}
	remaining := len(paths) - len(bounded)
	if remaining == 0 {
		return bounded
	}
	// Reserve room for the sentinel: drop trailing paths until the joined value
	// (sentinel included) fits the byte budget. Each drop folds into remaining,
	// so the sentinel count stays accurate.
	for len(bounded) > 0 {
		if total+len(fmt.Sprintf("… and %d more", remaining)) <= maxCheckoutPathsBytes {
			break
		}
		last := bounded[len(bounded)-1]
		bounded = bounded[:len(bounded)-1]
		total -= len(last) + 1
		remaining++
	}
	return append(bounded, fmt.Sprintf("… and %d more", remaining))
}

// parseDirtyCheckoutPaths extracts the conflicting paths from git's refusal
// stderr. It locates the line containing dirtyCheckoutMarker and then consumes
// the following tab-indented lines (one path each) until a line no longer
// starts with a tab. Paths are preserved verbatim apart from the leading tab
// and are returned in the order git emitted them.
func parseDirtyCheckoutPaths(raw string) []string {
	lines := strings.Split(raw, "\n")
	start := -1
	for i, line := range lines {
		if strings.Contains(line, dirtyCheckoutMarker) {
			start = i + 1
			break
		}
	}
	if start < 0 {
		return nil
	}
	var paths []string
	for _, line := range lines[start:] {
		if !strings.HasPrefix(line, "\t") {
			break
		}
		paths = append(paths, strings.TrimPrefix(line, "\t"))
	}
	return paths
}

// shortGitSummary distills the first recognizable git error/fatal line from the
// runGit envelope (`git <args>: exit status N: <stderr>`) into a short,
// meaningful message. It never returns the raw envelope.
func shortGitSummary(raw string) string {
	return shortGitSummaryWithFallback(raw, "git checkout failed")
}

// shortGitSummaryWithFallback is shortGitSummary with a caller-supplied fallback
// used when no `error:`/`fatal:` line is present.
func shortGitSummaryWithFallback(raw, fallback string) string {
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		for _, marker := range []string{"error:", "fatal:"} {
			if i := strings.Index(line, marker); i >= 0 {
				return truncateValidUTF8(line[i:], maxCheckoutErrLen)
			}
		}
	}
	return fallback
}

// checkoutFailedFromGit builds the CHECKOUT_FAILED error for the final
// `git checkout` failure. When git refused because local changes (tracked) or
// untracked files would be overwritten, the friendly headline sits in Message
// and the complete, untruncated path list travels in Details; the raw stderr is
// retained there for diagnostics only. The `reason` detail distinguishes
// tracked-dirty ("dirty_working_tree") from untracked ("untracked_working_tree")
// so the renderer can offer the matching confirmation. Other failures keep a
// short summary plus the bounded raw text.
func checkoutFailedFromGit(rawErr string) domain.AppError {
	raw := boundCheckoutRaw(rawErr)
	paths := parseDirtyCheckoutPaths(rawErr)
	if len(paths) > 0 {
		bounded := boundCheckoutPaths(paths)
		reason := "dirty_working_tree"
		message := "Cannot switch branch: local changes would be overwritten by checkout. Commit or stash them first."
		if strings.Contains(strings.ToLower(rawErr), untrackedCheckoutMarker) {
			reason = "untracked_working_tree"
			message = "Cannot switch branch: untracked working tree files would be overwritten by checkout. Remove or discard them first."
		}
		return domain.AppError{
			Code:    domain.ErrCodeCheckoutFailed,
			Message: message,
			Details: map[string]string{
				"reason": reason,
				"paths":  strings.Join(bounded, "\n"),
				"raw":    raw,
			},
		}
	}
	return domain.AppError{
		Code:    domain.ErrCodeCheckoutFailed,
		Message: shortGitSummary(rawErr),
		Details: map[string]string{
			"reason": "git_error",
			"raw":    raw,
		},
	}
}

// stashFailed builds a typed STASH_FAILED error with a trimmed, bounded message.
func stashFailed(message string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeStashFailed,
		Message: truncateValidUTF8(strings.TrimSpace(message), maxCheckoutErrLen),
	}
}

// stashFailedFromGit builds the STASH_FAILED error for a failed
// `git stash push` or oid resolution: a short summary plus the bounded raw text.
func stashFailedFromGit(rawErr string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeStashFailed,
		Message: shortGitSummaryWithFallback(rawErr, "git stash failed"),
		Details: map[string]string{
			"raw": boundCheckoutRaw(rawErr),
		},
	}
}

// Checkout switches the working tree to ref (DWIM). The renderer sends the
// clicked ref as-is and the core resolves it:
//
//   - refs/heads/<b>                 -> git checkout <b>
//   - refs/remotes/<remote>/<branch> -> git checkout <branch> when a local
//     counterpart exists, else git checkout -b <branch> --track
//     <remote>/<branch>
//   - tags / other refs / OIDs       -> git checkout <ref> (detached OK)
//
// force maps to `git checkout -f` (discard tracked working-tree modifications);
// discardUntracked additionally runs `git clean -fd` first (discard untracked
// files and directories) and implies force.
//
// Short inputs are canonicalized first via `git rev-parse --symbolic-full-name`
// so e.g. `origin/foo` and `foo` resolve to their full refnames; inputs that
// produce no symbolic name fall back to the raw value so OIDs and rev
// expressions keep working. Ref-derived tokens that start with '-' or contain
// control/whitespace characters are rejected to prevent option injection.
func (a *Adapter) Checkout(ctx context.Context, repoID domain.RepositoryId, ref domain.RefName, force, discardUntracked bool) error {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return err
	}
	raw := strings.TrimSpace(ref.Raw)
	if raw == "" {
		return checkoutFailed("empty ref")
	}
	// Guard before rev-parse: a leading '-' would be parsed as an option.
	if !checkSafeArg(raw) {
		return checkoutFailed("invalid ref")
	}

	// Canonicalize to a full refname when possible; OIDs and unresolved
	// revisions yield no symbolic name, so keep the raw input.
	if full, ferr := runGit(ctx, fsPath, "rev-parse", "--symbolic-full-name", raw); ferr == nil {
		if s := strings.TrimSpace(full); s != "" {
			raw = s
		}
	}

	// Discarding untracked files implies a forced checkout: modifications are
	// discarded either way.
	if discardUntracked {
		force = true
	}

	args := []string{"checkout"}
	if force {
		args = append(args, "-f")
	}
	switch {
	case strings.HasPrefix(raw, "refs/heads/"):
		branch := strings.TrimPrefix(raw, "refs/heads/")
		if branch == "" || !checkSafeArg(branch) {
			return checkoutFailed("invalid branch name")
		}
		args = append(args, branch)
	case strings.HasPrefix(raw, "refs/remotes/"):
		rest := strings.TrimPrefix(raw, "refs/remotes/")
		// The remote is the first path component; the branch may contain
		// slashes (e.g. refs/remotes/origin/david/topic).
		slash := strings.IndexByte(rest, '/')
		if slash <= 0 || slash == len(rest)-1 {
			return checkoutFailed("malformed remote-tracking ref")
		}
		remote := rest[:slash]
		branch := rest[slash+1:]
		if branch == "HEAD" || !checkSafeArg(remote) || !checkSafeArg(branch) {
			return checkoutFailed("invalid remote-tracking ref")
		}
		// A pre-existing local branch of the same name wins (no duplicate
		// creation); otherwise create it tracking the remote branch.
		if _, code, _ := runGitAllowExit(ctx, fsPath, "show-ref", "--verify", "--quiet", "refs/heads/"+branch); code == 0 {
			args = append(args, branch)
		} else {
			args = append(args, "-b", branch, "--track", remote+"/"+branch)
		}
	default:
		if !checkSafeArg(raw) {
			return checkoutFailed("invalid ref")
		}
		args = append(args, raw)
	}

	// Refuse destructive cleaning before the ref is known to be valid: token
	// validation prevents option injection but does not prove the ref exists.
	// Verify the canonicalized target resolves first, so a ref that vanished
	// (pruned upstream, deleted branch) or an invalid headless input cannot
	// wipe untracked files when the subsequent switch fails.
	if discardUntracked {
		if _, err := runGit(ctx, fsPath, "rev-parse", "--verify", "--quiet", raw); err != nil {
			return checkoutFailed("ref does not resolve")
		}
		if _, err := runGit(ctx, fsPath, "clean", "-fd"); err != nil {
			return checkoutFailedFromGit(err.Error())
		}
	}

	if _, err := runGit(ctx, fsPath, args...); err != nil {
		return checkoutFailedFromGit(err.Error())
	}
	return nil
}

// defaultStashMessage is used by StashPush when the caller passes an empty
// message.
const defaultStashMessage = "WIP before checkout"

// StashPush saves the working-tree changes (tracked modifications and staged
// changes) to a new stash entry via `git stash push -m <message>` and returns
// the created entry. The new oid is resolved from refs/stash and the branch
// recorded from HEAD. Any failure yields a typed STASH_FAILED error.
func (a *Adapter) StashPush(ctx context.Context, repoID domain.RepositoryId, message string) (*domain.Stash, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	msg := strings.TrimSpace(message)
	if msg == "" {
		msg = defaultStashMessage
	}
	// msg is always the value of `-m`, never a bare option, so it is safe to
	// pass verbatim (including spaces and a leading '-').

	out, err := runGit(ctx, fsPath, "stash", "push", "-m", msg)
	if err != nil {
		return nil, stashFailedFromGit(err.Error())
	}
	// A clean working tree makes `git stash push` a successful no-op; resolving
	// refs/stash would then return a stale entry, so fail explicitly instead.
	if strings.Contains(out, "No local changes to save") {
		return nil, stashFailed("no local changes to save")
	}

	oidOut, err := runGit(ctx, fsPath, "rev-parse", "--verify", "refs/stash")
	if err != nil {
		return nil, stashFailedFromGit(err.Error())
	}
	oid := strings.TrimSpace(oidOut)
	if oid == "" {
		return nil, stashFailed("could not resolve stash oid")
	}

	st := &domain.Stash{Index: 0, Oid: domain.Oid{Hex: oid, Kind: oidKind(oid)}, Message: msg}
	if branchOut, berr := runGit(ctx, fsPath, "rev-parse", "--abbrev-ref", "HEAD"); berr == nil {
		if b := strings.TrimSpace(branchOut); b != "" && b != "HEAD" {
			st.BranchName = &b
		}
	}
	return st, nil
}

// oidKind reports the hash kind for a resolved hex oid.
func oidKind(hex string) string {
	if len(hex) == 64 {
		return "SHA256"
	}
	return "SHA1"
}

// RemoteList lists configured remotes by folding `git config --get-regexp
// '^remote\.'` into Remote entities (name, urls, fetch specs). It is read-only.
// A repository with no remotes yields an empty slice and a nil error.
func (a *Adapter) RemoteList(ctx context.Context, repoID domain.RepositoryId) ([]domain.Remote, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	out, code, err := runGitAllowExit(ctx, fsPath, "config", "--get-regexp", `^remote\.`)
	if err != nil && code != 1 {
		// Exit code 1 means "no matching key" (no remotes), which is not an
		// error; anything else is a genuine failure.
		return nil, err
	}
	return parseRemotes(out), nil
}

// parseRemotes parses `git config --get-regexp '^remote\.'` output (lines of
// "remote.<name>.<field> <value>") into Remote entities, preserving first-seen
// order. Remote names may contain dots, so the field is the text after the last
// dot.
func parseRemotes(out string) []domain.Remote {
	type remoteAgg struct {
		urls  []string
		fetch []string
	}
	byName := map[string]*remoteAgg{}
	order := make([]string, 0)
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		sp := strings.IndexByte(line, ' ')
		if sp < 0 {
			continue
		}
		key := line[:sp]
		value := strings.TrimSpace(line[sp+1:])
		if !strings.HasPrefix(key, "remote.") {
			continue
		}
		rest := strings.TrimPrefix(key, "remote.")
		dot := strings.LastIndexByte(rest, '.')
		if dot <= 0 {
			continue
		}
		name := rest[:dot]
		field := rest[dot+1:]
		agg := byName[name]
		if agg == nil {
			agg = &remoteAgg{urls: []string{}, fetch: []string{}}
			byName[name] = agg
			order = append(order, name)
		}
		switch field {
		case "url":
			agg.urls = append(agg.urls, value)
		case "fetch":
			agg.fetch = append(agg.fetch, value)
		}
	}
	remotes := make([]domain.Remote, 0, len(order))
	for _, name := range order {
		agg := byName[name]
		remotes = append(remotes, domain.Remote{
			Name:       name,
			Urls:       agg.urls,
			FetchSpecs: agg.fetch,
		})
	}
	return remotes
}

// TagList lists tags (refs/tags) in a repository, distinguishing lightweight
// from annotated tags. It is read-only. An empty repository yields an empty
// slice and a nil error.
func (a *Adapter) TagList(ctx context.Context, repoID domain.RepositoryId) ([]domain.Tag, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	out, err := runGit(ctx, fsPath, "for-each-ref", "--format="+tagPrettyFormat, "refs/tags")
	if err != nil {
		return nil, err
	}
	return parseTags(out), nil
}

// parseTags parses `git for-each-ref --format=tagPrettyFormat` output. It is a
// pure helper (unit-tested directly). Annotated tags (objecttype == "tag")
// carry a target (the dereferenced object), tagger and message; lightweight
// tags point directly at the object and have neither tagger nor message.
func parseTags(out string) []domain.Tag {
	records := strings.Split(out, recordSep)
	tags := make([]domain.Tag, 0, len(records))
	for _, rec := range records {
		rec = strings.Trim(rec, "\n\r")
		if rec == "" {
			continue
		}
		fields := strings.SplitN(rec, unitSep, 8)
		if len(fields) < 8 {
			continue
		}
		ref := strings.TrimSpace(fields[0])
		objectOid := strings.TrimSpace(fields[1])
		objectType := strings.TrimSpace(fields[2])
		derefOid := strings.TrimSpace(fields[3])
		taggerName := strings.TrimSpace(fields[4])
		taggerEmail := strings.TrimSpace(fields[5])
		taggerDate := strings.TrimSpace(fields[6])
		subject := strings.TrimSpace(fields[7])

		annotated := objectType == "tag"
		targetHex := objectOid
		if annotated && derefOid != "" {
			targetHex = derefOid
		}
		oid, err := domain.NewOid(targetHex)
		if err != nil {
			continue
		}
		tag := domain.Tag{
			Name:      domain.RefName{Raw: ref}.Short(),
			RefName:   domain.RefName{Raw: ref},
			Target:    oid,
			Annotated: annotated,
		}
		if annotated {
			if taggerName != "" || taggerEmail != "" {
				sig := domain.Signature{Name: taggerName, Email: strings.Trim(taggerEmail, "<>")}
				if when, perr := time.Parse(time.RFC3339, taggerDate); perr == nil {
					sig.When = when
				}
				tag.Tagger = &sig
			}
			if subject != "" {
				msg := subject
				tag.Message = &msg
			}
		}
		tags = append(tags, tag)
	}
	return tags
}

// WorktreeList lists worktrees. Phase 5.
func (a *Adapter) WorktreeList(context.Context, domain.RepositoryId) ([]domain.Worktree, error) {
	return nil, notImplemented("WorktreeList")
}
