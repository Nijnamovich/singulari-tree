package grpc

import (
	"context"
	"crypto/subtle"
	"errors"
	"strings"
	"time"

	googlegrpc "google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	singularitreev1 "github.com/SingulariTree/go-core/gen/go/singularitree/v1"
	"github.com/SingulariTree/go-core/internal/domain"
	"github.com/SingulariTree/go-core/internal/service"
)

// Server is the gRPC transport adapter for the singularitree.v1 GitCore service.
// It embeds UnimplementedGitCoreServer so not-yet-implemented RPCs return
// codes.Unimplemented instead of panicking.
type Server struct {
	singularitreev1.UnimplementedGitCoreServer

	repoSvc    *service.RepoService
	gitSvc     *service.GitService
	graphSvc   *service.GraphService
	watcherSvc *service.WatcherService
	cacheSvc   *service.CacheService
	gitflowSvc *service.GitFlowService
	token      string
	startedAt  time.Time
}

// NewServer creates the GitCore gRPC adapter. token, when non-empty, is enforced
// by the auth interceptors returned from UnaryAuthInterceptor/StreamAuthInterceptor.
func NewServer(repoSvc *service.RepoService, gitSvc *service.GitService, graphSvc *service.GraphService, watcherSvc *service.WatcherService, cacheSvc *service.CacheService, gitflowSvc *service.GitFlowService, token string) *Server {
	return &Server{
		repoSvc:    repoSvc,
		gitSvc:     gitSvc,
		graphSvc:   graphSvc,
		watcherSvc: watcherSvc,
		cacheSvc:   cacheSvc,
		gitflowSvc: gitflowSvc,
		token:      token,
		startedAt:  time.Now(),
	}
}

// Register registers the GitCore service implementation on a grpc.Server.
func (s *Server) Register(gs *googlegrpc.Server) {
	singularitreev1.RegisterGitCoreServer(gs, s)
}

// Ping is the supervisor heartbeat (ipc-strategy.md §2.6).
func (s *Server) Ping(context.Context, *singularitreev1.PingRequest) (*singularitreev1.PingResponse, error) {
	return &singularitreev1.PingResponse{
		Ok:         true,
		UptimeMs:   uint64(time.Since(s.startedAt).Milliseconds()),
		QueueDepth: 0,
	}, nil
}

// OpenRepository validates and tracks a repository, returning its record.
func (s *Server) OpenRepository(ctx context.Context, req *singularitreev1.OpenRepositoryRequest) (*singularitreev1.Repository, error) {
	if s.repoSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "repo service not configured")
	}
	repo, err := s.repoSvc.Open(ctx, req.GetFsPath())
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return repositoryToProto(repo), nil
}

// GetRepository returns a tracked repository by ID.
func (s *Server) GetRepository(ctx context.Context, req *singularitreev1.GetRepositoryRequest) (*singularitreev1.Repository, error) {
	if s.repoSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "repo service not configured")
	}
	repo, err := s.repoSvc.Get(ctx, domain.RepositoryId(req.GetRepoId()))
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return repositoryToProto(repo), nil
}

// ListRepositories returns all tracked repositories (most recent first).
func (s *Server) ListRepositories(ctx context.Context, _ *singularitreev1.ListRepositoriesRequest) (*singularitreev1.ListRepositoriesResponse, error) {
	if s.repoSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "repo service not configured")
	}
	repos, err := s.repoSvc.List(ctx)
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	out := &singularitreev1.ListRepositoriesResponse{
		Repositories: make([]*singularitreev1.Repository, 0, len(repos)),
	}
	for i := range repos {
		out.Repositories = append(out.Repositories, repositoryToProto(&repos[i]))
	}
	return out, nil
}

// RemoveRepository untracks a repository. The delete cascades to its cached
// rows (ON DELETE CASCADE, PRAGMA foreign_keys=ON); any in-memory state keyed
// by the repository ID is then dropped best-effort so stale lane layouts or
// cached commit windows are not served for the removed ID.
func (s *Server) RemoveRepository(ctx context.Context, req *singularitreev1.RemoveRepositoryRequest) (*singularitreev1.RemoveRepositoryResponse, error) {
	if s.repoSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "repo service not configured")
	}
	id := domain.RepositoryId(req.GetRepoId())
	if err := s.repoSvc.Remove(ctx, id); err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	if s.graphSvc != nil {
		s.graphSvc.Invalidate(id)
	}
	if s.cacheSvc != nil {
		s.cacheSvc.Invalidate(id)
	}
	return &singularitreev1.RemoveRepositoryResponse{}, nil
}

