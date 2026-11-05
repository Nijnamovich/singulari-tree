package grpc

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	googlegrpc "google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	singularitreev1 "github.com/SingulariTree/go-core/gen/go/singularitree/v1"
	"github.com/SingulariTree/go-core/internal/domain"
)

// appErrorTrailerKey carries the domain error code alongside the gRPC status
// (ipc-strategy.md §2.5).
const appErrorTrailerKey = "x-app-error-code"

// appErrorDetailsTrailerKey carries AppError.Details (structured fields only)
// as a JSON object. Secrets/tokens are never placed here
// (github-real-data-guide.md §12e).
const appErrorDetailsTrailerKey = "x-app-error-details"

func oidToProto(o domain.Oid) *singularitreev1.Oid {
	return &singularitreev1.Oid{Hex: o.Hex, Kind: o.Kind}
}

func signatureToProto(s domain.Signature) *singularitreev1.Signature {
	return &singularitreev1.Signature{
		Name:  s.Name,
		Email: s.Email,
		When:  s.When.Format(time.RFC3339),
	}
}

func refLabelToProto(r domain.RefLabel) *singularitreev1.RefLabel {
	return &singularitreev1.RefLabel{Name: r.Name, Kind: r.Kind}
}

func commitToProto(c domain.Commit) *singularitreev1.Commit {
	parents := make([]*singularitreev1.Oid, 0, len(c.Parents))
	for _, p := range c.Parents {
		parents = append(parents, oidToProto(p))
	}
	refs := make([]*singularitreev1.RefLabel, 0, len(c.Refs))
	for _, r := range c.Refs {
		refs = append(refs, refLabelToProto(r))
	}
	return &singularitreev1.Commit{
		Oid:         oidToProto(c.Oid),
		Parents:     parents,
		Author:      signatureToProto(c.Author),
		Committer:   signatureToProto(c.Committer),
		Message:     c.Message,
		TreeOid:     oidToProto(c.TreeOid),
		CommittedAt: c.CommittedAt.Format(time.RFC3339),
		Refs:        refs,
	}
}

// laneToProto maps a domain lane to its wire form. Index/Color are range-safe
// (lane indices are bounded by the number of active graph columns).
func laneToProto(l domain.Lane) *singularitreev1.Lane {
	return &singularitreev1.Lane{
		Index:     int32(l.Index),
		Color:     int32(l.Color),
		Continues: l.Continues,
	}
}

// branchToProto maps a domain branch to its wire form. The tip is omitted when
// unset so the optional Oid field stays absent.
func branchToProto(b domain.Branch) *singularitreev1.Branch {
	out := &singularitreev1.Branch{
		Name:      b.Name,
		RefName:   b.RefName.Raw,
		IsCurrent: b.IsCurrent,
		IsRemote:  b.IsRemote,
		Behind:    b.Behind,
	}
	if b.Tip.Hex != "" {
		out.Tip = oidToProto(b.Tip)
	}
	if b.Upstream != nil {
		out.Upstream = b.Upstream.Raw
	}
	return out
}

// remoteToProto maps a domain remote to its wire form. Slices are always
// non-nil so an empty remote serializes as an empty repeated field.
func remoteToProto(r domain.Remote) *singularitreev1.Remote {
	urls := make([]string, 0, len(r.Urls))
	urls = append(urls, r.Urls...)
	fetchSpecs := make([]string, 0, len(r.FetchSpecs))
	fetchSpecs = append(fetchSpecs, r.FetchSpecs...)
	return &singularitreev1.Remote{
		Name:       r.Name,
		Urls:       urls,
		FetchSpecs: fetchSpecs,
	}
}

// progressToProto maps a streaming remote-operation progress chunk to its wire
// form. Percent is in 0..100 and Message is the git progress line.
func progressToProto(p domain.Progress) *singularitreev1.Progress {
	return &singularitreev1.Progress{Percent: p.Percent, Message: p.Message}
}

