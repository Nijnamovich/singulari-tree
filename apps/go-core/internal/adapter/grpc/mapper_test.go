package grpc

import (
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc/codes"

	singularitreev1 "github.com/SingulariTree/go-core/gen/go/singularitree/v1"
	"github.com/SingulariTree/go-core/internal/domain"
)

func TestCommitToProtoMapsRefs(t *testing.T) {
	c := domain.Commit{
		Oid: domain.Oid{Hex: strings.Repeat("a", 40), Kind: "SHA1"},
		Refs: []domain.RefLabel{
			{Name: "HEAD", Kind: domain.RefKindHead},
			{Name: "main", Kind: domain.RefKindBranch},
			{Name: "origin/main", Kind: domain.RefKindRemote},
			{Name: "v1.0.0", Kind: domain.RefKindTag},
		},
	}
	got := commitToProto(c)
	refs := got.GetRefs()
	if len(refs) != 4 {
		t.Fatalf("refs len = %d, want 4", len(refs))
	}
	want := []struct{ name, kind string }{
		{"HEAD", "head"},
		{"main", "branch"},
		{"origin/main", "remote"},
		{"v1.0.0", "tag"},
	}
	for i, w := range want {
		if refs[i].GetName() != w.name || refs[i].GetKind() != w.kind {
			t.Errorf("refs[%d] = {%q,%q}, want {%q,%q}", i, refs[i].GetName(), refs[i].GetKind(), w.name, w.kind)
		}
	}
	if got.GetOid().GetHex() != c.Oid.Hex {
		t.Errorf("oid = %q, want %q", got.GetOid().GetHex(), c.Oid.Hex)
	}
}

func TestCommitToProtoNoRefs(t *testing.T) {
	got := commitToProto(domain.Commit{Oid: domain.Oid{Hex: strings.Repeat("b", 40), Kind: "SHA1"}})
	if len(got.GetRefs()) != 0 {
		t.Fatalf("refs len = %d, want 0", len(got.GetRefs()))
	}
}

func TestLaneToProto(t *testing.T) {
	got := laneToProto(domain.Lane{Index: 3, Color: 2, Continues: true})
	if got.GetIndex() != 3 || got.GetColor() != 2 || !got.GetContinues() {
		t.Fatalf("laneToProto = {index:%d color:%d continues:%v}, want {3 2 true}",
			got.GetIndex(), got.GetColor(), got.GetContinues())
	}
}

func TestBranchToProto(t *testing.T) {
	up := domain.RefName{Raw: "refs/remotes/origin/main"}
	got := branchToProto(domain.Branch{
		Name:      "main",
		RefName:   domain.RefName{Raw: "refs/heads/main"},
		Tip:       domain.Oid{Hex: strings.Repeat("a", 40), Kind: "SHA1"},
		Upstream:  &up,
		IsCurrent: true,
		Behind:    4,
	})
	if got.GetName() != "main" || got.GetRefName() != "refs/heads/main" {
		t.Errorf("branch = %+v, want main/refs/heads/main", got)
	}
	if !got.GetIsCurrent() || got.GetIsRemote() {
		t.Errorf("flags = current:%v remote:%v, want true/false", got.GetIsCurrent(), got.GetIsRemote())
	}
	if got.GetTip().GetHex() != strings.Repeat("a", 40) {
		t.Errorf("tip = %q", got.GetTip().GetHex())
	}
	if got.GetUpstream() != "refs/remotes/origin/main" {
		t.Errorf("upstream = %q", got.GetUpstream())
	}
	if got.GetBehind() != 4 {
		t.Errorf("behind = %d, want 4", got.GetBehind())
	}
}

func TestBranchToProtoNoOptional(t *testing.T) {
	got := branchToProto(domain.Branch{Name: "dev", RefName: domain.RefName{Raw: "refs/heads/dev"}})
	if got.GetTip() != nil {
		t.Errorf("tip = %+v, want nil for unset oid", got.GetTip())
	}
	if got.GetUpstream() != "" {
		t.Errorf("upstream = %q, want empty", got.GetUpstream())
	}
	if got.GetBehind() != 0 {
		t.Errorf("behind = %d, want 0", got.GetBehind())
	}
}