// RelocateRepository repoints an existing repository registration at a new
// filesystem path, preserving its id (a delete + re-create would mint a new id
// and lose the registration). The path changed, so any in-memory state keyed by
// the repository id — cached lane layouts/commit windows — is dropped
// best-effort exactly like RemoveRepository, so the previous location's state is
// never served for the relocated id.
func (s *Server) RelocateRepository(ctx context.Context, req *singularitreev1.RelocateRepositoryRequest) (*singularitreev1.Repository, error) {
	if s.repoSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "repo service not configured")
	}
	id := domain.RepositoryId(req.GetRepoId())
	repo, err := s.repoSvc.Relocate(ctx, id, req.GetFsPath())
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	if s.graphSvc != nil {
		s.graphSvc.Invalidate(id)
	}
	if s.cacheSvc != nil {
		s.cacheSvc.Invalidate(id)
	}
	return repositoryToProto(repo), nil
}

// GetCommits returns a window of commits plus the total reachable count.
//
// An optional branch lens (non-empty refs) widens the walk to the union
// HEAD ∪ refs without checking anything out; in that case in_refs reports, per
// commit, whether it is reachable from the requested refs.
func (s *Server) GetCommits(ctx context.Context, req *singularitreev1.GetCommitsRequest) (*singularitreev1.GetCommitsResponse, error) {
	if s.graphSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "graph service not configured")
	}
	repoID := domain.RepositoryId(req.GetRepoId())
	refs := req.GetRefs()
	commits, total, err := s.graphSvc.Commits(ctx, repoID, refs, int(req.GetOffset()), int(req.GetLimit()))
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	// Lanes are computed in Go (ADR-008) and returned as a parallel array:
	// lanes[i] belongs to commits[i]. WindowLanes keeps columns continuous with
	// the folded history across scroll windows (stateful per-repo, per-lens lane
	// state), falling back to the pure window-local Lanes when no Git port.
	lanes, err := s.graphSvc.WindowLanes(ctx, repoID, refs, commits, int(req.GetOffset()))
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	out := &singularitreev1.GetCommitsResponse{
		Commits: make([]*singularitreev1.Commit, 0, len(commits)),
		Total:   uint32(total),
		Lanes:   make([]*singularitreev1.Lane, 0, len(lanes)),
	}
	for _, c := range commits {
		out.Commits = append(out.Commits, commitToProto(c))
	}
	for _, l := range lanes {
		out.Lanes = append(out.Lanes, laneToProto(l))
	}
	// in_refs is the branch-lens membership array, parallel to commits: entry i
	// is true when commits[i] is reachable from the requested refs. For an
	// un-lensed request it is left empty — shorter than commits is the contract
	// for that case, so the renderer never pays for a membership walk it did not
	// ask for.
	if len(refs) > 0 {
		oids, err := s.graphSvc.LensOids(ctx, repoID, refs)
		if err != nil {
			return nil, appErrorToStatus(ctx, err)
		}
		member := make(map[string]struct{}, len(oids))
		for _, oid := range oids {
			member[oid] = struct{}{}
		}
		out.InRefs = make([]bool, len(commits))
		for i := range commits {
			_, out.InRefs[i] = member[commits[i].Oid.Hex]
		}
	}
	return out, nil
}

// GetBranches returns the repository's local and remote-tracking branches.
func (s *Server) GetBranches(ctx context.Context, req *singularitreev1.GetBranchesRequest) (*singularitreev1.GetBranchesResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	branches, err := s.gitSvc.BranchList(ctx, domain.RepositoryId(req.GetRepoId()))
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	out := &singularitreev1.GetBranchesResponse{
		Branches: make([]*singularitreev1.Branch, 0, len(branches)),
	}
	for _, b := range branches {
		out.Branches = append(out.Branches, branchToProto(b))
	}
	return out, nil
}

