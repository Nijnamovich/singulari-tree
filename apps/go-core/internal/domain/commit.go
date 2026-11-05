package domain

import (
	"context"
	"regexp"
	"strings"
	"time"
)

// Oid is a Git object ID value object (SHA-1 40 or SHA-256 64 hex).
type Oid struct {
	Hex  string
	Kind string // "SHA1" | "SHA256"
}

var oidRe = regexp.MustCompile(`^[0-9a-f]{40,64}$`)

// NewOid validates and normalizes an Oid.
func NewOid(hex string) (Oid, error) {
	hex = strings.ToLower(strings.TrimSpace(hex))
	if !oidRe.MatchString(hex) {
		return Oid{}, AppError{Code: ErrCodeInvalidOid, Message: "invalid oid", Details: map[string]string{"oid": hex}}
	}
	kind := "SHA1"
	if len(hex) == 64 {
		kind = "SHA256"
	}
	return Oid{Hex: hex, Kind: kind}, nil
}

// Short returns 7-char abbreviated hex.
func (o Oid) Short() string {
	if len(o.Hex) > 7 {
		return o.Hex[:7]
	}
	return o.Hex
}

// Signature is author/committer identity.
type Signature struct {
	Name  string
	Email string
	When  time.Time
}

// RefLabel is a Git ref decoration pointing at a commit (wire: domain.proto
// RefLabel). Kind is one of "head", "branch", "remote" or "tag"; Name is the
// short label (e.g. "main", "origin/main", "v1.0.0").
type RefLabel struct {
	Name string
	Kind string
}

// Ref kind values used by RefLabel.Kind.
const (
	RefKindHead   = "head"
	RefKindBranch = "branch"
	RefKindRemote = "remote"
	RefKindTag    = "tag"
)

// Commit is an immutable Git commit entity (domain-model.md §1.2).
type Commit struct {
	Oid         Oid
	Parents     []Oid
	Author      Signature
	Committer   Signature
	Message     string
	TreeOid     Oid
	CommittedAt time.Time
	// Refs are the ref decorations pointing at this commit (may be nil). They
	// are populated by the read adapter and never computed in the domain.
	Refs []RefLabel
}

// CommitPort is the read port for commits.
//
// List returns one window of commits in topological order (newest first) plus
// the total reachable count. With empty refs it walks history from HEAD, which
// is the ordinary graph read. With non-empty refs it walks the union HEAD ∪ refs
// (a branch lens) without checking any ref out, and the total is the union's
// reachable count.
type CommitPort interface {
	Get(ctx context.Context, repoID RepositoryId, oid Oid) (*Commit, error)
	List(ctx context.Context, repoID RepositoryId, refs []string, offset, limit int) ([]Commit, int, error)
}

// CommitLister is the narrow read port GraphService needs to walk history from
// HEAD or, when refs is non-empty, the union HEAD ∪ refs: a windowed commit
// listing plus the total reachable count. It is a subset of CommitPort (and
// therefore of GitPort) plus the lens membership read; services depend on the
// smallest port that satisfies them.
type CommitLister interface {
	List(ctx context.Context, repoID RepositoryId, refs []string, offset, limit int) ([]Commit, int, error)
	// LensOids returns the oids reachable from refs, i.e. the branch-lens
	// membership set used to mark which listed commits belong to the lens. It is
	// a plain reachability read and does not imply a checkout. Empty refs yield
	// an empty result.
	LensOids(ctx context.Context, repoID RepositoryId, refs []string) ([]string, error)
}

// Errors
var (
	ErrCommitNotFound = AppError{Code: ErrCodeCommitNotFound, Message: "commit not found"}
	ErrInvalidOid     = AppError{Code: ErrCodeInvalidOid, Message: "invalid oid"}
)

