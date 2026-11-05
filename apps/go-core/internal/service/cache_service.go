package service

import (
	"context"
	"strconv"
	"sync"

	"github.com/SingulariTree/go-core/internal/domain"
)

// cacheEntry stores a cached commit window together with the total reachable
// count that was known when the window was cached.
type cacheEntry struct {
	commits []domain.Commit
	total   int
}

// DefaultLRUCapacity is the default number of commit windows retained in the
// L1 in-memory commit cache (service-design.md §6).
const DefaultLRUCapacity = 500

// CacheService implements LRU (DefaultLRUCapacity entries) + SQLite coherence (service-design.md §6).
//
// It is the L1 (in-memory) layer of the commit cache; an optional L2 store
// (SQLite CommitCache) can be layered underneath via NewCacheServiceWithStore.
type CacheService struct {
	mu       sync.RWMutex
	capacity int
	entries  map[string]cacheEntry
	order    []string
	store    domain.CachePort
	// generation is the invalidation generation: a monotonic counter bumped on
	// every Invalidate. A reader can capture it before a Git read and compare it
	// afterwards to detect that an invalidation raced that read (see
	// GraphService.Commits). Guarded by mu.
	generation uint64
}

// NewCacheService creates a CacheService with given LRU capacity and no L2 store.
func NewCacheService(capacity int) *CacheService {
	return NewCacheServiceWithStore(capacity, nil)
}

// NewCacheServiceWithStore creates a CacheService whose L2 store is the given
// persistence port. Writes go to L1 first and then through to store; reads are
// served from L1 only (the caller falls back to Git on a miss).
func NewCacheServiceWithStore(capacity int, store domain.CachePort) *CacheService {
	if capacity <= 0 {
		capacity = DefaultLRUCapacity
	}
	return &CacheService{
		capacity: capacity,
		entries:  make(map[string]cacheEntry),
		store:    store,
	}
}

// cacheKey identifies one window by repository and offset. The limit is not part
// of the key so a larger-limit read can be served from a smaller cached window;
// GetCommits slices the stored commits down to the requested limit.
func cacheKey(repoID domain.RepositoryId, offset int) string {
	return string(repoID) + ":" + strconv.Itoa(offset)
}

// GetCommits tries LRU: it returns up to limit commits from the stored window
// plus the stored total, together with whether the window was cached.
func (s *CacheService) GetCommits(_ context.Context, repoID domain.RepositoryId, offset, limit int) ([]domain.Commit, int, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.entries[cacheKey(repoID, offset)]
	if !ok {
		return nil, 0, false
	}
	commits := e.commits
	if limit > 0 && len(commits) > limit {
		commits = commits[:limit]
	}
	return commits, e.total, true
}

// PutCommits stores a window in LRU (evicts oldest if over capacity), then
// writes through to the L2 store when present. The store's error is returned;
// whether a failed persistent write should fail the caller is the caller's
// choice.
func (s *CacheService) PutCommits(ctx context.Context, repoID domain.RepositoryId, offset, total int, commits []domain.Commit) error {
	s.mu.Lock()
	k := cacheKey(repoID, offset)
	if _, exists := s.entries[k]; !exists {
		if len(s.entries) >= s.capacity {
			if len(s.order) > 0 {
				delete(s.entries, s.order[0])
				s.order = s.order[1:]
			}
		}
		s.order = append(s.order, k)
	}
	s.entries[k] = cacheEntry{commits: commits, total: total}
	s.mu.Unlock()

	if s.store != nil {
		return s.store.PutCommits(ctx, repoID, offset, total, commits)
	}
	return nil
}

// GetCommitStats reads cached change-size counts from the L2 store (ADR-0023).
// Stats are not held in the L1 commit-window LRU; a miss falls through to Git.
func (s *CacheService) GetCommitStats(ctx context.Context, repoID domain.RepositoryId, oids []string) ([]domain.CommitStats, bool) {
	if s.store == nil {
		return nil, false
	}
	return s.store.GetCommitStats(ctx, repoID, oids)
}

// PutCommitStats writes change-size counts through to the L2 store.
func (s *CacheService) PutCommitStats(ctx context.Context, repoID domain.RepositoryId, stats []domain.CommitStats) error {
	if s.store == nil {
		return nil
	}
	return s.store.PutCommitStats(ctx, repoID, stats)
}

// Invalidate removes entries for a repo from L1 and, when present, from L2.
func (s *CacheService) Invalidate(repoID domain.RepositoryId) {
	s.mu.Lock()
	// Bump the invalidation generation under the same lock that performs the
	// removal, so a read that captured Generation() before may observe the bump
	// (and skip its write-through) whenever this invalidation raced it.
	s.generation++
	prefix := string(repoID) + ":"
	for k := range s.entries {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			delete(s.entries, k)
		}
	}
	// rebuild order
	n := 0
	for _, k := range s.order {
		if _, ok := s.entries[k]; ok {
			s.order[n] = k
			n++
		}
	}
	s.order = s.order[:n]
	s.mu.Unlock()

	if s.store != nil {
		s.store.Invalidate(repoID)
	}
}

// Generation returns the invalidation generation. It is a monotonic counter,
// bumped on every Invalidate and unchanged otherwise. A reader captures it
// before a Git read and compares it afterwards: a changed value proves an
// invalidation raced that read, so the read's window may predate the mutation
// that invalidated and must not be written back through (see
// GraphService.Commits).
func (s *CacheService) Generation() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.generation
}
