package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// gitflowGitPort records the ordered Git operations a GitFlowService performs.
// The embedded interface satisfies the remaining GitPort methods.
type gitflowGitPort struct {
	domain.GitPort

	calls []string

	mergeResult *domain.MergeResult
	mergeErr    error
}

func (p *gitflowGitPort) Checkout(_ context.Context, _ domain.RepositoryId, ref domain.RefName, _, _ bool) error {
	p.calls = append(p.calls, "checkout "+ref.Raw)
	return nil
}
func (p *gitflowGitPort) BranchCreate(_ context.Context, _ domain.RepositoryId, name, startPoint string, checkout bool) (*domain.Branch, error) {
	suffix := ""
	if checkout {
		suffix = " (checkout)"
	}
	p.calls = append(p.calls, "branch "+name+" off "+startPoint+suffix)
	return &domain.Branch{Name: name}, nil
}
func (p *gitflowGitPort) Merge(_ context.Context, _ domain.RepositoryId, ref string, strategy domain.MergeStrategy, _ bool, _ string) (*domain.MergeResult, error) {
	p.calls = append(p.calls, "merge "+ref)
	if p.mergeErr != nil {
		return p.mergeResult, p.mergeErr
	}
	return &domain.MergeResult{}, nil
}
func (p *gitflowGitPort) TagCreate(_ context.Context, _ domain.RepositoryId, name, _ string, _ bool, _ string, _ bool) (*domain.Tag, error) {
	p.calls = append(p.calls, "tag "+name)
	return &domain.Tag{Name: name}, nil
}
func (p *gitflowGitPort) BranchDelete(_ context.Context, _ domain.RepositoryId, ref domain.RefName, _ bool) error {
	p.calls = append(p.calls, "delete "+ref.Raw)
	return nil
}

// fakeGitFlowConfig implements domain.GitFlowConfigPort in memory.
type fakeGitFlowConfig struct {
	stored map[domain.RepositoryId]domain.GitFlowConfig
	gets   int
	sets   int
}

func (f *fakeGitFlowConfig) Get(_ context.Context, repoID domain.RepositoryId) (domain.GitFlowConfig, error) {
	f.gets++
	if f.stored == nil {
		return domain.DefaultGitFlowConfig(), nil
	}
	cfg, ok := f.stored[repoID]
	if !ok {
		return domain.DefaultGitFlowConfig(), nil
	}
	return cfg, nil
}
func (f *fakeGitFlowConfig) Set(_ context.Context, repoID domain.RepositoryId, cfg domain.GitFlowConfig) error {
	f.sets++
	if f.stored == nil {
		f.stored = map[domain.RepositoryId]domain.GitFlowConfig{}
	}
	f.stored[repoID] = cfg
	return nil
}

func lastCall(p *gitflowGitPort) string {
	if len(p.calls) == 0 {
		return ""
	}
	return p.calls[len(p.calls)-1]
}

// TestGitFlowStartSequences covers the start sequences for each kind, prefix
// stripping, and the rejection of unspecified kind / empty name.
func TestGitFlowStartSequences(t *testing.T) {
	ctx := context.Background()
	cfgPort := &fakeGitFlowConfig{}

	cases := []struct {
		kind       domain.GitFlowKind
		name       string
		base       string
		wantBase   string
		wantBranch string
	}{
		{domain.GitFlowKindFeature, "login", "", "develop", "feature/login"},
		{domain.GitFlowKindFeature, "feature/login", "", "develop", "feature/login"}, // prefix stripped
		{domain.GitFlowKindFeature, "auth", "main", "main", "feature/auth"},          // base override
		{domain.GitFlowKindRelease, "1.0", "", "develop", "release/1.0"},
		{domain.GitFlowKindHotfix, "1.0.1", "", "main", "hotfix/1.0.1"},
	}
	for _, tc := range cases {
		port := &gitflowGitPort{}
		svc := NewGitFlowService(port, cfgPort)
		res, err := svc.Start(ctx, "repo-1", tc.kind, tc.name, tc.base)
		if err != nil {
			t.Fatalf("Start(%v,%q): %v", tc.kind, tc.name, err)
		}
		if res.Branch != tc.wantBranch {
			t.Errorf("Start(%q).Branch = %q, want %q", tc.name, res.Branch, tc.wantBranch)
		}
		wantFirst := "checkout " + tc.wantBase
		if len(port.calls) < 2 || port.calls[0] != wantFirst {
			t.Errorf("Start(%q) calls = %v, want first %q", tc.name, port.calls, wantFirst)
		}
		if !strings.Contains(lastCall(port), "branch "+tc.wantBranch+" off "+tc.wantBase) {
			t.Errorf("Start(%q) last call = %q, want branch off %q", tc.name, lastCall(port), tc.wantBase)
		}
	}

	// Unspecified kind and empty name are rejected before any Git call.
	port := &gitflowGitPort{}
	svc := NewGitFlowService(port, cfgPort)
	if _, err := svc.Start(ctx, "repo-1", domain.GitFlowKindUnspecified, "x", ""); err == nil {
		t.Error("Start(unspecified) succeeded, want error")
	}
	if _, err := svc.Start(ctx, "repo-1", domain.GitFlowKindFeature, "  ", ""); err == nil {
		t.Error("Start(empty name) succeeded, want error")
	}
	var appErr domain.AppError
	if _, err := svc.Start(ctx, "repo-1", domain.GitFlowKindUnspecified, "x", ""); !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeGitFlowFailed {
		t.Errorf("Start(unspecified) error = %v, want GIT_FLOW_FAILED", err)
	}
	if len(port.calls) != 0 {
		t.Errorf("git calls = %v, want none on validation failure", port.calls)
	}
}