func TestRemoteToProto(t *testing.T) {
	got := remoteToProto(domain.Remote{
		Name:       "origin",
		Urls:       []string{"https://example.com/repo.git"},
		FetchSpecs: []string{"+refs/heads/*:refs/remotes/origin/*"},
	})
	if got.GetName() != "origin" || len(got.GetUrls()) != 1 || len(got.GetFetchSpecs()) != 1 {
		t.Fatalf("remoteToProto = %+v, want origin with url + fetch spec", got)
	}
}

func TestRemoteToProtoEmptySlices(t *testing.T) {
	got := remoteToProto(domain.Remote{Name: "origin"})
	if got.GetUrls() == nil || got.GetFetchSpecs() == nil {
		t.Errorf("empty remote slices should be non-nil, got urls=%v fetch=%v", got.GetUrls(), got.GetFetchSpecs())
	}
}

func TestTagToProto(t *testing.T) {
	msg := "release one"
	when := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	got := tagToProto(domain.Tag{
		Name:      "v1.0.0",
		RefName:   domain.RefName{Raw: "refs/tags/v1.0.0"},
		Target:    domain.Oid{Hex: strings.Repeat("c", 40), Kind: "SHA1"},
		Tagger:    &domain.Signature{Name: "Alice", Email: "alice@example.com", When: when},
		Message:   &msg,
		Annotated: true,
	})
	if got.GetName() != "v1.0.0" || !got.GetAnnotated() {
		t.Errorf("tag = %+v, want v1.0.0 annotated", got)
	}
	if got.GetTarget().GetHex() != strings.Repeat("c", 40) {
		t.Errorf("target = %q", got.GetTarget().GetHex())
	}
	if got.GetTagger().GetEmail() != "alice@example.com" {
		t.Errorf("tagger email = %q", got.GetTagger().GetEmail())
	}
	if got.GetMessage() != "release one" {
		t.Errorf("message = %q", got.GetMessage())
	}
}

func TestTagToProtoLightweight(t *testing.T) {
	got := tagToProto(domain.Tag{
		Name:    "light",
		RefName: domain.RefName{Raw: "refs/tags/light"},
	})
	if got.GetTagger() != nil || got.GetMessage() != "" {
		t.Errorf("lightweight tag should have no tagger/message, got %+v", got)
	}
	if got.GetTarget() != nil {
		t.Errorf("target = %+v, want nil for unset oid", got.GetTarget())
	}
}

func TestStashToProto(t *testing.T) {
	branch := "main"
	got := stashToProto(&domain.Stash{
		Index:      2,
		Oid:        domain.Oid{Hex: strings.Repeat("d", 40), Kind: "SHA1"},
		Message:    "wip",
		BranchName: &branch,
	})
	if got.GetIndex() != 2 || got.GetMessage() != "wip" || got.GetBranchName() != "main" {
		t.Errorf("stashToProto = %+v, want {index:2 message:wip branch:main}", got)
	}
	if got.GetOid().GetHex() != strings.Repeat("d", 40) {
		t.Errorf("oid = %q, want the mapped stash oid", got.GetOid().GetHex())
	}
}

func TestStashToProtoNoOptional(t *testing.T) {
	got := stashToProto(&domain.Stash{Message: "wip"})
	if got.GetOid() != nil {
		t.Errorf("oid = %+v, want nil for unset oid", got.GetOid())
	}
	if got.GetBranchName() != "" {
		t.Errorf("branch = %q, want empty for nil BranchName", got.GetBranchName())
	}
	if stashToProto(nil) != nil {
		t.Error("stashToProto(nil) = non-nil, want nil")
	}
}

func TestGRPCCodeForStashFailed(t *testing.T) {
	if got := grpcCodeFor(domain.ErrCodeStashFailed); got != codes.InvalidArgument {
		t.Errorf("grpcCodeFor(%s) = %v, want InvalidArgument", domain.ErrCodeStashFailed, got)
	}
}

