import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { isStreamingRpc, isUnimplementedStreamingRpc } from '../ipc/channels';

/**
 * GoCoreClient — gRPC client for the `singularitree.v1.GitCore` service.
 *
 * This module deliberately has NO `electron` import so it can be constructed
 * and exercised under plain Node (unit / e2e tests, see test/go-core.e2e.test.ts).
 *
 * Wire contract SSOT is `libs/contracts/proto/*.proto`; the service is loaded
 * at runtime with @grpc/proto-loader (so `protoDir` must point at that folder).
 * The TypeScript interfaces below mirror `libs/contracts/gen/ts` but are declared
 * locally on purpose: the Electron tsconfig uses `rootDir: src`, so importing
 * files from `libs/contracts/gen/ts` would break `tsc` (files outside rootDir).
 * proto-loader enforces the actual wire contract at runtime.
 */

/** Proto files required to build the full GitCore package definition. */
export const GIT_CORE_PROTO_FILES = [
  'domain.proto',
  'errors.proto',
  'gitcore.proto',
  'auth.proto',
] as const;

/** Every RPC exposed by `singularitree.v1.GitCore` (proto source order). */
export const GIT_CORE_RPC_METHODS = [
  'Ping',
  'OpenRepository',
  'GetRepository',
  'ListRepositories',
  'RemoveRepository',
  'RelocateRepository',
  'GetCommits',
  'StreamCommits',
  'GetBranches',
  'GetRemotes',
  'GetTags',
  'GetStashes',
  'GetWorktrees',
  'GetStatus',
  'GetDiff',
  'Stage',
  'Unstage',
  'StageHunk',
  'UnstageHunk',
  'DiscardHunk',
  'Discard',
  'Reset',
  'GetCommitStats',
  'Commit',
  'Checkout',
  'StashPush',
  'CreateBranch',
  'RenameBranch',
  'DeleteBranch',
  'Merge',
  'CherryPick',
  'Revert',
  'ResolveRevision',
  'CreateTag',
  'DeleteTag',
  'StashApply',
  'StashPop',
  'StashDrop',
  'Fetch',
  'Push',
  'Pull',
  'Watch',
  'GetGitFlowConfig',
  'SetGitFlowConfig',
  'StartGitFlow',
  'FinishGitFlow',
] as const;

export type RpcName = (typeof GIT_CORE_RPC_METHODS)[number];

/**
 * Every Auth RPC exposed over IPC (frozen additive surface; all unary).
 * Mirrors `singularitree.v1.Auth`; the remaining OAuth RPCs are not yet wired.
 */
export const AUTH_RPC_METHODS = [
  'GetAuthStatus',
  'ConnectGitHubFromCLI',
  'ListGitHubRepos',
  'Logout',
] as const;

export type AuthRpcName = (typeof AUTH_RPC_METHODS)[number];

// ---------------------------------------------------------------------------
// Wire types (mirror libs/contracts/gen/ts/{domain,gitcore}.ts)
// ---------------------------------------------------------------------------

export interface Oid {
  hex: string;
  kind: string;
}

export interface Signature {
  name: string;
  email: string;
  when: string;
}

export interface RefLabel {
  name: string;
  kind: string;
}

export interface Commit {
  oid: Oid | undefined;
  parents: Oid[];
  author: Signature | undefined;
  committer: Signature | undefined;
  message: string;
  treeOid: Oid | undefined;
  committedAt: string;
  refs: RefLabel[];
}

export interface Lane {
  index: number;
  color: number;
  continues: boolean;
}

export interface Branch {
  name: string;
  refName: string;
  tip: Oid | undefined;
  upstream: string;
  isCurrent: boolean;
  isRemote: boolean;
  /** Commits behind upstream (proto field #7). */
  behind: number;
}

export interface Remote {
  name: string;
  urls: string[];
  fetchSpecs: string[];
}

export interface Tag {
  name: string;
  refName: string;
  target: Oid | undefined;
  tagger: Signature | undefined;
  message: string;
  annotated: boolean;
}

export interface Stash {
  index: number;
  oid: Oid | undefined;
  message: string;
  branchName: string;
}