// tagToProto maps a domain tag to its wire form. Tagger and message are
// optional and only set for annotated tags.
func tagToProto(t domain.Tag) *singularitreev1.Tag {
	out := &singularitreev1.Tag{
		Name:      t.Name,
		RefName:   t.RefName.Raw,
		Annotated: t.Annotated,
	}
	if t.Target.Hex != "" {
		out.Target = oidToProto(t.Target)
	}
	if t.Tagger != nil {
		out.Tagger = signatureToProto(*t.Tagger)
	}
	if t.Message != nil {
		out.Message = *t.Message
	}
	return out
}

// stashToProto maps a domain stash entry to its wire form. The oid is omitted
// when unset so the optional field stays absent; branch_name is empty when the
// stash was created on a detached HEAD.
func stashToProto(s *domain.Stash) *singularitreev1.Stash {
	if s == nil {
		return nil
	}
	out := &singularitreev1.Stash{
		Index:   int32(s.Index),
		Message: s.Message,
	}
	if s.Oid.Hex != "" {
		out.Oid = oidToProto(s.Oid)
	}
	if s.BranchName != nil {
		out.BranchName = *s.BranchName
	}
	return out
}

func repositoryToProto(r *domain.Repository) *singularitreev1.Repository {
	if r == nil {
		return nil
	}
	return &singularitreev1.Repository{
		Id:           string(r.ID),
		FsPath:       r.FsPath,
		CommonDir:    r.CommonDir,
		Name:         r.Name,
		CreatedAt:    r.CreatedAt.Format(time.RFC3339),
		LastOpenedAt: r.LastOpenedAt.Format(time.RFC3339),
	}
}

func fileStatusToProto(f domain.FileStatus) *singularitreev1.FileStatus {
	return &singularitreev1.FileStatus{
		Path:         f.Path,
		Staged:       f.Staged,
		Unstaged:     f.Unstaged,
		IsStaged:     f.IsStaged,
		IsConflicted: f.IsConflicted,
	}
}

// diffLineToProto maps a single diff line to its wire form. Kind is preserved
// verbatim ("added" | "removed" | "context").
func diffLineToProto(l domain.DiffLine) *singularitreev1.DiffLine {
	return &singularitreev1.DiffLine{
		Kind:      l.Kind,
		Text:      l.Text,
		NoNewline: l.NoNewline,
	}
}

// hunkToProto maps a diff hunk to its wire form. Lines is always non-nil so an
// empty hunk serializes as an empty repeated field.
func hunkToProto(h domain.Hunk) *singularitreev1.Hunk {
	lines := make([]*singularitreev1.DiffLine, 0, len(h.Lines))
	for i := range h.Lines {
		lines = append(lines, diffLineToProto(h.Lines[i]))
	}
	return &singularitreev1.Hunk{
		FromStart: int32(h.FromStart),
		FromLines: int32(h.FromLines),
		ToStart:   int32(h.ToStart),
		ToLines:   int32(h.ToLines),
		Lines:     lines,
	}
}

// fileDiffToProto maps a per-file diff section to its wire form (ADR-0020).
func fileDiffToProto(f domain.FileDiff) *singularitreev1.FileDiff {
	hunks := make([]*singularitreev1.Hunk, 0, len(f.Hunks))
	for i := range f.Hunks {
		hunks = append(hunks, hunkToProto(f.Hunks[i]))
	}
	return &singularitreev1.FileDiff{
		Path:               f.Path,
		OldPath:            f.OldPath,
		Status:             f.Status,
		Hunks:              hunks,
		Additions:          int32(f.Additions),
		Deletions:          int32(f.Deletions),
		IsBinary:           f.IsBinary,
		HasConflictMarkers: f.HasConflictMarkers,
	}
}

// commitStatsToProto maps a domain CommitStats to its wire form (ADR-0023).
func commitStatsToProto(s domain.CommitStats) *singularitreev1.CommitStats {
	return &singularitreev1.CommitStats{
		Oid:          s.Oid,
		Additions:    int32(s.Additions),
		Deletions:    int32(s.Deletions),
		FilesChanged: int32(s.FilesChanged),
	}
}