// GetRemotes returns the repository's configured remotes.
func (s *Server) GetRemotes(ctx context.Context, req *singularitreev1.GetRemotesRequest) (*singularitreev1.GetRemotesResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	remotes, err := s.gitSvc.RemoteList(ctx, domain.RepositoryId(req.GetRepoId()))
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	out := &singularitreev1.GetRemotesResponse{
		Remotes: make([]*singularitreev1.Remote, 0, len(remotes)),
	}
	for _, r := range remotes {
		out.Remotes = append(out.Remotes, remoteToProto(r))
	}
	return out, nil
}

// GetTags returns the repository's tags.
func (s *Server) GetTags(ctx context.Context, req *singularitreev1.GetTagsRequest) (*singularitreev1.GetTagsResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	tags, err := s.gitSvc.TagList(ctx, domain.RepositoryId(req.GetRepoId()))
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	out := &singularitreev1.GetTagsResponse{
		Tags: make([]*singularitreev1.Tag, 0, len(tags)),
	}
	for _, tag := range tags {
		out.Tags = append(out.Tags, tagToProto(tag))
	}
	return out, nil
}

// Fetch runs `git fetch` and streams progress chunks to the client
// (server-streaming RPC). Errors before streaming starts are returned with the
// domain code attached as trailer metadata via appErrorToStatus.
func (s *Server) Fetch(req *singularitreev1.FetchRequest, stream googlegrpc.ServerStreamingServer[singularitreev1.Progress]) error {
	if s.gitSvc == nil {
		return status.Error(codes.FailedPrecondition, "git service not configured")
	}
	opts := domain.RemoteOpOptions{
		Prune: req.GetPrune(),
		Tags:  req.GetTags(),
		Force: req.GetForce(),
	}
	ch, err := s.gitSvc.Fetch(stream.Context(), domain.RepositoryId(req.GetRepoId()), req.GetRemote(), opts)
	if err != nil {
		return appErrorToStatus(stream.Context(), err)
	}
	return streamProgress(stream, ch)
}

// Push runs `git push` and streams progress chunks to the client.
func (s *Server) Push(req *singularitreev1.PushRequest, stream googlegrpc.ServerStreamingServer[singularitreev1.Progress]) error {
	if s.gitSvc == nil {
		return status.Error(codes.FailedPrecondition, "git service not configured")
	}
	opts := domain.RemoteOpOptions{
		SetUpstream:  req.GetSetUpstream(),
		RemoteBranch: req.GetRemoteBranch(),
		Tags:         req.GetTags(),
		Force:        req.GetForce(),
	}
	ch, err := s.gitSvc.Push(stream.Context(), domain.RepositoryId(req.GetRepoId()), req.GetRemote(), req.GetBranch(), opts)
	if err != nil {
		return appErrorToStatus(stream.Context(), err)
	}
	return streamProgress(stream, ch)
}

// Pull runs `git pull` and streams progress chunks to the client.
func (s *Server) Pull(req *singularitreev1.PullRequest, stream googlegrpc.ServerStreamingServer[singularitreev1.Progress]) error {
	if s.gitSvc == nil {
		return status.Error(codes.FailedPrecondition, "git service not configured")
	}
	opts := domain.RemoteOpOptions{
		LocalBranch: req.GetLocalBranch(),
		NoCommit:    req.GetNoCommit(),
		Log:         req.GetLog(),
		NoFF:        req.GetNoFf(),
		Rebase:      req.GetRebase(),
	}
	ch, err := s.gitSvc.Pull(stream.Context(), domain.RepositoryId(req.GetRepoId()), req.GetRemote(), req.GetBranch(), opts)
	if err != nil {
		return appErrorToStatus(stream.Context(), err)
	}
	return streamProgress(stream, ch)
}

// Watch streams filesystem change events for a repository (server-streaming
// RPC). Each domain event is forwarded as a proto FsChangedEvent; the stream
// ends cleanly when the underlying subscription closes, and returns early on
// Send failure or context cancellation so the service pump goroutine stops
// with the stream (R12: no goroutine leak).
func (s *Server) Watch(req *singularitreev1.WatchRequest, stream googlegrpc.ServerStreamingServer[singularitreev1.FsChangedEvent]) error {
	if s.watcherSvc == nil {
		return status.Error(codes.FailedPrecondition, "watcher service not configured")
	}
	ch, err := s.watcherSvc.Watch(stream.Context(), domain.RepositoryId(req.GetRepoId()))
	if err != nil {
		return appErrorToStatus(stream.Context(), err)
	}
	for {
		select {
		case <-stream.Context().Done():
			return stream.Context().Err()
		case ev, ok := <-ch:
			if !ok {
				return nil
			}
			if err := stream.Send(&singularitreev1.FsChangedEvent{
				RepoId: string(ev.RepoID),
				Paths:  ev.Paths,
			}); err != nil {
				return err
			}
		}
	}
}

