package git

import (
	"context"
	"testing"

	"github.com/SingulariTree/go-core/internal/domain"
)

// TestTagCreate covers lightweight, annotated and explicit-target tags plus
// the collision/force paths (ADR-028).
func TestTagCreate(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	head := gitRun(t, dir, "rev-parse", "HEAD")
	parent := gitRun(t, dir, "rev-parse", "HEAD~1")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	light, err := a.TagCreate(ctx, repoID, "light", "", false, "", false)
	if err != nil {
		t.Fatalf("TagCreate(lightweight): %v", err)
	}
	if light.Annotated {
		t.Errorf("light.Annotated = true, want false")
	}
	if light.Target.Hex != head {
		t.Errorf("light.Target = %s, want HEAD %s", light.Target.Hex, head)
	}
	if light.Message != nil || light.Tagger != nil {
		t.Errorf("lightweight tag = %+v, want no message/tagger", light)
	}

	ann, err := a.TagCreate(ctx, repoID, "release-1", "", true, "release one", false)
	if err != nil {
		t.Fatalf("TagCreate(annotated): %v", err)
	}
	if !ann.Annotated {
		t.Errorf("ann.Annotated = false, want true")
	}
	if ann.Message == nil || *ann.Message != "release one" {
		t.Errorf("ann.Message = %v, want release one", ann.Message)
	}
	if ann.Tagger == nil || ann.Tagger.Email != "alice@example.com" {
		t.Errorf("ann.Tagger = %+v, want Alice <alice@example.com>", ann.Tagger)
	}

	// Explicit target commits the tag on the parent commit.
	old, err := a.TagCreate(ctx, repoID, "old", parent, false, "", false)
	if err != nil {
		t.Fatalf("TagCreate(target): %v", err)
	}
	if old.Target.Hex != parent {
		t.Errorf("old.Target = %s, want %s", old.Target.Hex, parent)
	}
}

// TestTagCreateCollisionAndForce proves an existing tag yields TAG_EXISTS and
// that force moves it (maps to `git tag -f`).
func TestTagCreateCollisionAndForce(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	head := gitRun(t, dir, "rev-parse", "HEAD")
	parent := gitRun(t, dir, "rev-parse", "HEAD~1")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	if _, err := a.TagCreate(ctx, repoID, "v1", head, false, "", false); err != nil {
		t.Fatalf("TagCreate: %v", err)
	}
	_, err := a.TagCreate(ctx, repoID, "v1", head, false, "", false)
	assertAppCode(t, err, domain.ErrCodeTagExists)

	// Forced create moves the tag to the parent commit.
	moved, err := a.TagCreate(ctx, repoID, "v1", parent, false, "", true)
	if err != nil {
		t.Fatalf("TagCreate(force): %v", err)
	}
	if moved.Target.Hex != parent {
		t.Errorf("forced tag target = %s, want %s", moved.Target.Hex, parent)
	}

	// Invalid names are rejected.
	if _, err := a.TagCreate(ctx, repoID, "-bad", "", false, "", false); err == nil {
		t.Fatal("TagCreate(-bad) succeeded, want error")
	} else {
		assertAppCode(t, err, domain.ErrCodeTagNotFound)
	}
}

// TestTagDelete covers a successful delete and the missing-tag path.
func TestTagDelete(t *testing.T) {
	dir := initRepo(t)
	gitRun(t, dir, "branch", "-M", "main")
	gitRun(t, dir, "tag", "v1")

	a := NewAdapter(&fakeRepoPort{fsPath: dir})
	ctx := context.Background()
	repoID := domain.RepositoryId("repo-1")

	if err := a.TagDelete(ctx, repoID, domain.RefName{Raw: "v1"}); err != nil {
		t.Fatalf("TagDelete: %v", err)
	}
	if got := gitRun(t, dir, "tag", "-l", "v1"); got != "" {
		t.Errorf("tag v1 still present: %q", got)
	}

	err := a.TagDelete(ctx, repoID, domain.RefName{Raw: "refs/tags/v1"})
	assertAppCode(t, err, domain.ErrCodeTagNotFound)
}
