package domain

import "context"

// RemoteOpOptions carries the additive flags for Fetch/Push/Pull. Each field
// un-defers a previously-deferred remote-op dialog option and maps to a git flag
// applied by the adapter.
type RemoteOpOptions struct {
	// Fetch flags.
	Prune bool // previously-deferred fetch.prune -> --prune
	Tags  bool // previously-deferred fetch.tags -> --tags
	Force bool // previously-deferred fetch.overwriteTags -> --force

	// Push flags.
	SetUpstream  bool   // previously-deferred push.track -> --set-upstream
	RemoteBranch string // previously-deferred push.remoteBranch -> push <remote> <branch>:<remote_branch>

	// Pull flags.
	LocalBranch string // previously-deferred pull.intoLocal -> pull <remote> <branch>:<local_branch>
	NoCommit    bool   // previously-deferred pull.commitMerged -> --no-commit
	Log         bool   // previously-deferred pull.includeMergedMessages -> --log
	NoFF        bool   // previously-deferred pull.noFF -> --no-ff
	Rebase      bool   // previously-deferred pull.rebase -> --rebase
}

// Progress is a single streaming progress chunk emitted by a remote operation.
// Percent is in the range 0..100; Message carries the human-readable git
// progress line (which may have no percentage, e.g. "remote: ...").
type Progress struct {
	Percent uint32
	Message string
}

// RemoteOpResult is a single item of a remote operation's result stream. A
// stream carries zero or more Progress items followed by, at most, one terminal
// item with Err set. Exactly one field is meaningful per item (Progress non-nil
// for a chunk, Err non-nil for a failure); a clean channel close with no
// terminal Err means the operation succeeded. Err carries a typed AppError whose
// Code is the operation's *_FAILED code.
type RemoteOpResult struct {
	Progress *Progress
	Err      error
}

// RemoteOpsPort is the Git port for networked remote operations. Implementations
// stream RemoteOpResult items over a channel that closes when the operation
// completes, fails, or the context is cancelled. A transport-level failure that
// happens after the command starts (e.g. a rejected non-fast-forward push) is
// delivered as a terminal result with Err set, so callers can distinguish a
// failed operation from a clean close; context cancellation stops the stream
// silently with no terminal error (risks.md R12).
type RemoteOpsPort interface {
	Fetch(ctx context.Context, repoID RepositoryId, remote string, opts RemoteOpOptions) (<-chan RemoteOpResult, error)
	Push(ctx context.Context, repoID RepositoryId, remote, branch string, opts RemoteOpOptions) (<-chan RemoteOpResult, error)
	Pull(ctx context.Context, repoID RepositoryId, remote, branch string, opts RemoteOpOptions) (<-chan RemoteOpResult, error)
}