// Checkout switches the repository's working tree to the requested ref. The
// renderer sends the clicked ref verbatim; the adapter resolves local branches,
// remote-tracking branches and detached refs. force discards tracked
// modifications and discard_untracked additionally discards untracked files.
func (s *Server) Checkout(ctx context.Context, req *singularitreev1.CheckoutRequest) (*singularitreev1.CheckoutResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	if err := s.gitSvc.Checkout(ctx, domain.RepositoryId(req.GetRepoId()), domain.RefName{Raw: req.GetRefName()}, req.GetForce(), req.GetDiscardUntracked()); err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.CheckoutResponse{}, nil
}

// StashPush saves the repository's working-tree changes to a new stash entry,
// used by the branch-switch confirmation flow to "save the changes".
func (s *Server) StashPush(ctx context.Context, req *singularitreev1.StashPushRequest) (*singularitreev1.StashPushResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	st, err := s.gitSvc.StashPush(ctx, domain.RepositoryId(req.GetRepoId()), req.GetMessage())
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.StashPushResponse{Stash: stashToProto(st)}, nil
}

// GetStashes returns the repository's stash entries (ADR-028; previously a
// stub with no handler).
func (s *Server) GetStashes(ctx context.Context, req *singularitreev1.GetStashesRequest) (*singularitreev1.GetStashesResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	stashes, err := s.gitSvc.StashList(ctx, domain.RepositoryId(req.GetRepoId()))
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	out := &singularitreev1.GetStashesResponse{
		Stashes: make([]*singularitreev1.Stash, 0, len(stashes)),
	}
	for i := range stashes {
		out.Stashes = append(out.Stashes, stashToProto(&stashes[i]))
	}
	return out, nil
}

// CreateBranch creates a local branch from start_point (empty means HEAD) and
// optionally checks it out (ADR-028).
func (s *Server) CreateBranch(ctx context.Context, req *singularitreev1.CreateBranchRequest) (*singularitreev1.Branch, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	b, err := s.gitSvc.BranchCreate(ctx, domain.RepositoryId(req.GetRepoId()), req.GetName(), req.GetStartPoint(), req.GetCheckout())
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return branchToProto(*b), nil
}

// RenameBranch renames a local branch (ADR-028).
func (s *Server) RenameBranch(ctx context.Context, req *singularitreev1.RenameBranchRequest) (*singularitreev1.Branch, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	b, err := s.gitSvc.BranchRename(ctx, domain.RepositoryId(req.GetRepoId()), req.GetOldName(), req.GetNewName())
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return branchToProto(*b), nil
}

// DeleteBranch deletes a local branch; force maps to `git branch -D` (ADR-028).
func (s *Server) DeleteBranch(ctx context.Context, req *singularitreev1.DeleteBranchRequest) (*singularitreev1.DeleteBranchResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	if err := s.gitSvc.BranchDelete(ctx, domain.RepositoryId(req.GetRepoId()), domain.RefName{Raw: req.GetName()}, req.GetForce()); err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.DeleteBranchResponse{}, nil
}