export interface Worktree {
  fsPath: string;
  branch: string;
  head: Oid | undefined;
  isMain: boolean;
}

export interface Repository {
  id: string;
  fsPath: string;
  commonDir: string;
  name: string;
  createdAt: string;
  lastOpenedAt: string;
}

export interface DiffLine {
  kind: string;
  text: string;
  noNewline: boolean;
}

export interface Hunk {
  fromStart: number;
  fromLines: number;
  toStart: number;
  toLines: number;
  lines: DiffLine[];
}

/** Per-file diff section (ADR-0020) — the addressing substrate for hunk ops. */
export interface FileDiff {
  path: string;
  /** optional (renames/copies) */
  oldPath: string;
  /** porcelain v2 code */
  status: string;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  isBinary: boolean;
  hasConflictMarkers: boolean;
}

export interface Diff {
  from: Oid | undefined;
  to: Oid | undefined;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  isBinary: boolean;
  hasConflictMarkers: boolean;
  /** Per-file sections (ADR-0020), populated alongside the deprecated flat `hunks`. */
  files: FileDiff[];
  /** True when the core capped the payload (MaxDiffHunks/MaxDiffLines). */
  truncated: boolean;
}

/** Per-commit change-size counts (ADR-0023); counts only, never Git objects. */
export interface CommitStats {
  oid: string;
  additions: number;
  deletions: number;
  filesChanged: number;
}

export interface FileStatus {
  path: string;
  staged: string;
  unstaged: string;
  isStaged: boolean;
  isConflicted: boolean;
}

export interface PingRequest {
  // empty
}

export interface PingResponse {
  ok: boolean;
  uptimeMs: number;
  queueDepth: number;
}

export interface OpenRepositoryRequest {
  fsPath: string;
}

export interface GetRepositoryRequest {
  repoId: string;
}

export interface ListRepositoriesRequest {
  // empty
}

export interface ListRepositoriesResponse {
  repositories: Repository[];
}

export interface RemoveRepositoryRequest {
  repoId: string;
}

export interface RemoveRepositoryResponse {
  // empty
}

export interface GetCommitsRequest {
  repoId: string;
  offset: number;
  limit: number;
}

export interface GetCommitsResponse {
  commits: Commit[];
  total: number;
  lanes: Lane[];
}

export interface StreamCommitsRequest {
  repoId: string;
  offset: number;
  limit: number;
}

export interface GetBranchesRequest {
  repoId: string;
}

export interface GetBranchesResponse {
  branches: Branch[];
}

export interface GetRemotesRequest {
  repoId: string;
}

export interface GetRemotesResponse {
  remotes: Remote[];
}

export interface GetTagsRequest {
  repoId: string;
}

export interface GetTagsResponse {
  tags: Tag[];
}

export interface GetStashesRequest {
  repoId: string;
}

export interface GetStashesResponse {
  stashes: Stash[];
}

export interface GetWorktreesRequest {
  repoId: string;
}

export interface GetWorktreesResponse {
  worktrees: Worktree[];
}

export interface GetStatusRequest {
  repoId: string;
}

export interface GetStatusResponse {
  files: FileStatus[];
}

export interface GetDiffRequest {
  repoId: string;
  from: string;
  to: string;
  /** Per-file selector (ADR-0020); empty means "all changed files". */
  path: string;
  /** HEAD->index instead of HEAD->worktree (maps to `git diff --cached`). */
  staged: boolean;
}

export interface StageRequest {
  repoId: string;
  paths: string[];
}

export interface StageResponse {
  // empty
}

export interface UnstageRequest {
  repoId: string;
  paths: string[];
}

export interface UnstageResponse {
  // empty
}

/**
 * Hunk/line staging and discard (ADR-0020). Addressing model: the renderer
 * sends indices only; the core re-derives the diff and builds the patch.
 * `hunkIndex` is 0-based into the addressed file's hunks; `lineIndices` selects
 * changed lines by 0-based index into the hunk's line list (empty = whole hunk).
 */
export interface StageHunkRequest {
  repoId: string;
  path: string;
  hunkIndex: number;
  lineIndices: number[];
}

export interface StageHunkResponse {
  // empty
}

