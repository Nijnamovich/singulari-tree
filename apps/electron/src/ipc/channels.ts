/**
 * Channel names + validation stub (ipc-strategy.md §1.2 — channels.ts).
 */

export const CHANNELS = {
  getCommits: 'git:getCommits',
  getBranches: 'git:getBranches',
  getRemotes: 'git:getRemotes',
  getTags: 'git:getTags',
  getStashes: 'git:getStashes',
  getStatus: 'git:getStatus',
  getDiff: 'git:getDiff',
  stage: 'git:stage',
  unstage: 'git:unstage',
  stageHunk: 'git:stageHunk',
  unstageHunk: 'git:unstageHunk',
  discardHunk: 'git:discardHunk',
  discard: 'git:discard',
  reset: 'git:reset',
  getCommitStats: 'git:getCommitStats',
  commit: 'git:commit',
  checkout: 'git:checkout',
  stashPush: 'git:stashPush',
  // Advanced-git mutations (ADR-028): branch CRUD, merge, tag CRUD, stash ops.
  createBranch: 'git:createBranch',
  renameBranch: 'git:renameBranch',
  deleteBranch: 'git:deleteBranch',
  merge: 'git:merge',
  // Cherry-pick / revert one commit + read-only revision resolution (ADR-0042).
  cherryPick: 'git:cherryPick',
  revert: 'git:revert',
  resolveRevision: 'git:resolveRevision',
  createTag: 'git:createTag',
  deleteTag: 'git:deleteTag',
  stashApply: 'git:stashApply',
  stashPop: 'git:stashPop',
  stashDrop: 'git:stashDrop',
  fetch: 'git:fetch',
  pull: 'git:pull',
  push: 'git:push',
  watch: 'git:watch',
  // git-flow presets (ADR-027).
  getGitFlowConfig: 'git:getGitFlowConfig',
  setGitFlowConfig: 'git:setGitFlowConfig',
  startGitFlow: 'git:startGitFlow',
  finishGitFlow: 'git:finishGitFlow',
  openRepository: 'git:openRepository',
  listRepositories: 'git:listRepositories',
  removeRepository: 'git:removeRepository',
  relocateRepository: 'git:relocateRepository',
  getAuthStatus: 'auth:getAuthStatus',
  connectGitHubFromCLI: 'auth:connectGitHubFromCLI',
  listGitHubRepos: 'auth:listGitHubRepos',
  logout: 'auth:logout',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

/**
 * Local (non-gRPC) channels handled entirely in Electron main.
 *
 * These MUST NOT be added to `CHANNELS`/`CHANNEL_TO_RPC`: those maps are the
 * strict Go RPC surface (`satisfies Record<ChannelName, string>`) and every
 * entry is forwarded to the Go core via `Supervisor.forwardToGo`. Dialog
 * channels are native Electron work (e.g. `dialog.showOpenDialog`) and never
 * cross the gRPC boundary.
 */
export const DIALOG_CHANNELS = {
  chooseDirectory: 'dialog:chooseDirectory',
} as const;

export type DialogChannelName = (typeof DIALOG_CHANNELS)[keyof typeof DIALOG_CHANNELS];

/**
 * Local (non-gRPC) push channels: Electron main → renderer navigation intents.
 *
 * `menu:navigate` is a one-way push (no `ipcMain.handle`); the preload exposes
 * `onMenuNavigate` so the renderer can subscribe. It intentionally lives outside
 * `CHANNELS`/`CHANNEL_TO_RPC`, which are the strict Go RPC surface.
 */
export const MENU_CHANNELS = {
  navigate: 'menu:navigate',
} as const;

export type MenuChannelName = (typeof MENU_CHANNELS)[keyof typeof MENU_CHANNELS];

/**
 * Renderer → main readiness ack for deep-link delivery (ADR-025).
 *
 * A one-way, non-RPC signal (never an `ipcMain.handle` target), so it stays
 * outside `CHANNELS`/`CHANNEL_TO_RPC` and does not alter the frozen 46-channel
 * RPC surface. The renderer sends it once its Angular bootstrap has subscribed
 * to the `deeplink:open` event, letting the shell drain its queued links in
 * order without racing `did-finish-load`.
 */
export const DEEP_LINK_READY_CHANNEL = 'deeplink:ready';

/**
 * IPC channel → owning service RPC method (`git:*` → `singularitree.v1.GitCore`,
 * `auth:*` → `singularitree.v1.Auth`; see `AUTH_CHANNELS`).
 *
 * Frozen surface consumed by the Angular IpcBridge — map keys are the channel
 * values so `satisfies Record<ChannelName, ...>` enforces exhaustiveness at
 * compile time (mapping drift is also asserted in test/channels.test.ts).
 */
export const CHANNEL_TO_RPC = {
  [CHANNELS.getCommits]: 'GetCommits',
  [CHANNELS.getBranches]: 'GetBranches',
  [CHANNELS.getRemotes]: 'GetRemotes',
  [CHANNELS.getTags]: 'GetTags',
  [CHANNELS.getStashes]: 'GetStashes',
  [CHANNELS.getStatus]: 'GetStatus',
  [CHANNELS.getDiff]: 'GetDiff',
  [CHANNELS.stage]: 'Stage',
  [CHANNELS.unstage]: 'Unstage',
  [CHANNELS.stageHunk]: 'StageHunk',
  [CHANNELS.unstageHunk]: 'UnstageHunk',
  [CHANNELS.discardHunk]: 'DiscardHunk',
  [CHANNELS.discard]: 'Discard',
  [CHANNELS.reset]: 'Reset',
  [CHANNELS.getCommitStats]: 'GetCommitStats',
  [CHANNELS.commit]: 'Commit',
  [CHANNELS.checkout]: 'Checkout',
  [CHANNELS.stashPush]: 'StashPush',
  [CHANNELS.createBranch]: 'CreateBranch',
  [CHANNELS.renameBranch]: 'RenameBranch',
  [CHANNELS.deleteBranch]: 'DeleteBranch',
  [CHANNELS.merge]: 'Merge',
  [CHANNELS.cherryPick]: 'CherryPick',
  [CHANNELS.revert]: 'Revert',
  [CHANNELS.resolveRevision]: 'ResolveRevision',
  [CHANNELS.createTag]: 'CreateTag',
  [CHANNELS.deleteTag]: 'DeleteTag',
  [CHANNELS.stashApply]: 'StashApply',
  [CHANNELS.stashPop]: 'StashPop',
  [CHANNELS.stashDrop]: 'StashDrop',
  [CHANNELS.fetch]: 'Fetch',
  [CHANNELS.pull]: 'Pull',
  [CHANNELS.push]: 'Push',
  [CHANNELS.watch]: 'Watch',
  [CHANNELS.getGitFlowConfig]: 'GetGitFlowConfig',
  [CHANNELS.setGitFlowConfig]: 'SetGitFlowConfig',
  [CHANNELS.startGitFlow]: 'StartGitFlow',
  [CHANNELS.finishGitFlow]: 'FinishGitFlow',
  [CHANNELS.openRepository]: 'OpenRepository',
  [CHANNELS.listRepositories]: 'ListRepositories',
  [CHANNELS.removeRepository]: 'RemoveRepository',
  [CHANNELS.relocateRepository]: 'RelocateRepository',
  [CHANNELS.getAuthStatus]: 'GetAuthStatus',
  [CHANNELS.connectGitHubFromCLI]: 'ConnectGitHubFromCLI',
  [CHANNELS.listGitHubRepos]: 'ListGitHubRepos',
  [CHANNELS.logout]: 'Logout',
} as const satisfies Record<ChannelName, string>;

export type ChannelRpcName = (typeof CHANNEL_TO_RPC)[ChannelName];

/**
 * Channels routed to the `singularitree.v1.Auth` service (all unary).
 *
 * `Supervisor.forwardToGo` uses this to pick the Auth gRPC client instead of the
 * GitCore one. Auth RPCs are deliberately absent from `STREAMING_RPCS` below —
 * every Auth method is unary.
 */
export const AUTH_CHANNELS: ReadonlySet<string> = new Set<string>([
  CHANNELS.getAuthStatus,
  CHANNELS.connectGitHubFromCLI,
  CHANNELS.listGitHubRepos,
  CHANNELS.logout,
]);

/**
 * Server-streaming RPCs — declared `returns (stream ...)` in gitcore.proto.
 *
 * `Fetch` / `Push` / `Pull` are driven for real by `GoCoreClient.invokeStream`:
 * the supervisor forwards each `Progress` message to the renderer over the
 * `git:progress` event, and the invoke promise settles at stream EOF / error.
 *
 * `Watch` is a server-stream too, but a **background, never-ending** one. It is
 * started by the supervisor via `GoCoreClient.openStream` on the `git:watch`
 * channel and each `FsChangedEvent` is pushed to the renderer over the
 * `fs:changed` event; the `git:watch` invoke resolves with an ack immediately
 * and MUST NOT await the stream (see `Supervisor.startWatch`). A new
 * `git:watch` replaces any previous stream (replace-any-existing), and the
 * previous stream is also cancelled by `Supervisor.stop()` (and on child loss);
 * closing the gRPC client cancels its streams too.
 *
 * `StreamCommits` is still not wired over IPC (see
 * `UNIMPLEMENTED_STREAMING_RPCS`); the unary callback path cannot drive it
 * because its callback never settles, so `invoke()` rejects it promptly rather
 * than hanging forever.
 */
export const STREAMING_RPCS = new Set<string>([
  'StreamCommits',
  'Fetch',
  'Push',
  'Pull',
  'Watch',
]);

/**
 * Server-streaming RPCs with no IPC wiring yet. `GoCoreClient.invoke` rejects
 * these with `NOT_IMPLEMENTED` instead of hanging on the unary callback path.
 */
export const UNIMPLEMENTED_STREAMING_RPCS = new Set<string>(['StreamCommits']);

/** True when `rpc` is a server-streaming GitCore method. */
export function isStreamingRpc(rpc: string): boolean {
  return STREAMING_RPCS.has(rpc);
}

/** True when `rpc` is a server-streaming method still unimplemented over IPC. */
export function isUnimplementedStreamingRpc(rpc: string): boolean {
  return UNIMPLEMENTED_STREAMING_RPCS.has(rpc);
}

export function isValidChannel(channel: string): channel is ChannelName {
  return (Object.values(CHANNELS) as string[]).includes(channel);
}

// Minimal validation stub — real implementation uses zod/io-ts per spec.
// Throws if payload is not an object; extend per-channel schemas as needed.
export function validate(channel: ChannelName, payload: unknown): void {
  if (payload !== undefined && payload !== null && typeof payload !== 'object') {
    throw new Error(`Invalid payload for ${channel}: expected object`);
  }
  // TODO: add zod schema per channel using runtime validation.
}