// Merge integrates the requested ref into the current branch (ADR-028). A
// conflict is surfaced as data: has_conflict is set on the response and the
// tree is left conflicted (GetStatus reports is_conflicted); the typed
// MERGE_CONFLICT code is also attached to the trailer. MERGE_STRATEGY_UNSPECIFIED
// is rejected.
func (s *Server) Merge(ctx context.Context, req *singularitreev1.MergeRequest) (*singularitreev1.MergeResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	strategy, ok := mergeStrategyToDomain(req.GetStrategy())
	if !ok {
		return nil, appErrorToStatus(ctx, domain.AppError{
			Code:    domain.ErrCodeMergeFailed,
			Message: "merge strategy is required",
		})
	}
	result, err := s.gitSvc.Merge(ctx, domain.RepositoryId(req.GetRepoId()), req.GetRef(), strategy, req.GetNoCommit(), req.GetMessage())
	if err != nil {
		var appErr domain.AppError
		if errors.As(err, &appErr) && appErr.Code == domain.ErrCodeMergeConflict && result != nil {
			_ = googlegrpc.SetTrailer(ctx, metadata.Pairs(appErrorTrailerKey, domain.ErrCodeMergeConflict))
			return &singularitreev1.MergeResponse{HasConflict: true, Oid: result.Oid.Hex}, nil
		}
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.MergeResponse{HasConflict: result.HasConflict, Oid: result.Oid.Hex}, nil
}

// CherryPick applies the requested revision on top of the current branch
// (ADR-0042). A conflict is surfaced as data: has_conflict is set on the
// response, the tree is left conflicted (GetStatus reports is_conflicted) and
// the typed CHERRY_PICK_CONFLICT code is attached to the trailer.
func (s *Server) CherryPick(ctx context.Context, req *singularitreev1.CherryPickRequest) (*singularitreev1.CherryPickResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	result, err := s.gitSvc.CherryPick(ctx, domain.RepositoryId(req.GetRepoId()), req.GetSource(), req.GetRecordOrigin(), req.GetNoCommit())
	if err != nil {
		var appErr domain.AppError
		if errors.As(err, &appErr) && appErr.Code == domain.ErrCodeCherryPickConflict && result != nil {
			_ = googlegrpc.SetTrailer(ctx, metadata.Pairs(appErrorTrailerKey, domain.ErrCodeCherryPickConflict))
			return &singularitreev1.CherryPickResponse{HasConflict: true, Oid: result.Oid.Hex}, nil
		}
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.CherryPickResponse{HasConflict: result.HasConflict, Oid: result.Oid.Hex}, nil
}

// Revert undoes the requested revision on the current branch (ADR-0042). A
// conflict is surfaced as data exactly like Merge, with the REVERT_CONFLICT
// code in the trailer.
func (s *Server) Revert(ctx context.Context, req *singularitreev1.RevertRequest) (*singularitreev1.RevertResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	result, err := s.gitSvc.Revert(ctx, domain.RepositoryId(req.GetRepoId()), req.GetSource())
	if err != nil {
		var appErr domain.AppError
		if errors.As(err, &appErr) && appErr.Code == domain.ErrCodeRevertConflict && result != nil {
			_ = googlegrpc.SetTrailer(ctx, metadata.Pairs(appErrorTrailerKey, domain.ErrCodeRevertConflict))
			return &singularitreev1.RevertResponse{HasConflict: true, Oid: result.Oid.Hex}, nil
		}
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.RevertResponse{HasConflict: result.HasConflict, Oid: result.Oid.Hex}, nil
}

// ResolveRevision resolves a revision to its commit without mutating anything
// (ADR-0042), used by the cherry-pick/revert preview.
func (s *Server) ResolveRevision(ctx context.Context, req *singularitreev1.ResolveRevisionRequest) (*singularitreev1.Commit, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	commit, err := s.gitSvc.ResolveRevision(ctx, domain.RepositoryId(req.GetRepoId()), req.GetRevision())
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return commitToProto(*commit), nil
}

// CreateTag creates a tag (annotated or lightweight, ADR-028). An empty target
// means HEAD; force maps to `git tag -f`.
func (s *Server) CreateTag(ctx context.Context, req *singularitreev1.CreateTagRequest) (*singularitreev1.Tag, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	t, err := s.gitSvc.TagCreate(ctx, domain.RepositoryId(req.GetRepoId()), req.GetName(), req.GetTarget(), req.GetAnnotated(), req.GetMessage(), req.GetForce())
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return tagToProto(*t), nil
}

// DeleteTag deletes a tag (ADR-028).
func (s *Server) DeleteTag(ctx context.Context, req *singularitreev1.DeleteTagRequest) (*singularitreev1.DeleteTagResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	if err := s.gitSvc.TagDelete(ctx, domain.RepositoryId(req.GetRepoId()), domain.RefName{Raw: req.GetName()}); err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.DeleteTagResponse{}, nil
}

// StashApply applies stash entry index, retaining it; restore_index maps to
// `git stash apply --index` (ADR-028).
func (s *Server) StashApply(ctx context.Context, req *singularitreev1.StashApplyRequest) (*singularitreev1.StashApplyResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	if err := s.gitSvc.StashApply(ctx, domain.RepositoryId(req.GetRepoId()), int(req.GetIndex()), req.GetRestoreIndex()); err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.StashApplyResponse{}, nil
}

// StashPop applies and drops stash entry index (ADR-028).
func (s *Server) StashPop(ctx context.Context, req *singularitreev1.StashPopRequest) (*singularitreev1.StashPopResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	if err := s.gitSvc.StashPop(ctx, domain.RepositoryId(req.GetRepoId()), int(req.GetIndex())); err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.StashPopResponse{}, nil
}

// StashDrop removes stash entry index (ADR-028).
func (s *Server) StashDrop(ctx context.Context, req *singularitreev1.StashDropRequest) (*singularitreev1.StashDropResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	if err := s.gitSvc.StashDrop(ctx, domain.RepositoryId(req.GetRepoId()), int(req.GetIndex())); err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.StashDropResponse{}, nil
}

// GetGitFlowConfig returns a repository's git-flow preset configuration,
// defaulting when unset (ADR-027).
func (s *Server) GetGitFlowConfig(ctx context.Context, req *singularitreev1.GetGitFlowConfigRequest) (*singularitreev1.GitFlowConfig, error) {
	if s.gitflowSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git-flow service not configured")
	}
	cfg, err := s.gitflowSvc.Config(ctx, domain.RepositoryId(req.GetRepoId()))
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return gitFlowConfigToProto(cfg), nil
}

// SetGitFlowConfig stores a repository's git-flow preset configuration
// (ADR-027); empty fields fall back to the conventional defaults.
func (s *Server) SetGitFlowConfig(ctx context.Context, req *singularitreev1.SetGitFlowConfigRequest) (*singularitreev1.GitFlowConfig, error) {
	if s.gitflowSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git-flow service not configured")
	}
	cfg, err := s.gitflowSvc.SetConfig(ctx, domain.RepositoryId(req.GetRepoId()), gitFlowConfigToDomain(req.GetConfig()))
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return gitFlowConfigToProto(cfg), nil
}

// StartGitFlow creates and checks out a feature/release/hotfix branch
// (ADR-027). GIT_FLOW_KIND_UNSPECIFIED is rejected.
func (s *Server) StartGitFlow(ctx context.Context, req *singularitreev1.StartGitFlowRequest) (*singularitreev1.GitFlowResult, error) {
	if s.gitflowSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git-flow service not configured")
	}
	res, err := s.gitflowSvc.Start(ctx, domain.RepositoryId(req.GetRepoId()), gitFlowKindToDomain(req.GetKind()), req.GetName(), req.GetBase())
	return s.gitFlowResult(ctx, res, err)
}

