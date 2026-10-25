package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/SingulariTree/go-core/internal/domain"
)

// sequencerGitPort records the cherry-pick/revert/revision calls GitService
// makes. The embedded interface satisfies the remaining methods.
type sequencerGitPort struct {
	domain.GitPort

	cherryPickCalls int
	gotSource       string
	gotRecordOrigin bool
	gotNoCommit     bool
	cherryPickRes   *domain.SequencerResult
	cherryPickErr   error

	revertCalls int
	revertRes   *domain.SequencerResult
	revertErr   error

	resolveCalls int
	gotRevision  string
	resolveRes   *domain.Commit
	resolveErr   error
}

func (p *sequencerGitPort) CherryPick(_ context.Context, _ domain.RepositoryId, source string, recordOrigin, noCommit bool) (*domain.SequencerResult, error) {
	p.cherryPickCalls++
	p.gotSource, p.gotRecordOrigin, p.gotNoCommit = source, recordOrigin, noCommit
	return p.cherryPickRes, p.cherryPickErr
}

func (p *sequencerGitPort) Revert(_ context.Context, _ domain.RepositoryId, source string) (*domain.SequencerResult, error) {
	p.revertCalls++
	p.gotSource = source
	return p.revertRes, p.revertErr
}

func (p *sequencerGitPort) ResolveRevision(_ context.Context, _ domain.RepositoryId, revision string) (*domain.Commit, error) {
	p.resolveCalls++
	p.gotRevision = revision
	return p.resolveRes, p.resolveErr
}

// newSequencerWatcher builds a deterministic watcher that records the events a
// mutation emits once its debounce window is fired.
func newSequencerWatcher() (*WatcherService, *fakeScheduler, *collector) {
	sched := newFakeScheduler()
	watcher := newWatcherService(&fakeWatcherPort{}, 150*time.Millisecond, sched)
	var c collector
	watcher.OnChange(c.add)
	return watcher, sched, &c
}

