package domain

import "context"

// DiffLine is a single line in a hunk.
type DiffLine struct {
	Kind      string // "added" | "removed" | "context"
	Text      string
	NoNewline bool
}

// Hunk is a contiguous diff section.
type Hunk struct {
	FromStart int
	FromLines int
	ToStart   int
	ToLines   int
	Lines     []DiffLine
}

// FileDiff is a per-file diff section (ADR-0020). One FileDiff per changed
// path; it is the addressing substrate for hunk/line staging and discard.
// Status is a porcelain-v2 code (M, A, D, R, C, T, U, ...); OldPath is set only
// for renames/copies.
type FileDiff struct {
	Path               string
	OldPath            string
	Status             string
	Hunks              []Hunk
	Additions          int
	Deletions          int
	IsBinary           bool
	HasConflictMarkers bool
}

// Diff value object (domain-model.md §1.3, ADR-0020). Files carries the
// per-file sections; Hunks is the deprecated flat concatenation of every file's
// hunks in git order, retained for back-compat. Truncated is true when the
// payload was capped by the core (MaxDiffHunks/MaxDiffLines).
type Diff struct {
	From               Oid
	To                 Oid
	Hunks              []Hunk
	Additions          int
	Deletions          int
	IsBinary           bool
	HasConflictMarkers bool
	Files              []FileDiff
	Truncated          bool
}

// DiffRequest addresses a diff read (ADR-0020). From/To follow the existing
// empty-side conventions; Path is an optional per-file selector; Staged selects
// HEAD->index (git diff --cached) instead of HEAD->worktree.
type DiffRequest struct {
	From   Oid
	To     Oid
	Path   string
	Staged bool
}

// CommitStats is the per-commit change-size gauge (ADR-0023). Counts only; it
// is cached in SQLite and never carries Git objects.
type CommitStats struct {
	Oid          string
	Additions    int
	Deletions    int
	FilesChanged int
}

// ResetMode names the git reset mode (ADR-0021). The zero value is invalid:
// callers must name a mode.
type ResetMode int

const (
	ResetModeUnspecified ResetMode = iota
	ResetModeSoft
	ResetModeMixed
	ResetModeHard
)

// FileStatus is working-tree status (porcelain v2).
type FileStatus struct {
	Path         string
	Staged       string
	Unstaged     string
	IsStaged     bool
	IsConflicted bool
}

// DiffPort is the Git port for diff/status.
type DiffPort interface {
	Diff(ctx context.Context, repoID RepositoryId, req DiffRequest) (*Diff, error)
	Status(ctx context.Context, repoID RepositoryId) ([]FileStatus, error)
}