// FinishGitFlow integrates and cleans up a feature/release/hotfix branch
// (ADR-027). A merge conflict is surfaced as data: has_conflict is set and the
// typed MERGE_CONFLICT code travels in the trailer, mirroring the Merge handler.
func (s *Server) FinishGitFlow(ctx context.Context, req *singularitreev1.FinishGitFlowRequest) (*singularitreev1.GitFlowResult, error) {
	if s.gitflowSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git-flow service not configured")
	}
	res, err := s.gitflowSvc.Finish(ctx, domain.RepositoryId(req.GetRepoId()), gitFlowKindToDomain(req.GetKind()), req.GetName(), req.GetDeleteBranch())
	return s.gitFlowResult(ctx, res, err)
}

// gitFlowResult maps a git-flow result/error pair to the wire. A conflict
// (MERGE_CONFLICT with a non-nil result) returns the result with has_conflict
// set and attaches the domain code as trailer metadata instead of failing.
func (s *Server) gitFlowResult(ctx context.Context, res *domain.GitFlowResult, err error) (*singularitreev1.GitFlowResult, error) {
	if err != nil {
		var appErr domain.AppError
		if errors.As(err, &appErr) && appErr.Code == domain.ErrCodeMergeConflict && res != nil {
			_ = googlegrpc.SetTrailer(ctx, metadata.Pairs(appErrorTrailerKey, domain.ErrCodeMergeConflict))
			return gitFlowResultToProto(res), nil
		}
		return nil, appErrorToStatus(ctx, err)
	}
	return gitFlowResultToProto(res), nil
}