// TestGitFlowFinishFeature covers checkout develop, no-ff merge, delete.
func TestGitFlowFinishFeature(t *testing.T) {
	port := &gitflowGitPort{}
	svc := NewGitFlowService(port, &fakeGitFlowConfig{})

	res, err := svc.Finish(context.Background(), "repo-1", domain.GitFlowKindFeature, "feature/login", true)
	if err != nil {
		t.Fatalf("Finish(feature): %v", err)
	}
	if res.HasConflict {
		t.Errorf("HasConflict = true, want false")
	}
	want := []string{"checkout develop", "merge feature/login", "delete feature/login"}
	if strings.Join(port.calls, "|") != strings.Join(want, "|") {
		t.Errorf("calls = %v, want %v", port.calls, want)
	}
}

// TestGitFlowFinishRelease covers the full main/Tag/develop sequence.
func TestGitFlowFinishRelease(t *testing.T) {
	port := &gitflowGitPort{}
	svc := NewGitFlowService(port, &fakeGitFlowConfig{})

	res, err := svc.Finish(context.Background(), "repo-1", domain.GitFlowKindRelease, "1.0", true)
	if err != nil {
		t.Fatalf("Finish(release): %v", err)
	}
	if res.Branch != "release/1.0" {
		t.Errorf("Branch = %q, want release/1.0", res.Branch)
	}
	want := []string{
		"checkout main",
		"merge release/1.0",
		"tag v1.0",
		"checkout develop",
		"merge release/1.0",
		"delete release/1.0",
	}
	if strings.Join(port.calls, "|") != strings.Join(want, "|") {
		t.Errorf("calls = %v, want %v", port.calls, want)
	}
}

// TestGitFlowFinishHotfixSameShapeAsRelease proves hotfix mirrors release.
func TestGitFlowFinishHotfixSameShapeAsRelease(t *testing.T) {
	port := &gitflowGitPort{}
	svc := NewGitFlowService(port, &fakeGitFlowConfig{})

	if _, err := svc.Finish(context.Background(), "repo-1", domain.GitFlowKindHotfix, "1.0.1", true); err != nil {
		t.Fatalf("Finish(hotfix): %v", err)
	}
	want := []string{
		"checkout main",
		"merge hotfix/1.0.1",
		"tag v1.0.1",
		"checkout develop",
		"merge hotfix/1.0.1",
		"delete hotfix/1.0.1",
	}
	if strings.Join(port.calls, "|") != strings.Join(want, "|") {
		t.Errorf("calls = %v, want %v", port.calls, want)
	}
}

// TestGitFlowFinishConflictStops proves a conflict stops the sequence, leaves
// the tree conflicted and surfaces MERGE_CONFLICT with HasConflict.
func TestGitFlowFinishConflictStops(t *testing.T) {
	port := &gitflowGitPort{
		mergeResult: &domain.MergeResult{HasConflict: true},
		mergeErr:    domain.ErrMergeConflict,
	}
	svc := NewGitFlowService(port, &fakeGitFlowConfig{})

	res, err := svc.Finish(context.Background(), "repo-1", domain.GitFlowKindRelease, "1.0", true)
	var appErr domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeMergeConflict {
		t.Fatalf("err = %v, want MERGE_CONFLICT", err)
	}
	if res == nil || !res.HasConflict {
		t.Fatalf("result = %+v, want HasConflict", res)
	}
	// The sequence stops at the first merge: no tag, no develop merge, no delete.
	want := []string{"checkout main", "merge release/1.0"}
	if strings.Join(port.calls, "|") != strings.Join(want, "|") {
		t.Errorf("calls = %v, want %v (stop on conflict)", port.calls, want)
	}
}

// TestGitFlowConfigDefaultsAndNormalization covers nil config port defaults and
// empty-field normalization on set.
func TestGitFlowConfigDefaultsAndNormalization(t *testing.T) {
	ctx := context.Background()

	// nil config port -> defaults.
	svc := NewGitFlowService(&gitflowGitPort{}, nil)
	cfg, err := svc.Config(ctx, "repo-1")
	if err != nil {
		t.Fatalf("Config(nil port): %v", err)
	}
	if cfg != domain.DefaultGitFlowConfig() {
		t.Errorf("defaults = %+v", cfg)
	}

	// Partial set fills empty fields from defaults.
	port := &fakeGitFlowConfig{}
	svc = NewGitFlowService(&gitflowGitPort{}, port)
	got, err := svc.SetConfig(ctx, "repo-1", domain.GitFlowConfig{MainBranch: "trunk", VersionTagPrefix: "v"})
	if err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	if got.MainBranch != "trunk" || got.DevelopBranch != "develop" || got.FeaturePrefix != "feature/" {
		t.Errorf("normalized = %+v", got)
	}
	if port.sets != 1 {
		t.Errorf("config sets = %d, want 1", port.sets)
	}

	// A custom prefix is honoured on start.
	port2 := &fakeGitFlowConfig{}
	port2.Set(ctx, "repo-2", domain.GitFlowConfig{
		MainBranch: "main", DevelopBranch: "develop",
		FeaturePrefix: "feat/", ReleasePrefix: "rel/", HotfixPrefix: "fix/", VersionTagPrefix: "v",
	})
	gitPort := &gitflowGitPort{}
	svc = NewGitFlowService(gitPort, port2)
	res, err := svc.Start(ctx, "repo-2", domain.GitFlowKindFeature, "login", "")
	if err != nil {
		t.Fatalf("Start(custom prefix): %v", err)
	}
	if res.Branch != "feat/login" {
		t.Errorf("Branch = %q, want feat/login", res.Branch)
	}
}