export interface UnstageHunkRequest {
  repoId: string;
  path: string;
  hunkIndex: number;
  lineIndices: number[];
}

export interface UnstageHunkResponse {
  // empty
}

export interface DiscardHunkRequest {
  repoId: string;
  path: string;
  hunkIndex: number;
  lineIndices: number[];
}

export interface DiscardHunkResponse {
  // empty
}

/** File-level discard (ADR-0020); the only discard that accepts untracked paths. */
export interface DiscardRequest {
  repoId: string;
  paths: string[];
}

export interface DiscardResponse {
  // empty
}

/**
 * Reset soft/mixed/hard (ADR-0021). proto-loader decodes the enum with
 * `enums: String`, so `mode` arrives as the enum value name on the wire.
 */
export type ResetMode =
  | 'RESET_MODE_UNSPECIFIED'
  | 'SOFT'
  | 'MIXED'
  | 'HARD'
  | 'UNRECOGNIZED';

export interface ResetRequest {
  repoId: string;
  /** oid hex or ref */
  to: string;
  mode: ResetMode;
}

export interface ResetResponse {
  // empty
}

export interface GetCommitStatsRequest {
  repoId: string;
  oids: string[];
}

export interface GetCommitStatsResponse {
  stats: CommitStats[];
}

export interface CommitRequest {
  repoId: string;
  message: string;
  author?: Signature | undefined;
}

export interface CheckoutRequest {
  repoId: string;
  refName: string;
  /** git checkout -f: discard tracked working-tree modifications. */
  force: boolean;
  /** git clean -fd before checkout: discard untracked files too. Implies force. */
  discardUntracked: boolean;
}

export interface CheckoutResponse {
  // empty
}

export interface StashPushRequest {
  repoId: string;
  /** optional; empty -> core picks a default */
  message: string;
}

export interface StashPushResponse {
  stash: Stash | undefined;
}

// --- Advanced-git mutations (ADR-028) --------------------------------------

/**
 * Merge strategy (ADR-028). proto-loader decodes the enum with `enums: String`,
 * so `strategy` arrives as the enum value name on the wire.
 */
export type MergeStrategy =
  | 'MERGE_STRATEGY_UNSPECIFIED'
  | 'MERGE'
  | 'NO_FF'
  | 'FF_ONLY'
  | 'SQUASH'
  | 'UNRECOGNIZED';

export interface CreateBranchRequest {
  repoId: string;
  name: string;
  startPoint: string;
  checkout: boolean;
}

export interface RenameBranchRequest {
  repoId: string;
  oldName: string;
  newName: string;
}

export interface DeleteBranchRequest {
  repoId: string;
  name: string;
  force: boolean;
}

export interface DeleteBranchResponse {
  // empty
}

export interface MergeRequest {
  repoId: string;
  ref: string;
  strategy: MergeStrategy;
  noCommit: boolean;
  message: string;
}

export interface MergeResponse {
  hasConflict: boolean;
  oid: string;
}

export interface CreateTagRequest {
  repoId: string;
  name: string;
  target: string;
  annotated: boolean;
  message: string;
  force: boolean;
}

export interface DeleteTagRequest {
  repoId: string;
  name: string;
}

export interface DeleteTagResponse {
  // empty
}

export interface StashApplyRequest {
  repoId: string;
  index: number;
  restoreIndex: boolean;
}

export interface StashApplyResponse {
  // empty
}

export interface StashPopRequest {
  repoId: string;
  index: number;
}

export interface StashPopResponse {
  // empty
}

export interface StashDropRequest {
  repoId: string;
  index: number;
}

export interface StashDropResponse {
  // empty
}

export interface FetchRequest {
  repoId: string;
  remote: string;
  /** Previously-deferred `fetch.prune` — `git fetch --prune`. */
  prune: boolean;
  /** Previously-deferred `fetch.tags` — `git fetch --tags`. */
  tags: boolean;
  /** Previously-deferred `fetch.overwriteTags` — `git fetch --force`. */
  force: boolean;
}