// GetStatus returns the working-tree file status for a repository.
func (s *Server) GetStatus(ctx context.Context, req *singularitreev1.GetStatusRequest) (*singularitreev1.GetStatusResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	files, err := s.gitSvc.Status(ctx, domain.RepositoryId(req.GetRepoId()))
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	out := &singularitreev1.GetStatusResponse{
		Files: make([]*singularitreev1.FileStatus, 0, len(files)),
	}
	for _, f := range files {
		out.Files = append(out.Files, fileStatusToProto(f))
	}
	return out, nil
}

// parseRequestOid validates an optional Oid hex carried by a request. An empty
// string yields the zero Oid (omitted side / working tree); a non-empty value
// must be a valid 40/64-hex oid, otherwise it is an AppError INVALID_OID.
func parseRequestOid(hex string) (domain.Oid, error) {
	if hex == "" {
		return domain.Oid{}, nil
	}
	return domain.NewOid(hex)
}

// GetDiff returns the diff between two oids for a repository. Empty from/to
// mean the zero Oid (omitted side / working tree).
func (s *Server) GetDiff(ctx context.Context, req *singularitreev1.GetDiffRequest) (*singularitreev1.Diff, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	from, err := parseRequestOid(req.GetFrom())
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	to, err := parseRequestOid(req.GetTo())
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	d, err := s.gitSvc.Diff(ctx, domain.RepositoryId(req.GetRepoId()), domain.DiffRequest{
		From:   from,
		To:     to,
		Path:   req.GetPath(),
		Staged: req.GetStaged(),
	})
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return diffToProto(d), nil
}

// Stage stages the requested paths.
func (s *Server) Stage(ctx context.Context, req *singularitreev1.StageRequest) (*singularitreev1.StageResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	if err := s.gitSvc.Stage(ctx, domain.RepositoryId(req.GetRepoId()), req.GetPaths()); err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.StageResponse{}, nil
}

// Unstage unstages the requested paths.
func (s *Server) Unstage(ctx context.Context, req *singularitreev1.UnstageRequest) (*singularitreev1.UnstageResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	if err := s.gitSvc.Unstage(ctx, domain.RepositoryId(req.GetRepoId()), req.GetPaths()); err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.UnstageResponse{}, nil
}

// StageHunk stages one hunk (or selected lines) of a path from the working tree
// into the index (ADR-0020).
func (s *Server) StageHunk(ctx context.Context, req *singularitreev1.StageHunkRequest) (*singularitreev1.StageHunkResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	if err := s.gitSvc.StageHunk(ctx, domain.RepositoryId(req.GetRepoId()), req.GetPath(), req.GetHunkIndex(), req.GetLineIndices()); err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.StageHunkResponse{}, nil
}

// UnstageHunk removes one hunk (or selected lines) of a path from the index
// (ADR-0020).
func (s *Server) UnstageHunk(ctx context.Context, req *singularitreev1.UnstageHunkRequest) (*singularitreev1.UnstageHunkResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	if err := s.gitSvc.UnstageHunk(ctx, domain.RepositoryId(req.GetRepoId()), req.GetPath(), req.GetHunkIndex(), req.GetLineIndices()); err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.UnstageHunkResponse{}, nil
}

// DiscardHunk reverts one hunk (or selected lines) of a path in the working
// tree (ADR-0020).
func (s *Server) DiscardHunk(ctx context.Context, req *singularitreev1.DiscardHunkRequest) (*singularitreev1.DiscardHunkResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	if err := s.gitSvc.DiscardHunk(ctx, domain.RepositoryId(req.GetRepoId()), req.GetPath(), req.GetHunkIndex(), req.GetLineIndices()); err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.DiscardHunkResponse{}, nil
}

// Discard reverts file-level changes: tracked paths from HEAD/index, untracked
// paths by removal (ADR-0020).
func (s *Server) Discard(ctx context.Context, req *singularitreev1.DiscardRequest) (*singularitreev1.DiscardResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	if err := s.gitSvc.Discard(ctx, domain.RepositoryId(req.GetRepoId()), req.GetPaths()); err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.DiscardResponse{}, nil
}

// Reset runs `git reset --<mode> <to>` (ADR-0021). MODE_UNSPECIFIED is rejected
// as InvalidArgument.
func (s *Server) Reset(ctx context.Context, req *singularitreev1.ResetRequest) (*singularitreev1.ResetResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	mode, ok := resetModeToDomain(req.GetMode())
	if !ok {
		return nil, appErrorToStatus(ctx, domain.AppError{
			Code:    domain.ErrCodeResetFailed,
			Message: "reset mode is required",
		})
	}
	if err := s.gitSvc.Reset(ctx, domain.RepositoryId(req.GetRepoId()), req.GetTo(), mode); err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return &singularitreev1.ResetResponse{}, nil
}

