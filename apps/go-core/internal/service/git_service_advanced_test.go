package service

import (
	"context"
	"errors"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// advancedGitPort is a recording double for the ADR-028 Git operations. The
// embedded interface satisfies the remaining methods (never called here).
type advancedGitPort struct {
	domain.GitPort

	branchCreateCalls int
	gotBranchName     string
	gotStartPoint     string
	gotCheckout       bool
	branchCreateErr   error

	branchRenameCalls int
	gotOldName        string
	gotNewName        string

	branchDeleteCalls int
	gotDeleteName     string
	gotDeleteForce    bool
	branchDeleteErr   error

	mergeCalls    int
	gotMergeRef   string
	gotMergeStrat domain.MergeStrategy
	mergeResult   *domain.MergeResult
	mergeErr      error

	tagCreateCalls int
	gotTagName     string
	tagCreateErr   error
	tagDeleteCalls int

	stashListCalls  int
	stashListResult []domain.Stash
	stashApplyCalls int
	stashPopCalls   int
	stashDropCalls  int
}

func (p *advancedGitPort) BranchCreate(_ context.Context, _ domain.RepositoryId, name, startPoint string, checkout bool) (*domain.Branch, error) {
	p.branchCreateCalls++
	p.gotBranchName, p.gotStartPoint, p.gotCheckout = name, startPoint, checkout
	if p.branchCreateErr != nil {
		return nil, p.branchCreateErr
	}
	return &domain.Branch{Name: name, RefName: domain.RefName{Raw: "refs/heads/" + name}}, nil
}

func (p *advancedGitPort) BranchRename(_ context.Context, _ domain.RepositoryId, oldName, newName string) (*domain.Branch, error) {
	p.branchRenameCalls++
	p.gotOldName, p.gotNewName = oldName, newName
	return &domain.Branch{Name: newName, RefName: domain.RefName{Raw: "refs/heads/" + newName}}, nil
}

func (p *advancedGitPort) BranchDelete(_ context.Context, _ domain.RepositoryId, ref domain.RefName, force bool) error {
	p.branchDeleteCalls++
	p.gotDeleteName, p.gotDeleteForce = ref.Raw, force
	return p.branchDeleteErr
}

func (p *advancedGitPort) Merge(_ context.Context, _ domain.RepositoryId, ref string, strategy domain.MergeStrategy, _ bool, _ string) (*domain.MergeResult, error) {
	p.mergeCalls++
	p.gotMergeRef, p.gotMergeStrat = ref, strategy
	return p.mergeResult, p.mergeErr
}

func (p *advancedGitPort) TagCreate(_ context.Context, _ domain.RepositoryId, name, _ string, _ bool, _ string, _ bool) (*domain.Tag, error) {
	p.tagCreateCalls++
	p.gotTagName = name
	if p.tagCreateErr != nil {
		return nil, p.tagCreateErr
	}
	return &domain.Tag{Name: name, RefName: domain.RefName{Raw: "refs/tags/" + name}}, nil
}

func (p *advancedGitPort) TagDelete(context.Context, domain.RepositoryId, domain.RefName) error {
	p.tagDeleteCalls++
	return nil
}

func (p *advancedGitPort) StashList(context.Context, domain.RepositoryId) ([]domain.Stash, error) {
	p.stashListCalls++
	return p.stashListResult, nil
}

func (p *advancedGitPort) StashApply(context.Context, domain.RepositoryId, int, bool) error {
	p.stashApplyCalls++
	return nil
}

func (p *advancedGitPort) StashPop(context.Context, domain.RepositoryId, int) error {
	p.stashPopCalls++
	return nil
}

func (p *advancedGitPort) StashDrop(context.Context, domain.RepositoryId, int) error {
	p.stashDropCalls++
	return nil
}

// TestGitServiceBranchCreateValidates proves empty names are rejected before
// reaching the Git port and that a successful create invalidates the cache.
func TestGitServiceBranchCreateValidates(t *testing.T) {
	port := &advancedGitPort{}
	cache := &stubCachePort{}
	svc := NewGitService(port, cache, nil)

	if _, err := svc.BranchCreate(context.Background(), "repo-1", "  ", "", false); err == nil {
		t.Fatal("BranchCreate(empty name) succeeded, want error")
	}
	if port.branchCreateCalls != 0 {
		t.Errorf("git calls = %d, want 0 (validation must short-circuit)", port.branchCreateCalls)
	}

	b, err := svc.BranchCreate(context.Background(), "repo-1", "feature/login", "develop", true)
	if err != nil {
		t.Fatalf("BranchCreate: %v", err)
	}
	if b.Name != "feature/login" {
		t.Errorf("branch = %+v", b)
	}
	if port.gotBranchName != "feature/login" || port.gotStartPoint != "develop" || !port.gotCheckout {
		t.Errorf("passed args = %q/%q/%v", port.gotBranchName, port.gotStartPoint, port.gotCheckout)
	}
	if cache.invalidations != 1 {
		t.Errorf("invalidations = %d, want 1", cache.invalidations)
	}
}

// TestGitServiceBranchRenameDelete covers the rename/delete orchestration.
func TestGitServiceBranchRenameDelete(t *testing.T) {
	port := &advancedGitPort{}
	cache := &stubCachePort{}
	svc := NewGitService(port, cache, nil)
	ctx := context.Background()

	if _, err := svc.BranchRename(ctx, "repo-1", "old", "new"); err != nil {
		t.Fatalf("BranchRename: %v", err)
	}
	if port.gotOldName != "old" || port.gotNewName != "new" {
		t.Errorf("rename args = %q/%q", port.gotOldName, port.gotNewName)
	}

	if err := svc.BranchDelete(ctx, "repo-1", domain.RefName{Raw: "refs/heads/old"}, true); err != nil {
		t.Fatalf("BranchDelete: %v", err)
	}
	if port.gotDeleteName != "old" || !port.gotDeleteForce {
		t.Errorf("delete args = %q/%v, want old/true (refs/heads stripped)", port.gotDeleteName, port.gotDeleteForce)
	}
	if cache.invalidations != 2 {
		t.Errorf("invalidations = %d, want 2", cache.invalidations)
	}
}

// TestGitServiceMerge covers strategy rejection, a conflict (which still
// invalidates the cache) and a hard failure (which does not).
func TestGitServiceMerge(t *testing.T) {
	ctx := context.Background()

	// Unspecified strategy is rejected before the port.
	port := &advancedGitPort{}
	svc := NewGitService(port, &stubCachePort{}, nil)
	if _, err := svc.Merge(ctx, "repo-1", "feature", domain.MergeStrategyUnspecified, false, ""); err == nil {
		t.Fatal("Merge(unspecified) succeeded, want error")
	}
	if port.mergeCalls != 0 {
		t.Errorf("merge calls = %d, want 0", port.mergeCalls)
	}

	// Conflict: result + MERGE_CONFLICT and a cache invalidation.
	port = &advancedGitPort{
		mergeResult: &domain.MergeResult{HasConflict: true},
		mergeErr:    domain.ErrMergeConflict,
	}
	cache := &stubCachePort{}
	svc = NewGitService(port, cache, nil)
	res, err := svc.Merge(ctx, "repo-1", "feature", domain.MergeStrategyMerge, false, "")
	var appErr domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeMergeConflict {
		t.Fatalf("err = %v, want MERGE_CONFLICT", err)
	}
	if res == nil || !res.HasConflict {
		t.Fatalf("result = %+v, want HasConflict", res)
	}
	if port.gotMergeStrat != domain.MergeStrategyMerge {
		t.Errorf("strategy = %v, want Merge", port.gotMergeStrat)
	}
	if cache.invalidations != 1 {
		t.Errorf("invalidations = %d, want 1 (conflict mutates the tree)", cache.invalidations)
	}

	// Hard failure: no invalidation.
	port = &advancedGitPort{mergeErr: domain.ErrMergeFailed}
	cache = &stubCachePort{}
	svc = NewGitService(port, cache, nil)
	if _, err := svc.Merge(ctx, "repo-1", "feature", domain.MergeStrategyMerge, false, ""); err == nil {
		t.Fatal("Merge(failed) returned nil error")
	}
	if cache.invalidations != 0 {
		t.Errorf("invalidations = %d, want 0 on a hard failure", cache.invalidations)
	}
}

// TestGitServiceTagAndStash covers the tag and stash use cases.
func TestGitServiceTagAndStash(t *testing.T) {
	port := &advancedGitPort{stashListResult: []domain.Stash{{Index: 0, Message: "wip"}}}
	cache := &stubCachePort{}
	svc := NewGitService(port, cache, nil)
	ctx := context.Background()

	if _, err := svc.TagCreate(ctx, "repo-1", "  ", "", false, "", false); err == nil {
		t.Fatal("TagCreate(empty name) succeeded, want error")
	}
	if port.tagCreateCalls != 0 {
		t.Errorf("tag calls = %d, want 0", port.tagCreateCalls)
	}

	if _, err := svc.TagCreate(ctx, "repo-1", "v1.0", "HEAD", true, "release", false); err != nil {
		t.Fatalf("TagCreate: %v", err)
	}
	if err := svc.TagDelete(ctx, "repo-1", domain.RefName{Raw: "refs/tags/v1.0"}); err != nil {
		t.Fatalf("TagDelete: %v", err)
	}

	stashes, err := svc.StashList(ctx, "repo-1")
	if err != nil {
		t.Fatalf("StashList: %v", err)
	}
	if len(stashes) != 1 || port.stashListCalls != 1 {
		t.Errorf("StashList = %+v calls=%d", stashes, port.stashListCalls)
	}
	if err := svc.StashApply(ctx, "repo-1", 0, true); err != nil {
		t.Fatalf("StashApply: %v", err)
	}
	if err := svc.StashPop(ctx, "repo-1", 0); err != nil {
		t.Fatalf("StashPop: %v", err)
	}
	if err := svc.StashDrop(ctx, "repo-1", 0); err != nil {
		t.Fatalf("StashDrop: %v", err)
	}
	if port.stashApplyCalls != 1 || port.stashPopCalls != 1 || port.stashDropCalls != 1 {
		t.Errorf("stash calls = %d/%d/%d, want 1/1/1", port.stashApplyCalls, port.stashPopCalls, port.stashDropCalls)
	}
	if cache.invalidations != 5 {
		t.Errorf("invalidations = %d, want 5", cache.invalidations)
	}
}