// TestGRPCCodeForSequencer pins the cherry-pick/revert mapping (ADR-0042).
func TestGRPCCodeForSequencer(t *testing.T) {
	cases := []struct {
		code string
		want codes.Code
	}{
		{domain.ErrCodeCherryPickConflict, codes.FailedPrecondition},
		{domain.ErrCodeRevertConflict, codes.FailedPrecondition},
		{domain.ErrCodeCherryPickFailed, codes.Aborted},
		{domain.ErrCodeRevertFailed, codes.Aborted},
	}
	for _, tc := range cases {
		if got := grpcCodeFor(tc.code); got != tc.want {
			t.Errorf("grpcCodeFor(%s) = %v, want %v", tc.code, got, tc.want)
		}
	}
}

func TestFileStatusToProto(t *testing.T) {
	got := fileStatusToProto(domain.FileStatus{
		Path:         "src/main.go",
		Staged:       "M",
		Unstaged:     "M",
		IsStaged:     true,
		IsConflicted: true,
	})
	if got.GetPath() != "src/main.go" || got.GetStaged() != "M" || got.GetUnstaged() != "M" {
		t.Errorf("fileStatusToProto = %+v, want path/staged/unstaged carried through", got)
	}
	if !got.GetIsStaged() || !got.GetIsConflicted() {
		t.Errorf("flags = staged:%v conflicted:%v, want true/true", got.GetIsStaged(), got.GetIsConflicted())
	}
}

func TestDiffLineToProto(t *testing.T) {
	got := diffLineToProto(domain.DiffLine{Kind: "added", Text: "+hello", NoNewline: true})
	if got.GetKind() != "added" || got.GetText() != "+hello" || !got.GetNoNewline() {
		t.Errorf("diffLineToProto = %+v, want {added +hello true}", got)
	}
}

func TestHunkToProto(t *testing.T) {
	got := hunkToProto(domain.Hunk{
		FromStart: 1,
		FromLines: 3,
		ToStart:   1,
		ToLines:   4,
		Lines: []domain.DiffLine{
			{Kind: "context", Text: " same"},
			{Kind: "removed", Text: "-old"},
			{Kind: "added", Text: "+new"},
		},
	})
	if got.GetFromStart() != 1 || got.GetFromLines() != 3 || got.GetToStart() != 1 || got.GetToLines() != 4 {
		t.Errorf("hunk header = {%d,%d,%d,%d}, want {1,3,1,4}",
			got.GetFromStart(), got.GetFromLines(), got.GetToStart(), got.GetToLines())
	}
	if len(got.GetLines()) != 3 {
		t.Fatalf("lines len = %d, want 3", len(got.GetLines()))
	}
	if got.GetLines()[1].GetKind() != "removed" || got.GetLines()[2].GetKind() != "added" {
		t.Errorf("line kinds = %q/%q, want removed/added",
			got.GetLines()[1].GetKind(), got.GetLines()[2].GetKind())
	}
}

func TestHunkToProtoEmptyLinesNonNil(t *testing.T) {
	got := hunkToProto(domain.Hunk{FromStart: 0, FromLines: 0, ToStart: 0, ToLines: 0})
	if got.GetLines() == nil {
		t.Error("empty hunk lines should be non-nil, got nil")
	}
}

func TestDiffToProtoMapsMetaAndOids(t *testing.T) {
	from := strings.Repeat("a", 40)
	to := strings.Repeat("b", 40)
	got := diffToProto(&domain.Diff{
		From:               domain.Oid{Hex: from, Kind: "SHA1"},
		To:                 domain.Oid{Hex: to, Kind: "SHA1"},
		Additions:          5,
		Deletions:          2,
		IsBinary:           true,
		HasConflictMarkers: true,
		Hunks: []domain.Hunk{
			{FromStart: 1, FromLines: 1, ToStart: 1, ToLines: 1,
				Lines: []domain.DiffLine{{Kind: "added", Text: "+x"}}},
		},
	})
	if got.GetFrom().GetHex() != from || got.GetTo().GetHex() != to {
		t.Errorf("oids = %q/%q, want %q/%q", got.GetFrom().GetHex(), got.GetTo().GetHex(), from, to)
	}
	if got.GetFrom().GetKind() != "SHA1" {
		t.Errorf("from kind = %q, want SHA1", got.GetFrom().GetKind())
	}
	if got.GetAdditions() != 5 || got.GetDeletions() != 2 {
		t.Errorf("counts = +%d/-%d, want +5/-2", got.GetAdditions(), got.GetDeletions())
	}
	if !got.GetIsBinary() || !got.GetHasConflictMarkers() {
		t.Errorf("flags = binary:%v conflict:%v, want true/true", got.GetIsBinary(), got.GetHasConflictMarkers())
	}
	if len(got.GetHunks()) != 1 || len(got.GetHunks()[0].GetLines()) != 1 {
		t.Fatalf("hunks = %+v, want one hunk with one line", got.GetHunks())
	}
}