// GetCommitStats returns change-size counts for a batch of commits (ADR-0023),
// cache-through from SQLite.
func (s *Server) GetCommitStats(ctx context.Context, req *singularitreev1.GetCommitStatsRequest) (*singularitreev1.GetCommitStatsResponse, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	stats, err := s.gitSvc.CommitStats(ctx, domain.RepositoryId(req.GetRepoId()), req.GetOids())
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	out := &singularitreev1.GetCommitStatsResponse{Stats: make([]*singularitreev1.CommitStats, 0, len(stats))}
	for i := range stats {
		out.Stats = append(out.Stats, commitStatsToProto(stats[i]))
	}
	return out, nil
}

// Commit creates a commit and returns it. When the request carries an author
// override it is passed through; When is parsed as RFC3339 and an unparseable
// timestamp is rejected as InvalidArgument (COMMIT_FAILED) rather than silently
// committing with a zero time.
func (s *Server) Commit(ctx context.Context, req *singularitreev1.CommitRequest) (*singularitreev1.Commit, error) {
	if s.gitSvc == nil {
		return nil, status.Error(codes.FailedPrecondition, "git service not configured")
	}
	var author *domain.Signature
	if a := req.GetAuthor(); a != nil {
		sig := domain.Signature{Name: a.GetName(), Email: a.GetEmail()}
		if when := a.GetWhen(); when != "" {
			t, err := time.Parse(time.RFC3339, when)
			if err != nil {
				return nil, appErrorToStatus(ctx, domain.AppError{
					Code:    domain.ErrCodeCommitFailed,
					Message: "invalid author.when: must be RFC3339",
					Details: map[string]string{"when": when},
				})
			}
			sig.When = t
		}
		author = &sig
	}
	c, err := s.gitSvc.Commit(ctx, domain.RepositoryId(req.GetRepoId()), req.GetMessage(), author)
	if err != nil {
		return nil, appErrorToStatus(ctx, err)
	}
	return commitToProto(*c), nil
}

// streamProgress drains a domain RemoteOpResult channel, forwarding each
// progress chunk as a proto Progress. A terminal result carrying an Err is
// converted with appErrorToStatus so the client's Recv sees a non-OK status and
// the typed domain code in the trailer; a clean close returns nil (success). It
// returns early when Send fails or the context is cancelled, so no goroutine
// leaks (R12).
func streamProgress(stream googlegrpc.ServerStreamingServer[singularitreev1.Progress], ch <-chan domain.RemoteOpResult) error {
	for r := range ch {
		if r.Err != nil {
			return appErrorToStatus(stream.Context(), r.Err)
		}
		if r.Progress == nil {
			continue
		}
		if err := stream.Send(progressToProto(*r.Progress)); err != nil {
			return err
		}
	}
	return nil
}

// UnaryAuthInterceptor validates `authorization: Bearer <token>` metadata.
// When token is empty, authentication is disabled.
func UnaryAuthInterceptor(token string) googlegrpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, _ *googlegrpc.UnaryServerInfo, handler googlegrpc.UnaryHandler) (any, error) {
		if err := authorize(ctx, token); err != nil {
			return nil, err
		}
		return handler(ctx, req)
	}
}

// StreamAuthInterceptor validates `authorization: Bearer <token>` metadata for
// streaming RPCs.
func StreamAuthInterceptor(token string) googlegrpc.StreamServerInterceptor {
	return func(srv any, ss googlegrpc.ServerStream, _ *googlegrpc.StreamServerInfo, handler googlegrpc.StreamHandler) error {
		if err := authorize(ss.Context(), token); err != nil {
			return err
		}
		return handler(srv, ss)
	}
}

func authorize(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return status.Error(codes.Unauthenticated, "missing metadata")
	}
	want := "Bearer " + token
	for _, v := range md.Get("authorization") {
		if secureEqual(strings.TrimSpace(v), want) {
			return nil
		}
	}
	return status.Error(codes.Unauthenticated, "invalid or missing token")
}

// secureEqual compares a and b in constant time (length-checked first) so token
// validation does not leak information through timing. Behaviour is identical
// to == for the boolean result.
func secureEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