export interface PushRequest {
  repoId: string;
  remote: string;
  branch: string;
  /** Target remote branch when it differs from `branch`; empty = same name. */
  remoteBranch: string;
  /** Previously-deferred `push.track` — `git push --set-upstream`. */
  setUpstream: boolean;
  /** Previously-deferred `push.tags` — `git push --tags`. */
  tags: boolean;
  /** Previously-deferred `push.force` — `git push --force`. */
  force: boolean;
}

export interface PullRequest {
  repoId: string;
  remote: string;
  branch: string;
  /** Local branch to integrate into; empty = currently checked-out branch. */
  localBranch: string;
  /** Previously-deferred `pull.commitMerged` — `git pull --no-commit`. */
  noCommit: boolean;
  /** Previously-deferred `pull.includeMergedMessages` — `git pull --log`. */
  log: boolean;
  /** Previously-deferred `pull.noFF` — `git pull --no-ff`. */
  noFf: boolean;
  /** Previously-deferred `pull.rebase` — `git pull --rebase`. */
  rebase: boolean;
}

export interface Progress {
  percent: number;
  message: string;
}

export interface WatchRequest {
  repoId: string;
}

export interface FsChangedEvent {
  repoId: string;
  paths: string[];
}

// --- git-flow presets (ADR-027) --------------------------------------------

/**
 * git-flow workflow kind (ADR-027). proto-loader decodes the enum with
 * `enums: String`, so `kind` arrives as the enum value name on the wire.
 */
export type GitFlowKind =
  | 'GIT_FLOW_KIND_UNSPECIFIED'
  | 'FEATURE'
  | 'RELEASE'
  | 'HOTFIX'
  | 'UNRECOGNIZED';

export interface GitFlowConfig {
  /** default "main" */
  mainBranch: string;
  /** default "develop" */
  developBranch: string;
  /** default "feature/" */
  featurePrefix: string;
  /** default "release/" */
  releasePrefix: string;
  /** default "hotfix/" */
  hotfixPrefix: string;
  /** default "v" */
  versionTagPrefix: string;
}

export interface GetGitFlowConfigRequest {
  repoId: string;
}

export interface SetGitFlowConfigRequest {
  repoId: string;
  config: GitFlowConfig | undefined;
}

export interface StartGitFlowRequest {
  repoId: string;
  kind: GitFlowKind;
  name: string;
  /** Optional start-point override; empty uses the kind's base branch. */
  base: string;
}

export interface FinishGitFlowRequest {
  repoId: string;
  kind: GitFlowKind;
  name: string;
  deleteBranch: boolean;
}

/**
 * Result of a git-flow start/finish. `branch` is the workflow branch that was
 * created/finished, `steps` the operations performed in order; `hasConflict`
 * is true when a merge stopped on conflict (tree left conflicted).
 */
export interface GitFlowResult {
  branch: string;
  steps: string[];
  hasConflict: boolean;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Renderer-facing error envelope (errors.proto `AppError`). */
export interface AppError {
  code: string;
  message: string;
  /**
   * Structured error payload. `errors.proto` types this as `map<string,string>`
   * but the `x-app-error-details` trailer carries arbitrary JSON, so values are
   * kept open to avoid a dishonest cast. Never place secrets here.
   */
  details: Record<string, unknown>;
}

export interface GoCoreClientOptions {
  /** Directory containing libs/contracts/proto (gitcore.proto + imports). */
  protoDir: string;
  /** Per-call deadline in milliseconds (default 10s). */
  callTimeoutMs?: number;
  /**
   * Per-call deadline for server-streaming RPCs (Fetch/Push/Pull), in ms.
   * Defaults to `DEFAULT_STREAM_TIMEOUT_MS` (30 min). Remote operations can
   * legitimately run for minutes, so the short unary default must NOT be
   * applied to a stream; the deadline only ensures a stalled transport
   * eventually rejects with DEADLINE_EXCEEDED instead of leaving the promise
   * pending forever and wedging the renderer. Pass `0` to disable it explicitly.
   */
  streamTimeoutMs?: number;
  /**
   * Which `singularitree.v1` service to bind to. Defaults to `'GitCore'`;
   * the supervisor creates a second client with `'Auth'`.
   */
  serviceName?: 'GitCore' | 'Auth';
}

const DEFAULT_CALL_TIMEOUT_MS = 10_000;

/**
 * Default deadline for server-streaming RPCs (30 minutes). Generous enough for
 * large fetches/pushes yet bounded so a stalled transport cannot hang forever;
 * override per client with `streamTimeoutMs`, or pass `0` to disable.
 */
export const DEFAULT_STREAM_TIMEOUT_MS = 1_800_000;

/**
 * Handle for a long-lived (background) server-streaming call opened with
 * {@link GoCoreClient.openStream}. Cancelling is idempotent and suppresses the
 * expected CANCELLED error that grpc-js emits on teardown.
 */
export interface StreamHandle {
  cancel(): void;
}

function notConnectedError(): AppError {
  return {
    code: 'GO_CORE_UNAVAILABLE',
    message: 'Go core gRPC client is not connected',
    details: {},
  };
}

/** Trailing-metadata key carrying the domain `AppError.code` (ipc-strategy.md §2.5). */
const APP_ERROR_CODE_TRAILER = 'x-app-error-code';
/** Trailing-metadata key carrying structured JSON `AppError.details` (ipc-strategy.md §2.5). */
const APP_ERROR_DETAILS_TRAILER = 'x-app-error-details';

/** Parse the `x-app-error-details` trailer; `{}` when absent or not a JSON object. */
function parseErrorDetails(metadata: grpc.Metadata | undefined): Record<string, unknown> {
  const raw = metadata?.get(APP_ERROR_DETAILS_TRAILER)?.[0];
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString());
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid JSON — fall through to the empty default.
  }
  return {};
}

