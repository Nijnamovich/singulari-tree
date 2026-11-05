package domain

import "context"

// Remote entity (domain-model.md §1.2).
type Remote struct {
	Name       string
	Urls       []string
	FetchSpecs []string
}

// RemotePort is the Git port for remotes.
type RemotePort interface {
	List(ctx context.Context, repoID RepositoryId) ([]Remote, error)
	Add(ctx context.Context, repoID RepositoryId, name string, urls []string) (*Remote, error)
	Remove(ctx context.Context, repoID RepositoryId, name string) error
}
