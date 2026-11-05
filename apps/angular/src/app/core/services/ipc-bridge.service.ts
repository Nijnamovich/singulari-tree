import { Injectable } from '@angular/core';
import type {
  ConnectGitHubFromCLIRequest,
  ConnectGitHubFromCLIResponse,
  GetAuthStatusRequest,
  GetAuthStatusResponse,
  ListGitHubReposRequest,
  ListGitHubReposResponse,
  LogoutRequest,
  LogoutResponse,
} from '@contracts/auth';
import type { Branch, Commit, Diff, Repository, Tag } from '@contracts/domain';
import type {
  CheckoutRequest,
  CheckoutResponse,
  CherryPickRequest,
  CherryPickResponse,
  CommitRequest,
  CreateBranchRequest,
  CreateTagRequest,
  DeleteBranchRequest,
  DeleteBranchResponse,
  DeleteTagRequest,
  DeleteTagResponse,
  DiscardHunkRequest,
  DiscardHunkResponse,
  DiscardRequest,
  DiscardResponse,
  FetchRequest,
  FinishGitFlowRequest,
  FsChangedEvent,
  GetBranchesRequest,
  GetBranchesResponse,
  GetCommitStatsRequest,
  GetCommitStatsResponse,
  GetCommitsRequest,
  GetCommitsResponse,
  GetDiffRequest,
  GetGitFlowConfigRequest,
  GetRemotesRequest,
  GetRemotesResponse,
  GetStashesRequest,
  GetStashesResponse,
  GetStatusRequest,
  GetStatusResponse,
  GetTagsRequest,
  GetTagsResponse,
  GitFlowConfig,
  GitFlowResult,
  ListRepositoriesRequest,
  ListRepositoriesResponse,
  MergeRequest,
  MergeResponse,
  OpenRepositoryRequest,
  Progress,
  PullRequest,
  PushRequest,
  RemoveRepositoryRequest,
  RemoveRepositoryResponse,
  RelocateRepositoryRequest,
  RenameBranchRequest,
  ResetRequest,
  ResetResponse,
  ResolveRevisionRequest,
  RevertRequest,
  RevertResponse,
  SetGitFlowConfigRequest,
  StageHunkRequest,
  StageHunkResponse,
  StageRequest,
  StageResponse,
  StashApplyRequest,
  StashApplyResponse,
  StashDropRequest,
  StashDropResponse,
  StashPopRequest,
  StashPopResponse,
  StashPushRequest,
  StashPushResponse,
  StartGitFlowRequest,
  UnstageHunkRequest,
  UnstageHunkResponse,
  UnstageRequest,
  UnstageResponse,
  WatchRequest,
} from '@contracts/gitcore';

/**
 * Locally-defined request/response for the native folder picker. This is NOT a
 * proto type: the folder dialog is an Electron-shell concern, so it lives on the
 * preload bridge only (channel `dialog:chooseDirectory`).
 */
export interface ChooseDirectoryRequest {
  // No parameters: the dialog always picks a directory.
}

/** Result of the native folder picker; `path` is `''` when the user cancels. */
export interface ChooseDirectoryResponse {
  canceled: boolean;
  path: string;
}

/**
 * Payload pushed by the Electron main process when the OS-native File menu
 * requests navigation (channel `menu:navigate`). `route` is an absolute
 * renderer route such as `/github-account` or `/repos`.
 */
export interface MenuNavigatePayload {
  route: string;
}

/**
 * Normalized OS deep link pushed by the Electron main process (channel
 * `deeplink:open`, ADR-025). Mirrors `apps/electron/src/main/deep-link.ts`.
 */
export type DeepLinkPayload =
  | { kind: 'open-path'; path: string }
  | { kind: 'open-commit'; repo: string; oid: string }
  | { kind: 'open-branch'; repo: string; branch: string }
  | { kind: 'clone'; url: string };