// TestGitServiceCherryPickAndRevert covers success (invalidate + notify),
// conflict (still invalidate + notify, error returned) and a plain failure (no
// invalidation), plus the guard rails.
func TestGitServiceCherryPickAndRevert(t *testing.T) {
	ctx := context.Background()
	const repoID = domain.RepositoryId("repo-1")

	t.Run("cherry-pick success", func(t *testing.T) {
		port := &sequencerGitPort{cherryPickRes: &domain.SequencerResult{Oid: domain.Oid{Hex: strings40("a")}}}
		cache := &stubCachePort{}
		watcher, sched, c := newSequencerWatcher()
		svc := NewGitService(port, cache, watcher)

		res, err := svc.CherryPick(ctx, repoID, "feature", true, true)
		if err != nil {
			t.Fatalf("CherryPick: %v", err)
		}
		if res == nil || res.Oid.Hex != strings40("a") {
			t.Fatalf("result = %+v", res)
		}
		if port.gotSource != "feature" || !port.gotRecordOrigin || !port.gotNoCommit {
			t.Errorf("args = %q/%v/%v, want feature/true/true", port.gotSource, port.gotRecordOrigin, port.gotNoCommit)
		}
		if cache.invalidations != 1 {
			t.Errorf("invalidations = %d, want 1", cache.invalidations)
		}
		sched.fireAll()
		if got := c.snapshot(); len(got) != 1 || got[0].RepoID != repoID {
			t.Errorf("watcher events = %+v, want one for %s", got, repoID)
		}
	})

	t.Run("cherry-pick conflict", func(t *testing.T) {
		port := &sequencerGitPort{
			cherryPickRes: &domain.SequencerResult{HasConflict: true},
			cherryPickErr: domain.ErrCherryPickConflict,
		}
		cache := &stubCachePort{}
		watcher, sched, c := newSequencerWatcher()
		svc := NewGitService(port, cache, watcher)

		res, err := svc.CherryPick(ctx, repoID, "feature", false, false)
		var appErr domain.AppError
		if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeCherryPickConflict {
			t.Fatalf("err = %v, want CHERRY_PICK_CONFLICT", err)
		}
		if res == nil || !res.HasConflict {
			t.Fatalf("result = %+v, want HasConflict", res)
		}
		if cache.invalidations != 1 {
			t.Errorf("invalidations = %d, want 1 (conflict mutates the tree)", cache.invalidations)
		}
		sched.fireAll()
		if got := c.snapshot(); len(got) != 1 {
			t.Errorf("watcher events = %d, want 1", len(got))
		}
	})

	t.Run("cherry-pick hard failure", func(t *testing.T) {
		port := &sequencerGitPort{cherryPickErr: domain.AppError{Code: domain.ErrCodeCherryPickFailed, Message: "boom"}}
		cache := &stubCachePort{}
		watcher, sched, c := newSequencerWatcher()
		svc := NewGitService(port, cache, watcher)

		if _, err := svc.CherryPick(ctx, repoID, "feature", false, false); err == nil {
			t.Fatal("CherryPick(failed) returned nil error")
		}
		if cache.invalidations != 0 {
			t.Errorf("invalidations = %d, want 0 on a hard failure", cache.invalidations)
		}
		sched.fireAll()
		if got := c.snapshot(); len(got) != 0 {
			t.Errorf("watcher events = %d, want 0 on a hard failure", len(got))
		}
	})

	t.Run("revert success", func(t *testing.T) {
		port := &sequencerGitPort{revertRes: &domain.SequencerResult{Oid: domain.Oid{Hex: strings40("b")}}}
		cache := &stubCachePort{}
		watcher, sched, c := newSequencerWatcher()
		svc := NewGitService(port, cache, watcher)

		res, err := svc.Revert(ctx, repoID, "HEAD")
		if err != nil {
			t.Fatalf("Revert: %v", err)
		}
		if res == nil || res.Oid.Hex != strings40("b") || port.gotSource != "HEAD" {
			t.Fatalf("result = %+v source=%q", res, port.gotSource)
		}
		if cache.invalidations != 1 {
			t.Errorf("invalidations = %d, want 1", cache.invalidations)
		}
		sched.fireAll()
		if got := c.snapshot(); len(got) != 1 || got[0].RepoID != repoID {
			t.Errorf("watcher events = %+v, want one for %s", got, repoID)
		}
	})

	t.Run("revert conflict", func(t *testing.T) {
		port := &sequencerGitPort{
			revertRes: &domain.SequencerResult{HasConflict: true},
			revertErr: domain.ErrRevertConflict,
		}
		cache := &stubCachePort{}
		watcher, sched, c := newSequencerWatcher()
		svc := NewGitService(port, cache, watcher)

		res, err := svc.Revert(ctx, repoID, "HEAD")
		var appErr domain.AppError
		if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeRevertConflict {
			t.Fatalf("err = %v, want REVERT_CONFLICT", err)
		}
		if res == nil || !res.HasConflict {
			t.Fatalf("result = %+v, want HasConflict", res)
		}
		if cache.invalidations != 1 {
			t.Errorf("invalidations = %d, want 1 (conflict mutates the tree)", cache.invalidations)
		}
		sched.fireAll()
		if got := c.snapshot(); len(got) != 1 || got[0].RepoID != repoID {
			t.Errorf("watcher events = %+v, want one for %s", got, repoID)
		}
	})

	t.Run("revert hard failure", func(t *testing.T) {
		port := &sequencerGitPort{revertErr: domain.AppError{Code: domain.ErrCodeRevertFailed, Message: "boom"}}
		cache := &stubCachePort{}
		watcher, _, c := newSequencerWatcher()
		svc := NewGitService(port, cache, watcher)

		if _, err := svc.Revert(ctx, repoID, "HEAD"); err == nil {
			t.Fatal("Revert(failed) returned nil error")
		}
		if cache.invalidations != 0 {
			t.Errorf("invalidations = %d, want 0", cache.invalidations)
		}
		if got := c.snapshot(); len(got) != 0 {
			t.Errorf("watcher events = %d, want 0", len(got))
		}
	})

	t.Run("guards", func(t *testing.T) {
		// Nil port.
		svc := NewGitService(nil, nil, nil)
		_, err := svc.CherryPick(ctx, repoID, "feature", false, false)
		var appErr domain.AppError
		if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeCherryPickFailed || appErr.Message != "git not configured" {
			t.Errorf("CherryPick(nil port) err = %v, want CHERRY_PICK_FAILED git not configured", err)
		}
		_, err = svc.Revert(ctx, repoID, "HEAD")
		if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeRevertFailed || appErr.Message != "git not configured" {
			t.Errorf("Revert(nil port) err = %v, want REVERT_FAILED git not configured", err)
		}
		if _, err := svc.ResolveRevision(ctx, repoID, "HEAD"); !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeCommitNotFound {
			t.Errorf("ResolveRevision(nil port) err = %v, want COMMIT_NOT_FOUND", err)
		}

		// Blank source never reaches the port.
		port := &sequencerGitPort{}
		svc = NewGitService(port, nil, nil)
		if _, err := svc.CherryPick(ctx, repoID, "  ", false, false); !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeCherryPickFailed {
			t.Errorf("CherryPick(blank) err = %v, want CHERRY_PICK_FAILED", err)
		}
		if _, err := svc.Revert(ctx, repoID, "  "); !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeRevertFailed {
			t.Errorf("Revert(blank) err = %v, want REVERT_FAILED", err)
		}
		if _, err := svc.ResolveRevision(ctx, repoID, "  "); !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeCommitNotFound {
			t.Errorf("ResolveRevision(blank) err = %v, want COMMIT_NOT_FOUND", err)
		}
		if port.cherryPickCalls != 0 || port.revertCalls != 0 || port.resolveCalls != 0 {
			t.Errorf("port calls = %d/%d/%d, want 0/0/0", port.cherryPickCalls, port.revertCalls, port.resolveCalls)
		}
	})
}