export function normalizeGrpcError(err: grpc.ServiceError): AppError {
  const statusByName = grpc.status as unknown as Record<number, string>;
  const codeName =
    typeof err.code === 'number' ? statusByName[err.code] : undefined;
  // Go attaches the domain code as trailing metadata. Prefer it so rich codes
  // (e.g. NOT_A_GIT_REPO) survive instead of collapsing to the gRPC status name
  // (INVALID_ARGUMENT). Fall back to the status-name mapping when absent.
  const trailerValue = err.metadata?.get(APP_ERROR_CODE_TRAILER)?.[0];
  const domainCode =
    trailerValue === undefined ? undefined : trailerValue.toString();
  return {
    code: domainCode || codeName || `GRPC_${String(err.code ?? 'UNKNOWN')}`,
    message: err.details || err.message || 'gRPC call failed',
    details: parseErrorDetails(err.metadata),
  };
}

interface NestedGrpcObject {
  singularitree?: {
    v1?: Record<string, grpc.ServiceClientConstructor | undefined>;
  };
}

/**
 * Thin promise wrapper over a dynamically-built gRPC GitCore client.
 * One instance == one connection. `connect()` may be called again to replace
 * the underlying channel (used by the supervisor on token rotation/restart).
 */
export class GoCoreClient {
  private client: grpc.Client | null = null;
  private metadata: grpc.Metadata | null = null;
  private target = '';
  private connected = false;
  private readonly callTimeoutMs: number;
  private readonly streamTimeoutMs: number;
  private readonly serviceCtor: grpc.ServiceClientConstructor;