// Typed mirror of the preload bridge (`window.gitClientApi`, ipc-strategy.md §1.2).
// Channel -> proto request/response pulled from the generated contracts. `fetch`,
// `pull` and `push` are server-streaming in proto; progress arrives via `onProgress`
// and the invoke promise resolves when the operation completes.
export interface GitClientApi {
  getCommits: (req: GetCommitsRequest) => Promise<GetCommitsResponse>;
  openRepository: (req: OpenRepositoryRequest) => Promise<Repository>;
  listRepositories: (req: ListRepositoriesRequest) => Promise<ListRepositoriesResponse>;
  removeRepository: (req: RemoveRepositoryRequest) => Promise<RemoveRepositoryResponse>;
  /**
   * Repoint a tracked repository at a new filesystem path (P4.1 polish). Same
   * repository id (`created_at` preserved); the core validates the target like
   * `openRepository` and rejects with `REPO_PATH_MISSING` / `NOT_A_GIT_REPO` /
   * `REPO_PATH_IN_USE`.
   */
  relocateRepository: (req: RelocateRepositoryRequest) => Promise<Repository>;
  getBranches: (req: GetBranchesRequest) => Promise<GetBranchesResponse>;
  getRemotes: (req: GetRemotesRequest) => Promise<GetRemotesResponse>;
  getTags: (req: GetTagsRequest) => Promise<GetTagsResponse>;
  getStashes: (req: GetStashesRequest) => Promise<GetStashesResponse>;
  getStatus: (req: GetStatusRequest) => Promise<GetStatusResponse>;
  getDiff: (req: GetDiffRequest) => Promise<Diff>;
  stage: (req: StageRequest) => Promise<StageResponse>;
  unstage: (req: UnstageRequest) => Promise<UnstageResponse>;
  stageHunk: (req: StageHunkRequest) => Promise<StageHunkResponse>;
  unstageHunk: (req: UnstageHunkRequest) => Promise<UnstageHunkResponse>;
  discardHunk: (req: DiscardHunkRequest) => Promise<DiscardHunkResponse>;
  discard: (req: DiscardRequest) => Promise<DiscardResponse>;
  reset: (req: ResetRequest) => Promise<ResetResponse>;
  getCommitStats: (req: GetCommitStatsRequest) => Promise<GetCommitStatsResponse>;
  commit: (req: CommitRequest) => Promise<Commit>;
  checkout: (req: CheckoutRequest) => Promise<CheckoutResponse>;
  stashPush: (req: StashPushRequest) => Promise<StashPushResponse>;
  // Advanced-git mutations (ADR-028): branch CRUD, merge, tag CRUD, stash ops.
  createBranch: (req: CreateBranchRequest) => Promise<Branch>;
  renameBranch: (req: RenameBranchRequest) => Promise<Branch>;
  deleteBranch: (req: DeleteBranchRequest) => Promise<DeleteBranchResponse>;
  merge: (req: MergeRequest) => Promise<MergeResponse>;
  /**
   * Cherry-pick one revision onto the current branch (ADR-0042). `recordOrigin`
   * maps to `-x`, `noCommit` leaves the result staged. A conflicted pick answers
   * `hasConflict` and/or rejects with `CHERRY_PICK_CONFLICT`.
   */
  cherryPick: (req: CherryPickRequest) => Promise<CherryPickResponse>;
  /** Revert one revision on the current branch (ADR-0042). */
  revert: (req: RevertRequest) => Promise<RevertResponse>;
  /**
   * Resolve a revision (sha, branch, remote ref, tag or rev expression) to a
   * commit without mutating anything; an unresolvable revision is
   * `COMMIT_NOT_FOUND`. Powers the cherry-pick preview (ADR-0042).
   */
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
  fetch: (req: FetchRequest) => Promise<void>;
  pull: (req: PullRequest) => Promise<void>;
  push: (req: PushRequest) => Promise<void>;
  /**
   * Start the background filesystem `Watch` server-stream for one repository;
   * resolves an ack immediately (never awaits the stream). Changes arrive via
   * `onFsChanged`. `Promise<void>` mirrors `fetch`/`pull`/`push` and the ack is
   * intentionally discarded by the caller.
   */
  watch: (req: WatchRequest) => Promise<void>;
  getAuthStatus: (req: GetAuthStatusRequest) => Promise<GetAuthStatusResponse>;
  connectGitHubFromCLI: (req: ConnectGitHubFromCLIRequest) => Promise<ConnectGitHubFromCLIResponse>;
  listGitHubRepos: (req: ListGitHubReposRequest) => Promise<ListGitHubReposResponse>;
  logout: (req: LogoutRequest) => Promise<LogoutResponse>;
  onRepoChanged: (cb: (payload: Repository) => void) => () => void;
  onFsChanged: (cb: (payload: FsChangedEvent) => void) => () => void;
  onProgress: (cb: (payload: Progress) => void) => () => void;
  /** Native-menu navigation pushed from the Electron main process (channel `menu:navigate`). */
  onMenuNavigate: (cb: (payload: MenuNavigatePayload) => void) => () => void;
  /** Validated OS deep links pushed from the Electron main process (channel `deeplink:open`). */
  onDeepLink: (cb: (payload: DeepLinkPayload) => void) => () => void;
  /**
   * Renderer → main readiness ack for deep-link delivery (channel
   * `deeplink:ready`). Sent once the renderer has subscribed to `onDeepLink`.
   */
  signalDeepLinkReady: () => void;
  /** Native folder picker exposed by the Electron shell (channel `dialog:chooseDirectory`). */
  chooseDirectory: (req: ChooseDirectoryRequest) => Promise<ChooseDirectoryResponse>;
}

export interface AppError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Stable prefix of the frozen IPC error envelope. The Electron main process
 * normalizes every IPC failure into a real `Error` whose `.message` is this
 * prefix followed by `JSON.stringify({code,message,details})`; Electron may
 * prepend `Error invoking remote method '…': Error: ` before it.
 */
const APP_ERROR_PREFIX = 'ST_APP_ERROR:';

/** True only for plain objects (not class instances such as `Error` or arrays). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `String()` that never throws (guards against hostile `toString`). */
function stringifySafely(value: unknown): string {
  try {
    return String(value);
  } catch {
    return 'Unknown error';
  }
}