// TestGitServiceSequencerBlankSourceContract pins the documented rejection
// token for a service-level unusable source: the guard still short-circuits
// before the port, but the error must carry reason=invalid-source with the same
// wording the adapter uses, so the renderer's reason switch behaves identically
// whichever layer rejects the source (ADR-0042 ordered validation).
func TestGitServiceSequencerBlankSourceContract(t *testing.T) {
	ctx := context.Background()
	const repoID = domain.RepositoryId("repo-1")

	port := &sequencerGitPort{}
	svc := NewGitService(port, nil, nil)

	cases := []struct {
		name    string
		source  string
		call    func(source string) error
		code    string
		message string
	}{
		{
			name:   "cherry-pick",
			source: "   ",
			call: func(source string) error {
				_, err := svc.CherryPick(ctx, repoID, source, false, false)
				return err
			},
			code:    domain.ErrCodeCherryPickFailed,
			message: "cherry-pick source is required",
		},
		{
			name:   "revert",
			source: "\t\n ",
			call: func(source string) error {
				_, err := svc.Revert(ctx, repoID, source)
				return err
			},
			code:    domain.ErrCodeRevertFailed,
			message: "revert source is required",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call(tc.source)
			var appErr domain.AppError
			if !errors.As(err, &appErr) {
				t.Fatalf("err = %v, want a typed AppError", err)
			}
			if appErr.Code != tc.code {
				t.Errorf("code = %q, want %q", appErr.Code, tc.code)
			}
			if appErr.Message != tc.message {
				t.Errorf("message = %q, want %q", appErr.Message, tc.message)
			}
			if got := appErr.Details["reason"]; got != "invalid-source" {
				t.Errorf("reason = %q, want %q", got, "invalid-source")
			}
		})
	}

	if port.cherryPickCalls != 0 || port.revertCalls != 0 {
		t.Errorf("port calls = %d/%d, want 0/0 (the guard must short-circuit)",
			port.cherryPickCalls, port.revertCalls)
	}
}

// TestGitServiceResolveRevisionReadOnly proves resolution is a pass-through
// read: no cache invalidation, no watcher event.
func TestGitServiceResolveRevisionReadOnly(t *testing.T) {
	ctx := context.Background()
	const repoID = domain.RepositoryId("repo-1")

	commit := &domain.Commit{Oid: domain.Oid{Hex: strings40("c")}}
	port := &sequencerGitPort{resolveRes: commit}
	cache := &stubCachePort{}
	watcher, sched, c := newSequencerWatcher()
	svc := NewGitService(port, cache, watcher)

	got, err := svc.ResolveRevision(ctx, repoID, "v1.0")
	if err != nil {
		t.Fatalf("ResolveRevision: %v", err)
	}
	if got != commit || port.gotRevision != "v1.0" {
		t.Errorf("result = %+v revision = %q, want the port's commit / v1.0", got, port.gotRevision)
	}
	if cache.invalidations != 0 {
		t.Errorf("invalidations = %d, want 0 (read-only)", cache.invalidations)
	}
	sched.fireAll()
	if events := c.snapshot(); len(events) != 0 {
		t.Errorf("watcher events = %d, want 0 (read-only)", len(events))
	}

	// Port errors pass through unchanged.
	port = &sequencerGitPort{resolveErr: domain.ErrCommitNotFound}
	svc = NewGitService(port, cache, nil)
	_, err = svc.ResolveRevision(ctx, repoID, "ghost")
	var appErr domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeCommitNotFound {
		t.Errorf("err = %v, want COMMIT_NOT_FOUND", err)
	}
}

// strings40 returns a 40-character hex-shaped fixture oid.
func strings40(c string) string {
	out := make([]byte, 40)
	for i := range out {
		out[i] = c[0]
	}
	return string(out)
}