// gitFlowConfigToProto maps a domain git-flow config to its wire form (ADR-027).
func gitFlowConfigToProto(c domain.GitFlowConfig) *singularitreev1.GitFlowConfig {
	return &singularitreev1.GitFlowConfig{
		MainBranch:       c.MainBranch,
		DevelopBranch:    c.DevelopBranch,
		FeaturePrefix:    c.FeaturePrefix,
		ReleasePrefix:    c.ReleasePrefix,
		HotfixPrefix:     c.HotfixPrefix,
		VersionTagPrefix: c.VersionTagPrefix,
	}
}

// gitFlowConfigToDomain maps a wire git-flow config to its domain form; a nil
// message yields the zero config so the service applies defaults.
func gitFlowConfigToDomain(c *singularitreev1.GitFlowConfig) domain.GitFlowConfig {
	if c == nil {
		return domain.GitFlowConfig{}
	}
	return domain.GitFlowConfig{
		MainBranch:       c.GetMainBranch(),
		DevelopBranch:    c.GetDevelopBranch(),
		FeaturePrefix:    c.GetFeaturePrefix(),
		ReleasePrefix:    c.GetReleasePrefix(),
		HotfixPrefix:     c.GetHotfixPrefix(),
		VersionTagPrefix: c.GetVersionTagPrefix(),
	}
}

// gitFlowKindToDomain maps the wire git-flow kind to its domain value. The zero
// (unspecified) value is preserved and rejected by the service.
func gitFlowKindToDomain(k singularitreev1.GitFlowKind) domain.GitFlowKind {
	switch k {
	case singularitreev1.GitFlowKind_FEATURE:
		return domain.GitFlowKindFeature
	case singularitreev1.GitFlowKind_RELEASE:
		return domain.GitFlowKindRelease
	case singularitreev1.GitFlowKind_HOTFIX:
		return domain.GitFlowKindHotfix
	default:
		return domain.GitFlowKindUnspecified
	}
}

// gitFlowResultToProto maps a domain git-flow result to its wire form (ADR-027).
// Steps is always non-nil so an empty sequence serializes as an empty repeated
// field.
func gitFlowResultToProto(r *domain.GitFlowResult) *singularitreev1.GitFlowResult {
	if r == nil {
		return nil
	}
	steps := make([]string, 0, len(r.Steps))
	steps = append(steps, r.Steps...)
	return &singularitreev1.GitFlowResult{
		Branch:      r.Branch,
		Steps:       steps,
		HasConflict: r.HasConflict,
	}
}

// resetModeToDomain maps the wire reset mode to its domain value. The zero
// (unspecified) value is rejected (ADR-0021).
func resetModeToDomain(m singularitreev1.ResetMode) (domain.ResetMode, bool) {
	switch m {
	case singularitreev1.ResetMode_SOFT:
		return domain.ResetModeSoft, true
	case singularitreev1.ResetMode_MIXED:
		return domain.ResetModeMixed, true
	case singularitreev1.ResetMode_HARD:
		return domain.ResetModeHard, true
	default:
		return domain.ResetModeUnspecified, false
	}
}

// mergeStrategyToDomain maps the wire merge strategy to its domain value. The
// zero (unspecified) value is rejected (ADR-028).
func mergeStrategyToDomain(s singularitreev1.MergeStrategy) (domain.MergeStrategy, bool) {
	switch s {
	case singularitreev1.MergeStrategy_MERGE:
		return domain.MergeStrategyMerge, true
	case singularitreev1.MergeStrategy_NO_FF:
		return domain.MergeStrategyNoFF, true
	case singularitreev1.MergeStrategy_FF_ONLY:
		return domain.MergeStrategyFFOnly, true
	case singularitreev1.MergeStrategy_SQUASH:
		return domain.MergeStrategySquash, true
	default:
		return domain.MergeStrategyUnspecified, false
	}
}