/**
 * Normalize any thrown/rejected value into a usable {@link AppError}.
 *
 * Recovers the frozen envelope (`ST_APP_ERROR:` + JSON) from an `Error.message`
 * (searching anywhere, since Electron wraps it), accepts already-shaped plain
 * objects from mocked bridges, and never throws. Always yields a string
 * `message`, so `[object Object]` can never reach the UI.
 */
export function toAppError(err: unknown): AppError {
  try {
    // Error instance: prefer a decodable envelope embedded in its message.
    if (err instanceof Error) {
      const prefixIndex = err.message.indexOf(APP_ERROR_PREFIX);
      if (prefixIndex !== -1) {
        const json = err.message.slice(prefixIndex + APP_ERROR_PREFIX.length);
        const parsed: unknown = JSON.parse(json);
        if (
          isPlainObject(parsed) &&
          typeof parsed['code'] === 'string' &&
          typeof parsed['message'] === 'string'
        ) {
          return {
            code: parsed['code'],
            message: parsed['message'],
            details: isPlainObject(parsed['details']) ? parsed['details'] : {},
          };
        }
        // Parsed but not a valid payload: keep the original message for context.
        return { code: 'UNKNOWN', message: err.message, details: {} };
      }

      const coded = err as unknown as { code?: unknown; details?: unknown };
      return {
        code: typeof coded.code === 'string' ? coded.code : 'UNKNOWN',
        message: err.message || stringifySafely(err),
        details: isPlainObject(coded.details) ? coded.details : {},
      };
    }

    // Plain object (e.g. a mocked bridge rejecting `{code, message, details}`).
    if (isPlainObject(err)) {
      return {
        code: typeof err['code'] === 'string' ? err['code'] : 'UNKNOWN',
        message: typeof err['message'] === 'string' ? err['message'] : 'Unknown error',
        details: isPlainObject(err['details']) ? err['details'] : {},
      };
    }

    // Primitives / null / undefined.
    return { code: 'UNKNOWN', message: stringifySafely(err), details: {} };
  } catch {
    // JSON.parse failure or any unexpected error: never throw from a normalizer.
    return {
      code: 'UNKNOWN',
      message: err instanceof Error ? err.message : stringifySafely(err),
      details: {},
    };
  }
}

function getApi(): GitClientApi | undefined {
  return (window as unknown as { gitClientApi?: GitClientApi }).gitClientApi;
}

@Injectable({ providedIn: 'root' })
export class IpcBridge {
  private get api(): GitClientApi | undefined {
    return getApi();
  }

  invoke<K extends keyof GitClientApi>(
    method: K,
    req: Parameters<GitClientApi[K]>[0],
  ): ReturnType<GitClientApi[K]> {
    const api = this.api;
    if (!api) {
      throw { code: 'IPC_UNAVAILABLE', message: 'Not running inside Electron' } as AppError;
    }
    const fn = api[method] as unknown as (req: unknown) => ReturnType<GitClientApi[K]>;
    if (typeof fn !== 'function') {
      throw { code: 'IPC_UNAVAILABLE', message: `Method ${String(method)} not available on gitClientApi` } as AppError;
    }

    // Normalize rejections centrally so every caller sees a usable AppError
    // (the preload normally rejects with the frozen `ST_APP_ERROR:` envelope).
    // The synchronous IPC_UNAVAILABLE throws above stay intact.
    let result: ReturnType<GitClientApi[K]>;
    try {
      result = fn(req);
    } catch (err) {
      throw toAppError(err);
    }
    return Promise.resolve(result).catch((err: unknown): never => {
      throw toAppError(err);
    }) as unknown as ReturnType<GitClientApi[K]>;
  }

  onRepoChanged(cb: (payload: Repository) => void): () => void {
    const api = this.api;
    if (!api?.onRepoChanged) return () => {};
    return api.onRepoChanged(cb);
  }

  onFsChanged(cb: (payload: FsChangedEvent) => void): () => void {
    const api = this.api;
    if (!api?.onFsChanged) return () => {};
    return api.onFsChanged(cb);
  }

  onProgress(cb: (payload: Progress) => void): () => void {
    const api = this.api;
    if (!api?.onProgress) return () => {};
    return api.onProgress(cb);
  }

  onMenuNavigate(cb: (payload: MenuNavigatePayload) => void): () => void {
    const api = this.api;
    if (!api?.onMenuNavigate) return () => {};
    return api.onMenuNavigate(cb);
  }

  onDeepLink(cb: (payload: DeepLinkPayload) => void): () => void {
    const api = this.api;
    if (!api?.onDeepLink) return () => {};
    return api.onDeepLink(cb);
  }

  /**
   * Signal deep-link readiness to the shell. Best-effort: a missing bridge or an
   * older preload without the method is a no-op (the shell's bounded fallback
   * still delivers queued links).
   */
  signalDeepLinkReady(): void {
    this.api?.signalDeepLinkReady?.();
  }
}