  constructor(private readonly opts: GoCoreClientOptions) {
    if (!opts.protoDir) {
      throw new Error('GoCoreClient: protoDir is required');
    }
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.streamTimeoutMs = opts.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;

    const packageDefinition = protoLoader.loadSync([...GIT_CORE_PROTO_FILES], {
      includeDirs: [opts.protoDir],
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const loaded = grpc.loadPackageDefinition(
      packageDefinition,
    ) as unknown as NestedGrpcObject;
    const serviceName = opts.serviceName ?? 'GitCore';
    const serviceCtor = loaded.singularitree?.v1?.[serviceName];
    if (typeof serviceCtor !== 'function') {
      throw new Error(
        `GoCoreClient: singularitree.v1.${serviceName} service not found in protoDir ` +
          opts.protoDir,
      );
    }
    this.serviceCtor = serviceCtor;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get currentTarget(): string {
    return this.target;
  }

  /** Connect (or reconnect) to `addr` authenticating with `token`. */
  connect(addr: string, token: string): void {
    this.close();
    this.target = addr;
    const metadata = new grpc.Metadata();
    metadata.set('authorization', `Bearer ${token}`);
    this.metadata = metadata;
    this.client = new this.serviceCtor(addr, grpc.credentials.createInsecure());
    this.connected = true;
  }

  /** Tear down the channel. Safe to call multiple times. */
  close(): void {
    this.connected = false;
    this.metadata = null;
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }

  /**
   * Fresh per-call metadata cloned from the token-bearing instance.
   *
   * gRPC metadata is mutated by the library during a call; a server-streaming
   * call is long-lived and may overlap other calls, so it must never share the
   * single `this.metadata` instance. Returns `null` when not connected.
   */
  private newMetadata(): grpc.Metadata | null {
    const current = this.metadata;
    if (!current) return null;
    const clone = new grpc.Metadata();
    for (const [key, value] of Object.entries(current.getMap())) {
      clone.set(key, value);
    }
    return clone;
  }

  /** Health check — real gRPC `Ping` (supervisor heartbeat). */
  ping(): Promise<PingResponse> {
    return this.unary<PingResponse>('Ping', {});
  }

  openRepository(req: OpenRepositoryRequest): Promise<Repository> {
    return this.unary<Repository>('OpenRepository', req);
  }

  listRepositories(
    req: ListRepositoriesRequest,
  ): Promise<ListRepositoriesResponse> {
    return this.unary<ListRepositoriesResponse>('ListRepositories', req);
  }

  removeRepository(
    req: RemoveRepositoryRequest,
  ): Promise<RemoveRepositoryResponse> {
    return this.unary<RemoveRepositoryResponse>('RemoveRepository', req);
  }

  getCommits(req: GetCommitsRequest): Promise<GetCommitsResponse> {
    return this.unary<GetCommitsResponse>('GetCommits', req);
  }

  getBranches(req: GetBranchesRequest): Promise<GetBranchesResponse> {
    return this.unary<GetBranchesResponse>('GetBranches', req);
  }

  getRemotes(req: GetRemotesRequest): Promise<GetRemotesResponse> {
    return this.unary<GetRemotesResponse>('GetRemotes', req);
  }

  getTags(req: GetTagsRequest): Promise<GetTagsResponse> {
    return this.unary<GetTagsResponse>('GetTags', req);
  }

  getStashes(req: GetStashesRequest): Promise<GetStashesResponse> {
    return this.unary<GetStashesResponse>('GetStashes', req);
  }

  getStatus(req: GetStatusRequest): Promise<GetStatusResponse> {
    return this.unary<GetStatusResponse>('GetStatus', req);
  }

  getDiff(req: GetDiffRequest): Promise<Diff> {
    return this.unary<Diff>('GetDiff', req);
  }

  stage(req: StageRequest): Promise<StageResponse> {
    return this.unary<StageResponse>('Stage', req);
  }

  unstage(req: UnstageRequest): Promise<UnstageResponse> {
    return this.unary<UnstageResponse>('Unstage', req);
  }

  stageHunk(req: StageHunkRequest): Promise<StageHunkResponse> {
    return this.unary<StageHunkResponse>('StageHunk', req);
  }

  unstageHunk(req: UnstageHunkRequest): Promise<UnstageHunkResponse> {
    return this.unary<UnstageHunkResponse>('UnstageHunk', req);
  }

  discardHunk(req: DiscardHunkRequest): Promise<DiscardHunkResponse> {
    return this.unary<DiscardHunkResponse>('DiscardHunk', req);
  }

  discard(req: DiscardRequest): Promise<DiscardResponse> {
    return this.unary<DiscardResponse>('Discard', req);
  }

  reset(req: ResetRequest): Promise<ResetResponse> {
    return this.unary<ResetResponse>('Reset', req);
  }

  getCommitStats(req: GetCommitStatsRequest): Promise<GetCommitStatsResponse> {
    return this.unary<GetCommitStatsResponse>('GetCommitStats', req);
  }

  commit(req: CommitRequest): Promise<Commit> {
    return this.unary<Commit>('Commit', req);
  }

  checkout(req: CheckoutRequest): Promise<CheckoutResponse> {
    return this.unary<CheckoutResponse>('Checkout', req);
  }

  stashPush(req: StashPushRequest): Promise<StashPushResponse> {
    return this.unary<StashPushResponse>('StashPush', req);
  }

  createBranch(req: CreateBranchRequest): Promise<Branch> {
    return this.unary<Branch>('CreateBranch', req);
  }

  renameBranch(req: RenameBranchRequest): Promise<Branch> {
    return this.unary<Branch>('RenameBranch', req);
  }

  deleteBranch(req: DeleteBranchRequest): Promise<DeleteBranchResponse> {
    return this.unary<DeleteBranchResponse>('DeleteBranch', req);
  }

  merge(req: MergeRequest): Promise<MergeResponse> {
    return this.unary<MergeResponse>('Merge', req);
  }

  createTag(req: CreateTagRequest): Promise<Tag> {
    return this.unary<Tag>('CreateTag', req);
  }

  deleteTag(req: DeleteTagRequest): Promise<DeleteTagResponse> {
    return this.unary<DeleteTagResponse>('DeleteTag', req);
  }

  stashApply(req: StashApplyRequest): Promise<StashApplyResponse> {
    return this.unary<StashApplyResponse>('StashApply', req);
  }

  stashPop(req: StashPopRequest): Promise<StashPopResponse> {
    return this.unary<StashPopResponse>('StashPop', req);
  }

  stashDrop(req: StashDropRequest): Promise<StashDropResponse> {
    return this.unary<StashDropResponse>('StashDrop', req);
  }

  getGitFlowConfig(req: GetGitFlowConfigRequest): Promise<GitFlowConfig> {
    return this.unary<GitFlowConfig>('GetGitFlowConfig', req);
  }

  setGitFlowConfig(req: SetGitFlowConfigRequest): Promise<GitFlowConfig> {
    return this.unary<GitFlowConfig>('SetGitFlowConfig', req);
  }

  startGitFlow(req: StartGitFlowRequest): Promise<GitFlowResult> {
    return this.unary<GitFlowResult>('StartGitFlow', req);
  }

  finishGitFlow(req: FinishGitFlowRequest): Promise<GitFlowResult> {
    return this.unary<GitFlowResult>('FinishGitFlow', req);
  }

  /**
   * Drive a server-streaming GitCore RPC (Fetch/Push/Pull) to completion.
   *
   * grpc-js exposes a server-streaming method as
   * `(request, metadata, options) => ClientReadableStream` with NO callback.
   * Each `data` message is passed to `onProgress`; the promise rejects with a
   * normalized `AppError` on stream `error` and resolves on `end` (EOF), so the
   * renderer's `Promise<void>` contract holds.
   */
  invokeStream(
    rpcName: RpcName | string,
    payload: unknown,
    onProgress: (progress: Progress) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const client = this.client;
      const metadata = this.newMetadata();
      if (!client || !metadata) {
        reject(notConnectedError());
        return;
      }
      const method = (client as unknown as Record<string, unknown>)[rpcName];
      if (typeof method !== 'function') {
        reject({
          code: 'UNKNOWN_RPC',
          message: `Unknown gRPC method: ${rpcName}`,
          details: {},
        } as AppError);
        return;
      }
      // Generous but bounded deadline: remote git operations may run for
      // minutes, but a stalled transport must eventually fail rather than
      // leave the renderer's `running()` state wedged forever.
      const options: grpc.CallOptions = {};
      if (this.streamTimeoutMs > 0) {
        options.deadline = new Date(Date.now() + this.streamTimeoutMs);
      }
      const call = (method as (
        request: unknown,
        md: grpc.Metadata,
        options: grpc.CallOptions,
      ) => grpc.ClientReadableStream<Progress>).call(
        client,
        payload ?? {},
        metadata,
        options,
      );
      call.on('data', (msg: Progress) => {
        onProgress({ percent: msg.percent, message: msg.message });
      });
      call.on('error', (err: grpc.ServiceError) => {
        reject(normalizeGrpcError(err));
      });
      call.on('end', () => {
        resolve();
      });
    });
  }

  /**
   * Open a long-lived server-streaming call and hand each decoded message to
   * `onData`; the returned {@link StreamHandle} cancels the call.
   *
   * Unlike {@link invokeStream}, this owns no promise: the caller owns the
   * stream lifecycle. It is used by the supervisor for `Watch`, which runs for
   * the lifetime of the repository and must therefore NOT get the bounded
   * `streamTimeoutMs` deadline (a watch that expires would silently stop
   * delivering changes). `onError` receives a normalized `AppError`; errors
   * after `cancel()` are deliberately suppressed because grpc-js reports
   * CANCELLED on every teardown.
   *
   * Throws synchronously when not connected or when `rpcName` is not a method
   * on the bound service.
   */
  openStream<T>(
    rpcName: RpcName | string,
    payload: unknown,
    onData: (msg: T) => void,
    onError?: (err: AppError) => void,
  ): StreamHandle {
    const client = this.client;
    const metadata = this.newMetadata();
    if (!client || !metadata) {
      throw notConnectedError();
    }
    const method = (client as unknown as Record<string, unknown>)[rpcName];
    if (typeof method !== 'function') {
      throw {
        code: 'UNKNOWN_RPC',
        message: `Unknown gRPC method: ${rpcName}`,
        details: {},
      } as AppError;
    }
    // No deadline: a background watch is long-lived. An empty options object
    // still routes through the server-streaming signature (request, md, options).
    const call = (method as (
      request: unknown,
      md: grpc.Metadata,
      options: grpc.CallOptions,
    ) => grpc.ClientReadableStream<T>).call(client, payload ?? {}, metadata, {});

    let cancelled = false;
    call.on('data', (msg: T) => {
      if (!cancelled) onData(msg);
    });
    call.on('error', (err: grpc.ServiceError) => {
      if (cancelled) return;
      onError?.(normalizeGrpcError(err));
    });
    return {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        try {
          call.cancel();
        } catch {
          // Already closed — nothing to do.
        }
      },
    };
  }

