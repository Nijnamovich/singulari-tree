package domain

import "context"

// Tag entity (domain-model.md §1.2).
type Tag struct {
	Name      string
	RefName   RefName
	Target    Oid
	Tagger    *Signature
	Message   *string
	Annotated bool
}

// TagPort is the Git port for tags.
type TagPort interface {
	List(ctx context.Context, repoID RepositoryId) ([]Tag, error)
	// Create maps to `git tag [-a -m <message>] [-f] <name> [<target>]`. An
	// empty target means HEAD; annotated tags carry the message.
	Create(ctx context.Context, repoID RepositoryId, name, target string, annotated bool, message string, force bool) (*Tag, error)
	// Delete maps to `git tag -d <name>`.
	Delete(ctx context.Context, repoID RepositoryId, ref RefName) error
}