// GitPort aggregates all Git operations (used by services).
// It deliberately does NOT embed BranchPort/RemotePort/etc. to avoid duplicate method names
// (all have List/Add etc. with different signatures). Services depend on the specific port they need.
type GitPort interface {
	DiffPort
	CommitPort
	RemoteOpsPort
	// Resolve returns the repository top-level directory and its git common dir
	// for a filesystem path, or ErrNotAGitRepo when the path is not a repo.
	Resolve(ctx context.Context, fsPath string) (topLevel, commonDir string, err error)
	Status(ctx context.Context, repoID RepositoryId) ([]FileStatus, error)
	Stage(ctx context.Context, repoID RepositoryId, paths []string) error
	Unstage(ctx context.Context, repoID RepositoryId, paths []string) error
	// Hunk/line staging and discard (ADR-0020). The core re-derives the diff
	// from the address (path + hunk index + optional line indices) and applies
	// a core-constructed patch; the caller never sends patch bytes.
	StageHunk(ctx context.Context, repoID RepositoryId, path string, hunkIndex uint32, lineIndices []uint32) error
	UnstageHunk(ctx context.Context, repoID RepositoryId, path string, hunkIndex uint32, lineIndices []uint32) error
	DiscardHunk(ctx context.Context, repoID RepositoryId, path string, hunkIndex uint32, lineIndices []uint32) error
	// Discard reverts file-level changes: tracked paths from HEAD/index,
	// untracked paths by removal.
	Discard(ctx context.Context, repoID RepositoryId, paths []string) error
	// Reset maps to git reset --<mode> <to> (ADR-0021).
	Reset(ctx context.Context, repoID RepositoryId, to string, mode ResetMode) error
	// CommitStats computes the change-size counts for each oid (first parent,
	// or the empty tree for a root commit) (ADR-0023).
	CommitStats(ctx context.Context, repoID RepositoryId, oids []string) ([]CommitStats, error)
	Commit(ctx context.Context, repoID RepositoryId, message string, author *Signature) (*Commit, error)
	BranchList(ctx context.Context, repoID RepositoryId) ([]Branch, error)
	// BranchCreate creates a local branch from startPoint (empty means HEAD),
	// optionally checking it out (ADR-028).
	BranchCreate(ctx context.Context, repoID RepositoryId, name, startPoint string, checkout bool) (*Branch, error)
	// BranchRename maps to `git branch -m <oldName> <newName>` (ADR-028).
	BranchRename(ctx context.Context, repoID RepositoryId, oldName, newName string) (*Branch, error)
	// BranchDelete maps to `git branch -d|-D <name>`; force selects -D (ADR-028).
	BranchDelete(ctx context.Context, repoID RepositoryId, ref RefName, force bool) error
	Checkout(ctx context.Context, repoID RepositoryId, ref RefName, force, discardUntracked bool) error
	// Merge maps to `git merge` with the named strategy (ADR-028). A conflict
	// leaves the tree conflicted and returns a result with HasConflict set plus
	// a typed MERGE_CONFLICT error.
	Merge(ctx context.Context, repoID RepositoryId, ref string, strategy MergeStrategy, noCommit bool, message string) (*MergeResult, error)
	// Cherry-pick, revert and read-only revision resolution (ADR-0042). A
	// conflict leaves the tree conflicted and returns a result with
	// HasConflict set plus a typed CHERRY_PICK_CONFLICT/REVERT_CONFLICT error.
	CherryPick(ctx context.Context, repoID RepositoryId, source string, recordOrigin, noCommit bool) (*SequencerResult, error)
	Revert(ctx context.Context, repoID RepositoryId, source string) (*SequencerResult, error)
	ResolveRevision(ctx context.Context, repoID RepositoryId, revision string) (*Commit, error)
	RemoteList(ctx context.Context, repoID RepositoryId) ([]Remote, error)
	TagList(ctx context.Context, repoID RepositoryId) ([]Tag, error)
	// TagCreate maps to `git tag [-a -m <message>] [-f] <name> [<target>]`; an
	// empty target means HEAD (ADR-028).
	TagCreate(ctx context.Context, repoID RepositoryId, name, target string, annotated bool, message string, force bool) (*Tag, error)
	// TagDelete maps to `git tag -d <name>` (ADR-028).
	TagDelete(ctx context.Context, repoID RepositoryId, ref RefName) error
	StashList(ctx context.Context, repoID RepositoryId) ([]Stash, error)
	// StashPush saves the working-tree changes to a new stash entry and returns
	// it. It mirrors StashList so GitService can depend on GitPort alone.
	StashPush(ctx context.Context, repoID RepositoryId, message string) (*Stash, error)
	// StashApply/Pop/Drop map to `git stash apply|pop|drop stash@{N}` (ADR-028);
	// Apply takes restoreIndex (maps to --index).
	StashApply(ctx context.Context, repoID RepositoryId, index int, restoreIndex bool) error
	StashPop(ctx context.Context, repoID RepositoryId, index int) error
	StashDrop(ctx context.Context, repoID RepositoryId, index int) error
	WorktreeList(ctx context.Context, repoID RepositoryId) ([]Worktree, error)
}

// GraphPort is for commit graph + lanes (service-design.md §1.2).
type GraphPort interface {
	Commits(ctx context.Context, repoID RepositoryId, offset, limit int) ([]Commit, int, error)
	Lanes(ctx context.Context, repoID RepositoryId, commits []Commit) ([]Lane, error)
}

// Lane is a value object for graph rendering.
type Lane struct {
	Index     int
	Color     int
	Continues bool
}

// WatcherPort (fsnotify abstraction).
type WatcherPort interface {
	Watch(ctx context.Context, repoID RepositoryId) (<-chan FsChangedEvent, error)
	Unwatch(repoID RepositoryId) error
}

// FsChangedEvent is emitted by WatcherService, coalesced over its debounce
// window (default 150ms).
type FsChangedEvent struct {
	RepoID RepositoryId
	Paths  []string
}

// CachePort is the persistence port for commit cache + file_status.
type CachePort interface {
	// GetCommits returns a window of cached commits plus the total reachable
	// count, mirroring CommitPort.List so callers can compute hasMore. ok is
	// false on a cache miss.
	GetCommits(ctx context.Context, repoID RepositoryId, offset, limit int) ([]Commit, int, bool)
	// PutCommits stores a window that starts at offset together with the total
	// reachable count known when it was read. Implementations may ignore total
	// when their storage keys on offset alone.
	PutCommits(ctx context.Context, repoID RepositoryId, offset, total int, commits []Commit) error
	// GetCommitStats returns the cached stats for the requested oids (only the
	// ones present); found is true when at least one was cached (ADR-0023).
	GetCommitStats(ctx context.Context, repoID RepositoryId, oids []string) ([]CommitStats, bool)
	// PutCommitStats stores stats for a repo (counts only, never Git objects).
	PutCommitStats(ctx context.Context, repoID RepositoryId, stats []CommitStats) error
	// Invalidate drops the repo's commit and stats caches.
	Invalidate(repoID RepositoryId)
}
