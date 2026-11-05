package service

import (
	"context"
	"testing"
)

// TestNewCacheServiceDefaultsCapacity pins that a non-positive capacity falls
// back to the named default rather than a magic literal.
func TestNewCacheServiceDefaultsCapacity(t *testing.T) {
	if got := NewCacheService(0).capacity; got != DefaultLRUCapacity {
		t.Fatalf("NewCacheService(0).capacity = %d, want %d", got, DefaultLRUCapacity)
	}
	if got := NewCacheService(-1).capacity; got != DefaultLRUCapacity {
		t.Fatalf("NewCacheService(-1).capacity = %d, want %d", got, DefaultLRUCapacity)
	}
	if got := NewCacheService(7).capacity; got != 7 {
		t.Fatalf("NewCacheService(7).capacity = %d, want 7", got)
	}
}

// TestCacheServiceGenerationBumpsOnInvalidate pins the invalidation-generation
// contract the straddle guard relies on: the counter starts at zero, increments
// exactly once per Invalidate, and is unchanged by other operations.
func TestCacheServiceGenerationBumpsOnInvalidate(t *testing.T) {
	ctx := context.Background()
	c := NewCacheService(4)

	if got := c.Generation(); got != 0 {
		t.Fatalf("initial Generation() = %d, want 0", got)
	}

	// Non-invalidation operations must not move the counter.
	if err := c.PutCommits(ctx, "repo-a", 0, 0, nil); err != nil {
		t.Fatalf("PutCommits: %v", err)
	}
	c.GetCommits(ctx, "repo-a", 0, 10)
	if got := c.Generation(); got != 0 {
		t.Fatalf("Generation() after non-invalidation ops = %d, want 0", got)
	}

	c.Invalidate("repo-a")
	if got := c.Generation(); got != 1 {
		t.Fatalf("Generation() after first Invalidate = %d, want 1", got)
	}

	// The counter is global (repo-independent) and strictly monotonic.
	c.Invalidate("repo-b")
	if got := c.Generation(); got != 2 {
		t.Fatalf("Generation() after second Invalidate = %d, want 2", got)
	}
}