// diffToProto maps a domain diff to its wire form. Candidate oids are omitted
// when absent (zero Oid) so the optional Oid fields stay unset for a diff whose
// side is the working tree; metadata counts and flags are carried through. The
// per-file sections and the truncated flag are included alongside the
// deprecated flat hunks (ADR-0020).
func diffToProto(d *domain.Diff) *singularitreev1.Diff {
	if d == nil {
		return nil
	}
	out := &singularitreev1.Diff{
		Hunks:              make([]*singularitreev1.Hunk, 0, len(d.Hunks)),
		Additions:          int32(d.Additions),
		Deletions:          int32(d.Deletions),
		IsBinary:           d.IsBinary,
		HasConflictMarkers: d.HasConflictMarkers,
		Files:              make([]*singularitreev1.FileDiff, 0, len(d.Files)),
		Truncated:          d.Truncated,
	}
	if d.From.Hex != "" {
		out.From = oidToProto(d.From)
	}
	if d.To.Hex != "" {
		out.To = oidToProto(d.To)
	}
	for i := range d.Hunks {
		out.Hunks = append(out.Hunks, hunkToProto(d.Hunks[i]))
	}
	for i := range d.Files {
		out.Files = append(out.Files, fileDiffToProto(d.Files[i]))
	}
	return out
}

func authSourceToProto(s domain.AuthSource) singularitreev1.AuthSource {
	switch s {
	case domain.AuthSourceNone:
		return singularitreev1.AuthSource_AUTH_SOURCE_NONE
	case domain.AuthSourceGitHubCLI:
		return singularitreev1.AuthSource_AUTH_SOURCE_GITHUB_CLI
	case domain.AuthSourceOAuth:
		return singularitreev1.AuthSource_AUTH_SOURCE_OAUTH
	default:
		return singularitreev1.AuthSource_AUTH_SOURCE_UNSPECIFIED
	}
}

func authStatusToProto(s *domain.AuthStatus) *singularitreev1.AuthStatus {
	if s == nil {
		return nil
	}
	return &singularitreev1.AuthStatus{
		Authenticated: s.Authenticated,
		Source:        authSourceToProto(s.Source),
		AccountLogin:  s.AccountLogin,
		Name:          s.Name,
		AvatarUrl:     s.AvatarURL,
		Email:         s.Email,
		Scopes:        s.Scopes,
		RateLimit:     rateLimitToProto(s.RateLimit),
	}
}

func githubUserToProto(u *domain.GitHubUser) *singularitreev1.GitHubUser {
	if u == nil {
		return nil
	}
	return &singularitreev1.GitHubUser{
		Id:        u.ID,
		Login:     u.Login,
		Name:      u.Name,
		AvatarUrl: u.AvatarURL,
		Email:     u.Email,
		HtmlUrl:   u.HTMLURL,
	}
}

func githubRepoToProto(r domain.GitHubRepo) *singularitreev1.GitHubRepo {
	return &singularitreev1.GitHubRepo{
		Id:              r.ID,
		Name:            r.Name,
		FullName:        r.FullName,
		Private:         r.Private,
		HtmlUrl:         r.HTMLURL,
		Description:     r.Description,
		Language:        r.Language,
		StargazersCount: r.StargazersCount,
		UpdatedAt:       r.UpdatedAt,
		NodeId:          r.NodeID,
		DefaultBranch:   r.DefaultBranch,
		OwnerLogin:      r.OwnerLogin,
		OwnerAvatarUrl:  r.OwnerAvatarURL,
		Visibility:      r.Visibility,
		Fork:            r.Fork,
		Archived:        r.Archived,
		Disabled:        r.Disabled,
		CloneUrl:        r.CloneURL,
		SshUrl:          r.SSHURL,
		GitUrl:          r.GitURL,
		PushedAt:        r.PushedAt,
		CreatedAt:       r.CreatedAt,
		ForksCount:      r.ForksCount,
		OpenIssuesCount: r.OpenIssuesCount,
		Topics:          r.Topics,
		LicenseSpdxId:   r.LicenseSPDXID,
		IsTemplate:      r.IsTemplate,
		Homepage:        r.Homepage,
	}
}

func pageInfoToProto(p domain.PageInfo) *singularitreev1.PageInfo {
	return &singularitreev1.PageInfo{
		Page:     p.Page,
		PerPage:  p.PerPage,
		NextPage: p.NextPage,
		HasMore:  p.HasMore,
		Total:    p.Total,
	}
}