  /**
   * Generic unary dispatch used by the supervisor for the channel→RPC map.
   *
   * `StreamCommits` remains unimplemented over IPC and rejects promptly with
   * `NOT_IMPLEMENTED` (an honest error beats a promise that hangs). The
   * `Fetch` / `Push` / `Pull` streams are real now: they route through
   * `invokeStream` here with a no-op sink. The supervisor calls `invokeStream`
   * directly so it can forward progress to the renderer. `Watch` is a
   * background stream the supervisor opens via {@link openStream}
   * (`Supervisor.startWatch`); the generic path below would await its
   * never-ending stream and is intentionally never used for it.
   */
  invoke(rpcName: RpcName | string, payload: unknown): Promise<unknown> {
    if (isUnimplementedStreamingRpc(rpcName)) {
      return Promise.reject({
        code: 'NOT_IMPLEMENTED',
        message: `${rpcName} streaming is not implemented`,
        details: {},
      } as AppError);
    }
    if (isStreamingRpc(rpcName)) {
      return this.invokeStream(rpcName, payload, () => {
        // Progress is dropped on the generic path; supervisor uses invokeStream.
      });
    }
    return this.unary<unknown>(rpcName, payload);
  }

  private unary<TResponse>(rpcName: string, payload: unknown): Promise<TResponse> {
    return new Promise<TResponse>((resolve, reject) => {
      const client = this.client;
      const metadata = this.metadata;
      if (!client || !metadata) {
        reject(notConnectedError());
        return;
      }
      const method = (client as unknown as Record<string, unknown>)[rpcName];
      if (typeof method !== 'function') {
        reject({
          code: 'UNKNOWN_RPC',
          message: `Unknown gRPC method: ${rpcName}`,
          details: {},
        } as AppError);
        return;
      }
      const deadline = new Date(Date.now() + this.callTimeoutMs);
      (method as (
        request: unknown,
        md: grpc.Metadata,
        options: grpc.CallOptions,
        cb: (err: grpc.ServiceError | null, res: TResponse) => void,
      ) => void).call(
        client,
        payload ?? {},
        metadata,
        { deadline },
        (err: grpc.ServiceError | null, res: TResponse) => {
          if (err) {
            reject(normalizeGrpcError(err));
          } else {
            resolve(res);
          }
        },
      );
    });
  }
}
