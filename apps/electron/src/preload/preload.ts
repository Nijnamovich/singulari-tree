import { contextBridge, ipcRenderer } from 'electron';

// IMPORTANT: this preload runs in a `sandbox: true` renderer, whose `require`
// shim CANNOT resolve relative modules (`module not found: ../ipc/channels`).
// Importing project modules here therefore silently kills `contextBridge`
// (the whole `window.gitClientApi` surface disappears) with no type/build error.
// Channel names below are consequently inlined string literals — keep them in
// sync with `src/ipc/channels.ts` (the SSOT); `ipc-bridge.service.ts` mirrors
// the same surface for the renderer.

// Single contextBridge.exposeInMainWorld per ipc-strategy.md §1.2 / ADR-005.
//
// NOTE on the `rootDir` boundary: this file is compiled by apps/electron's
// tsconfig which pins `rootDir: src`, so it cannot import the generated
// contracts at libs/contracts/gen/ts/*.ts (outside rootDir). The interfaces
// below mirror those generated types 1:1 and are the concrete, `unknown`-free
// surface the Angular IpcBridge codes against. The wire contract itself is
// enforced at runtime by @grpc/proto-loader in src/main/go-core-client.ts
// (SSOT: libs/contracts/proto/*.proto).

// --- Wire types (mirror libs/contracts/gen/ts/{domain,gitcore}.ts) ---------

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

export interface FileStatus {
  path: string;
  staged: string;
  unstaged: string;
  isStaged: boolean;
  isConflicted: boolean;
}