func rateLimitToProto(r *domain.RateLimit) *singularitreev1.RateLimit {
	if r == nil {
		return nil
	}
	return &singularitreev1.RateLimit{
		Resource:  r.Resource,
		Limit:     r.Limit,
		Remaining: r.Remaining,
		Reset_:    r.Reset,
		ResetAt:   r.ResetAt,
	}
}

// grpcCodeFor maps a domain error code to the closest gRPC status code.
func grpcCodeFor(appCode string) codes.Code {
	switch appCode {
	case domain.ErrCodeRepoNotFound, domain.ErrCodeCommitNotFound, domain.ErrCodeBranchNotFound,
		domain.ErrCodeRepoPathMissing:
		return codes.NotFound
	case domain.ErrCodeNotAGitRepo, domain.ErrCodeInvalidOid,
		domain.ErrCodeDetachedHead, domain.ErrCodeStageFailed,
		domain.ErrCodeCommitFailed, domain.ErrCodeCheckoutFailed,
		domain.ErrCodeStashFailed, domain.ErrCodeDiffFailed,
		domain.ErrCodeResetFailed, domain.ErrCodeDiscardFailed:
		return codes.InvalidArgument
	case domain.ErrCodeBranchExists:
		return codes.AlreadyExists
	case domain.ErrCodeMergeConflict:
		return codes.FailedPrecondition
	case domain.ErrCodeMergeFailed:
		return codes.Aborted
	case domain.ErrCodeCherryPickConflict, domain.ErrCodeRevertConflict:
		return codes.FailedPrecondition
	case domain.ErrCodeCherryPickFailed, domain.ErrCodeRevertFailed:
		return codes.Aborted
	case domain.ErrCodeTagExists:
		return codes.FailedPrecondition
	case domain.ErrCodeRepoPathInUse:
		return codes.FailedPrecondition
	case domain.ErrCodeTagNotFound:
		return codes.NotFound
	case domain.ErrCodeGitFlowFailed:
		return codes.InvalidArgument
	case domain.ErrCodeUnauthenticated:
		return codes.Unauthenticated
	case domain.ErrCodeGHCLINotFound:
		return codes.NotFound
	case domain.ErrCodeGHCLIUnauthenticated, domain.ErrCodeGitHubTokenInvalid:
		return codes.Unauthenticated
	case domain.ErrCodeGitHubRateLimited:
		return codes.ResourceExhausted
	case domain.ErrCodeGitHubAPIError:
		return codes.Unavailable
	case domain.ErrCodeQueueFull:
		return codes.ResourceExhausted
	case domain.ErrCodeGoCoreUnavailable:
		return codes.Unavailable
	case domain.ErrCodeNotImplemented:
		return codes.Unimplemented
	case domain.ErrCodeFetchFailed, domain.ErrCodePushFailed, domain.ErrCodePullFailed:
		return codes.Unavailable
	default:
		return codes.Internal
	}
}

// appErrorToStatus converts a domain.AppError into a gRPC status error and
// attaches the domain code as trailing metadata. Non-AppError errors are passed
// through when they are already gRPC statuses, else wrapped as Internal.
func appErrorToStatus(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}

	var appErr domain.AppError
	if errors.As(err, &appErr) {
		trailer := metadata.Pairs(appErrorTrailerKey, appErr.Code)
		if len(appErr.Details) > 0 {
			// Structured fields only; never surface secrets/tokens here.
			if encoded, mErr := json.Marshal(appErr.Details); mErr == nil {
				trailer.Set(appErrorDetailsTrailerKey, string(encoded))
			}
		}
		_ = googlegrpc.SetTrailer(ctx, trailer)
		msg := appErr.Message
		if msg == "" {
			msg = appErr.Code
		}
		return status.Error(grpcCodeFor(appErr.Code), msg)
	}

	if _, ok := status.FromError(err); ok {
		return err
	}
	return status.Error(codes.Internal, err.Error())
}