func TestDiffToProtoOmitsZeroOids(t *testing.T) {
	got := diffToProto(&domain.Diff{})
	if got.GetFrom() != nil || got.GetTo() != nil {
		t.Errorf("zero oids should stay unset, got from=%+v to=%+v", got.GetFrom(), got.GetTo())
	}
	if got.GetHunks() == nil {
		t.Error("hunks should be non-nil, got nil")
	}
	if diffToProto(nil) != nil {
		t.Error("diffToProto(nil) = non-nil, want nil")
	}
}

// TestDiffToProtoMapsFilesAndTruncated proves the per-file sections and the
// truncated flag survive the wire mapping (ADR-0020).
func TestDiffToProtoMapsFilesAndTruncated(t *testing.T) {
	got := diffToProto(&domain.Diff{
		Truncated: true,
		Files: []domain.FileDiff{{
			Path:               "a.txt",
			OldPath:            "old.txt",
			Status:             "R",
			Additions:          1,
			Deletions:          2,
			IsBinary:           true,
			HasConflictMarkers: true,
			Hunks: []domain.Hunk{{FromStart: 1, FromLines: 1, ToStart: 1, ToLines: 1,
				Lines: []domain.DiffLine{{Kind: "added", Text: "x"}}}},
		}},
	})
	if !got.GetTruncated() {
		t.Error("Truncated = false, want true")
	}
	files := got.GetFiles()
	if len(files) != 1 {
		t.Fatalf("files = %+v, want 1", files)
	}
	f := files[0]
	if f.GetPath() != "a.txt" || f.GetOldPath() != "old.txt" || f.GetStatus() != "R" {
		t.Errorf("file path/old/status = %q/%q/%q, want a.txt/old.txt/R", f.GetPath(), f.GetOldPath(), f.GetStatus())
	}
	if f.GetAdditions() != 1 || f.GetDeletions() != 2 || !f.GetIsBinary() || !f.GetHasConflictMarkers() {
		t.Errorf("file counts/flags = %+v", f)
	}
	if len(f.GetHunks()) != 1 || len(f.GetHunks()[0].GetLines()) != 1 {
		t.Errorf("file hunks = %+v, want one hunk with one line", f.GetHunks())
	}
}

// TestCommitStatsToProto proves the change-size gauge maps to the wire form.
func TestCommitStatsToProto(t *testing.T) {
	got := commitStatsToProto(domain.CommitStats{Oid: "abc", Additions: 1, Deletions: 2, FilesChanged: 3})
	if got.GetOid() != "abc" || got.GetAdditions() != 1 || got.GetDeletions() != 2 || got.GetFilesChanged() != 3 {
		t.Errorf("commitStatsToProto = %+v", got)
	}
}

// TestResetModeToDomain proves the reset mode mapping rejects unspecified.
func TestResetModeToDomain(t *testing.T) {
	cases := []struct {
		in   singularitreev1.ResetMode
		want domain.ResetMode
		ok   bool
	}{
		{singularitreev1.ResetMode_SOFT, domain.ResetModeSoft, true},
		{singularitreev1.ResetMode_MIXED, domain.ResetModeMixed, true},
		{singularitreev1.ResetMode_HARD, domain.ResetModeHard, true},
		{singularitreev1.ResetMode_RESET_MODE_UNSPECIFIED, domain.ResetModeUnspecified, false},
	}
	for _, tc := range cases {
		got, ok := resetModeToDomain(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("resetModeToDomain(%v) = (%v, %v), want (%v, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}