export interface OpenRepositoryRequest {
  fsPath: string;
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

/**
 * Repoint a tracked repository at a different filesystem path (P4.1 polish):
 * the folder was moved/renamed and the registration must follow it — same id,
 * preserved `created_at` — instead of being deleted and re-created. Mirrors
 * `libs/contracts/gen/ts/gitcore.ts`.
 */
export interface RelocateRepositoryRequest {
  repoId: string;
  fsPath: string;
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

export interface UnstageRequest {
  repoId: string;
  paths: string[];
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

export interface UnstageHunkRequest {
  repoId: string;
  path: string;
  hunkIndex: number;
  lineIndices: number[];
}

export interface DiscardHunkRequest {
  repoId: string;
  path: string;
  hunkIndex: number;
  lineIndices: number[];
}

/** File-level discard (ADR-0020); the only discard that accepts untracked paths. */
export interface DiscardRequest {
  repoId: string;
  paths: string[];
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

/** Per-commit change-size counts (ADR-0023); counts only, never Git objects. */
export interface CommitStats {
  oid: string;
  additions: number;
  deletions: number;
  filesChanged: number;
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

// --- Cherry-pick / revert (ADR-0042) ---------------------------------------

/**
 * Cherry-pick ONE commit onto the current branch (ADR-0042). `source` is a
 * single bare revision string — sha, short sha, local branch, remote-tracking
 * ref, tag or rev expression — resolved to a commit inside the core; the
 * renderer never builds a git command. `recordOrigin` maps to `-x` (append the
 * picked commit's subject to the new message) and `noCommit` to `--no-commit`
 * (leave the change staged, commit nothing).
 */
export interface CherryPickRequest {
  repoId: string;
  source: string;
  recordOrigin: boolean;
  noCommit: boolean;
}

/**
 * Conflict is data, not an error (same envelope as `MergeResponse`): the tree
 * is left conflicted and `GetStatus` reports it. `oid` is the resulting commit —
 * on conflict the pre-existing HEAD, since nothing was committed. The typed
 * `CHERRY_PICK_CONFLICT` / `REVERT_CONFLICT` code rides the error trailer.
 */
export interface CherryPickResponse {
  hasConflict: boolean;
  oid: string;
}

/** Revert ONE commit on the current branch (ADR-0042); `source` as above. */
export interface RevertRequest {
  repoId: string;
  source: string;
}

/** Revert result — conflict is data, as in `CherryPickResponse`. */
export interface RevertResponse {
  hasConflict: boolean;
  oid: string;
}

/**
 * Read-only revision → commit resolution for the cherry-pick/revert preview
 * (ADR-0042). An unresolvable revision is `COMMIT_NOT_FOUND`.
 */
export interface ResolveRevisionRequest {
  repoId: string;
  revision: string;
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

/** Starts the background `Watch` server-stream for one repo (mirrors proto). */
export interface WatchRequest {
  repoId: string;
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

/** Command acknowledgements (empty proto messages). */
export interface CommandAck {
  // empty
}

export interface RepoChangedPayload {
  repoId: string;
  reason: 'commit' | 'checkout' | 'fetch' | 'watcher';
}

export interface FsChangedPayload {
  repoId: string;
  paths: string[];
}

export interface ProgressPayload {
  op: string;
  percent: number;
  message: string;
}

// --- Auth wire types (mirror libs/contracts/gen/ts/auth.ts) ----------------

/** AuthSource enumerates how the token was obtained (proto enum as strings). */
export type AuthSource =
  | 'AUTH_SOURCE_UNSPECIFIED'
  | 'AUTH_SOURCE_NONE'
  | 'AUTH_SOURCE_GITHUB_CLI'
  | 'AUTH_SOURCE_OAUTH'
  | 'UNRECOGNIZED';

export interface RateLimit {
  /** "core" | "search" | ... */
  resource: string;
  limit: number;
  remaining: number;
  /** epoch seconds (X-RateLimit-Reset) */
  reset: number;
  /** RFC3339 */
  resetAt: string;
}

export interface AuthStatus {
  authenticated: boolean;
  source: AuthSource;
  accountLogin: string;
  name: string;
  avatarUrl: string;
  /** MAY BE EMPTY: gh token scopes may omit read:user */
  email: string;
  scopes: string[];
  rateLimit: RateLimit | undefined;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string;
  avatarUrl: string;
  email: string;
  htmlUrl: string;
}

/** Pagination metadata derived from the GitHub `Link` header (rel="next"). */
export interface PageInfo {
  page: number;
  perPage: number;
  /** 0 == no Link rel="next" */
  nextPage: number;
  hasMore: boolean;
  /** best-effort; 0 when GitHub omits it (/user/repos) */
  total: number;
}

export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  htmlUrl: string;
  description: string;
  language: string;
  stargazersCount: number;
  updatedAt: string;
  nodeId: string;
  defaultBranch: string;
  ownerLogin: string;
  ownerAvatarUrl: string;
  /** "public" | "private" | "internal" */
  visibility: string;
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  cloneUrl: string;
  sshUrl: string;
  gitUrl: string;
  pushedAt: string;
  createdAt: string;
  forksCount: number;
  openIssuesCount: number;
  topics: string[];
  licenseSpdxId: string;
  isTemplate: boolean;
  homepage: string;
}

export interface GetAuthStatusRequest {
  // empty
}

export interface GetAuthStatusResponse {
  authenticated: boolean;
  /** empty if not authenticated */
  login: string;
  status: AuthStatus | undefined;
}

export interface ConnectGitHubFromCLIRequest {
  /** empty -> resolve "gh" on PATH */
  ghBinary: string;
  /** true -> call GET /user to validate the token */
  verify: boolean;
}

export interface ConnectGitHubFromCLIResponse {
  status: AuthStatus | undefined;
  /** populated when verify=true */
  user: GitHubUser | undefined;
}

export interface ListGitHubReposRequest {
  /** default 30 */
  perPage: number;
  page: number;
  /** "updated" | "pushed" | "created" | "full_name" */
  sort: string;
  /** "asc" | "desc" */
  direction: string;
  /** "owner,collaborator,organization_member" */
  affiliation: string;
  /** "all" | "public" | "private" */
  visibility: string;
  /** "all" | "owner" | "public" | "private" | "member" */
  type: string;
}

export interface ListGitHubReposResponse {
  repos: GitHubRepo[];
  pageInfo: PageInfo | undefined;
  rateLimit: RateLimit | undefined;
}

export interface LogoutRequest {
  // empty
}

export interface LogoutResponse {
  // empty
}

// --- Native dialog wire types (local, non-gRPC — mirror src/ipc/dialog-handlers) ---

export interface ChooseDirectoryRequest {
  // empty
}

export interface ChooseDirectoryResponse {
  canceled: boolean;
  path: string;
}

// --- Native menu wire types (local, non-gRPC — mirror src/main/app-menu) ---

export interface MenuNavigatePayload {
  /** Renderer route the native menu asked to open (e.g. `/github-account`). */
  route: string;
}

/**
 * Normalized OS deep link pushed by the Electron main process (ADR-025).
 * Mirrors `apps/electron/src/main/deep-link.ts`; the shell validates and
 * normalizes before forwarding, the renderer routes to existing per-repo IPC.
 */
export type DeepLinkPayload =
  | { kind: 'open-path'; path: string }
  | { kind: 'open-commit'; repo: string; oid: string }
  | { kind: 'open-branch'; repo: string; branch: string }
  | { kind: 'clone'; url: string };

// --- Bridge surface --------------------------------------------------------

export interface GitClientApi {
  getCommits: (req: GetCommitsRequest) => Promise<GetCommitsResponse>;
  getBranches: (req: GetBranchesRequest) => Promise<GetBranchesResponse>;
  getRemotes: (req: GetRemotesRequest) => Promise<GetRemotesResponse>;
  getTags: (req: GetTagsRequest) => Promise<GetTagsResponse>;
  getStashes: (req: GetStashesRequest) => Promise<GetStashesResponse>;
  getStatus: (req: GetStatusRequest) => Promise<GetStatusResponse>;
  getDiff: (req: GetDiffRequest) => Promise<Diff>;
  stage: (req: StageRequest) => Promise<CommandAck>;
  unstage: (req: UnstageRequest) => Promise<CommandAck>;
  stageHunk: (req: StageHunkRequest) => Promise<CommandAck>;
  unstageHunk: (req: UnstageHunkRequest) => Promise<CommandAck>;
  discardHunk: (req: DiscardHunkRequest) => Promise<CommandAck>;
  discard: (req: DiscardRequest) => Promise<CommandAck>;
  reset: (req: ResetRequest) => Promise<CommandAck>;
  getCommitStats: (req: GetCommitStatsRequest) => Promise<GetCommitStatsResponse>;
  commit: (req: CommitRequest) => Promise<Commit>;
  checkout: (req: CheckoutRequest) => Promise<CommandAck>;
  stashPush: (req: StashPushRequest) => Promise<StashPushResponse>;
  // Advanced-git mutations (ADR-028): branch CRUD, merge, tag CRUD, stash ops.
  createBranch: (req: CreateBranchRequest) => Promise<Branch>;
  renameBranch: (req: RenameBranchRequest) => Promise<Branch>;
  deleteBranch: (req: DeleteBranchRequest) => Promise<DeleteBranchResponse>;
  merge: (req: MergeRequest) => Promise<MergeResponse>;
  // Cherry-pick / revert one commit + read-only revision resolution (ADR-0042).
  cherryPick: (req: CherryPickRequest) => Promise<CherryPickResponse>;
  revert: (req: RevertRequest) => Promise<RevertResponse>;
  resolveRevision: (req: ResolveRevisionRequest) => Promise<Commit>;
  createTag: (req: CreateTagRequest) => Promise<Tag>;
  deleteTag: (req: DeleteTagRequest) => Promise<DeleteTagResponse>;
  stashApply: (req: StashApplyRequest) => Promise<StashApplyResponse>;
  stashPop: (req: StashPopRequest) => Promise<StashPopResponse>;
  stashDrop: (req: StashDropRequest) => Promise<StashDropResponse>;
  // git-flow presets (ADR-027).
  getGitFlowConfig: (req: GetGitFlowConfigRequest) => Promise<GitFlowConfig>;
  setGitFlowConfig: (req: SetGitFlowConfigRequest) => Promise<GitFlowConfig>;
  startGitFlow: (req: StartGitFlowRequest) => Promise<GitFlowResult>;
  finishGitFlow: (req: FinishGitFlowRequest) => Promise<GitFlowResult>;
  // fetch/pull/push are server-streaming in proto; progress arrives via
  // `onProgress` and the invoke promise just signals completion. This mirrors
  // Angular's `IpcBridge` (`Promise<void>`), keeping the two separately-declared
  // surfaces aligned.
  fetch: (req: FetchRequest) => Promise<void>;
  pull: (req: PullRequest) => Promise<void>;
  push: (req: PushRequest) => Promise<void>;
  // Watch starts a background server-stream in the core (replace-any-existing).
  // Each change then arrives via `onFsChanged`; this invoke resolves an ack.
  watch: (req: WatchRequest) => Promise<CommandAck>;
  openRepository: (req: OpenRepositoryRequest) => Promise<Repository>;
  listRepositories: (req: ListRepositoriesRequest) => Promise<ListRepositoriesResponse>;
  removeRepository: (req: RemoveRepositoryRequest) => Promise<RemoveRepositoryResponse>;
  relocateRepository: (req: RelocateRepositoryRequest) => Promise<Repository>;
  getAuthStatus: (req: GetAuthStatusRequest) => Promise<GetAuthStatusResponse>;
  connectGitHubFromCLI: (
    req: ConnectGitHubFromCLIRequest,
  ) => Promise<ConnectGitHubFromCLIResponse>;
  listGitHubRepos: (req: ListGitHubReposRequest) => Promise<ListGitHubReposResponse>;
  logout: (req: LogoutRequest) => Promise<LogoutResponse>;
  /** Local (non-gRPC) native folder picker handled in Electron main. */
  chooseDirectory: (req: ChooseDirectoryRequest) => Promise<ChooseDirectoryResponse>;
  onRepoChanged: (cb: (payload: RepoChangedPayload) => void) => () => void;
  onFsChanged: (cb: (payload: FsChangedPayload) => void) => () => void;
  onProgress: (cb: (payload: ProgressPayload) => void) => () => void;
  /** Local (non-gRPC) push: native menu navigation intents. */
  onMenuNavigate: (cb: (payload: MenuNavigatePayload) => void) => () => void;
  /** Local (non-gRPC) push: validated OS deep links (channel `deeplink:open`). */
  onDeepLink: (cb: (payload: DeepLinkPayload) => void) => () => void;
  /**
   * Renderer → main readiness ack for deep-link delivery (channel
   * `deeplink:ready`). Sent once the renderer has subscribed to `onDeepLink`, so
   * the shell can drain its FIFO queue without racing `did-finish-load`.
   */
  signalDeepLinkReady: () => void;
}

const api: GitClientApi = {
  getCommits: (req) => ipcRenderer.invoke('git:getCommits', req),
  getBranches: (req) => ipcRenderer.invoke('git:getBranches', req),
  getRemotes: (req) => ipcRenderer.invoke('git:getRemotes', req),
  getTags: (req) => ipcRenderer.invoke('git:getTags', req),
  getStashes: (req) => ipcRenderer.invoke('git:getStashes', req),
  getStatus: (req) => ipcRenderer.invoke('git:getStatus', req),
  getDiff: (req) => ipcRenderer.invoke('git:getDiff', req),
  stage: (req) => ipcRenderer.invoke('git:stage', req),
  unstage: (req) => ipcRenderer.invoke('git:unstage', req),
  stageHunk: (req) => ipcRenderer.invoke('git:stageHunk', req),
  unstageHunk: (req) => ipcRenderer.invoke('git:unstageHunk', req),
  discardHunk: (req) => ipcRenderer.invoke('git:discardHunk', req),
  discard: (req) => ipcRenderer.invoke('git:discard', req),
  reset: (req) => ipcRenderer.invoke('git:reset', req),
  getCommitStats: (req) => ipcRenderer.invoke('git:getCommitStats', req),
  commit: (req) => ipcRenderer.invoke('git:commit', req),
  checkout: (req) => ipcRenderer.invoke('git:checkout', req),
  stashPush: (req) => ipcRenderer.invoke('git:stashPush', req),
  createBranch: (req) => ipcRenderer.invoke('git:createBranch', req),
  renameBranch: (req) => ipcRenderer.invoke('git:renameBranch', req),
  deleteBranch: (req) => ipcRenderer.invoke('git:deleteBranch', req),
  merge: (req) => ipcRenderer.invoke('git:merge', req),
  cherryPick: (req) => ipcRenderer.invoke('git:cherryPick', req),
  revert: (req) => ipcRenderer.invoke('git:revert', req),
  resolveRevision: (req) => ipcRenderer.invoke('git:resolveRevision', req),
  createTag: (req) => ipcRenderer.invoke('git:createTag', req),
  deleteTag: (req) => ipcRenderer.invoke('git:deleteTag', req),
  stashApply: (req) => ipcRenderer.invoke('git:stashApply', req),
  stashPop: (req) => ipcRenderer.invoke('git:stashPop', req),
  stashDrop: (req) => ipcRenderer.invoke('git:stashDrop', req),
  getGitFlowConfig: (req) => ipcRenderer.invoke('git:getGitFlowConfig', req),
  setGitFlowConfig: (req) => ipcRenderer.invoke('git:setGitFlowConfig', req),
  startGitFlow: (req) => ipcRenderer.invoke('git:startGitFlow', req),
  finishGitFlow: (req) => ipcRenderer.invoke('git:finishGitFlow', req),
  fetch: (req) => ipcRenderer.invoke('git:fetch', req),
  pull: (req) => ipcRenderer.invoke('git:pull', req),
  push: (req) => ipcRenderer.invoke('git:push', req),
  watch: (req) => ipcRenderer.invoke('git:watch', req),
  openRepository: (req) => ipcRenderer.invoke('git:openRepository', req),
  listRepositories: (req) => ipcRenderer.invoke('git:listRepositories', req),
  removeRepository: (req) => ipcRenderer.invoke('git:removeRepository', req),
  relocateRepository: (req) => ipcRenderer.invoke('git:relocateRepository', req),
  getAuthStatus: (req) => ipcRenderer.invoke('auth:getAuthStatus', req),
  connectGitHubFromCLI: (req) => ipcRenderer.invoke('auth:connectGitHubFromCLI', req),
  listGitHubRepos: (req) => ipcRenderer.invoke('auth:listGitHubRepos', req),
  logout: (req) => ipcRenderer.invoke('auth:logout', req),
  chooseDirectory: (req) => ipcRenderer.invoke('dialog:chooseDirectory', req),
  // Each subscription returns an unsubscribe that removes ONLY its own handler
  // (`removeAllListeners` would detach every other subscriber on the channel).
  onRepoChanged: (cb) => {
    const handler = (_e: unknown, payload: RepoChangedPayload) => cb(payload);
    ipcRenderer.on('repo:changed', handler);
    return () => ipcRenderer.removeListener('repo:changed', handler);
  },
  onFsChanged: (cb) => {
    const handler = (_e: unknown, payload: FsChangedPayload) => cb(payload);
    ipcRenderer.on('fs:changed', handler);
    return () => ipcRenderer.removeListener('fs:changed', handler);
  },
  onProgress: (cb) => {
    const handler = (_e: unknown, payload: ProgressPayload) => cb(payload);
    ipcRenderer.on('git:progress', handler);
    return () => ipcRenderer.removeListener('git:progress', handler);
  },
  onMenuNavigate: (cb) => {
    const handler = (_e: unknown, payload: MenuNavigatePayload) => cb(payload);
    ipcRenderer.on('menu:navigate', handler);
    return () => ipcRenderer.removeListener('menu:navigate', handler);
  },
  onDeepLink: (cb) => {
    const handler = (_e: unknown, payload: DeepLinkPayload) => cb(payload);
    ipcRenderer.on('deeplink:open', handler);
    return () => ipcRenderer.removeListener('deeplink:open', handler);
  },
  // Literal mirrors `DEEP_LINK_READY_CHANNEL` in src/ipc/channels.ts; inlined
  // because a sandboxed preload cannot require project modules (see top).
  signalDeepLinkReady: () => ipcRenderer.send('deeplink:ready'),
};

contextBridge.exposeInMainWorld('gitClientApi', api);

declare global {
  interface Window {
    gitClientApi: GitClientApi;
  }
}
