import { Injectable, computed, inject, signal } from '@angular/core';
import { AuthSource } from '@contracts/auth';
import type {
  AuthStatus,
  ConnectGitHubFromCLIResponse,
  GitHubRepo,
  PageInfo,
  RateLimit,
} from '@contracts/auth';
import { IpcBridge, toAppError, type AppError } from '@core/services/ipc-bridge.service';

/** Default page size for `auth:listGitHubRepos` (GitHub default is 30). */
export const REPOS_PER_PAGE = 30;
/** Stable ordering so page boundaries do not shift between requests. */
export const REPOS_SORT = 'full_name';
export const REPOS_DIRECTION = 'asc';

function isIpcUnavailable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'IPC_UNAVAILABLE'
  );
}

/**
 * The Electron bridge decodes gRPC enums as strings (`proto-loader` option
 * `enums: String`), while `@contracts/auth` declares `AuthSource` as numeric.
 * Normalize the wire value at the store boundary so the rest of the renderer
 * always sees the numeric enum.
 */
const AUTH_SOURCE_BY_NAME: Readonly<Record<string, AuthSource>> = {
  AUTH_SOURCE_UNSPECIFIED: AuthSource.AUTH_SOURCE_UNSPECIFIED,
  AUTH_SOURCE_NONE: AuthSource.AUTH_SOURCE_NONE,
  AUTH_SOURCE_GITHUB_CLI: AuthSource.AUTH_SOURCE_GITHUB_CLI,
  AUTH_SOURCE_OAUTH: AuthSource.AUTH_SOURCE_OAUTH,
  UNRECOGNIZED: AuthSource.AUTH_SOURCE_UNSPECIFIED,
};

function normalizeSource(source: unknown): AuthSource {
  if (typeof source === 'number') return source as AuthSource;
  if (typeof source === 'string') {
    return AUTH_SOURCE_BY_NAME[source] ?? AuthSource.AUTH_SOURCE_UNSPECIFIED;
  }
  return AuthSource.AUTH_SOURCE_UNSPECIFIED;
}

function normalizeStatus(status: AuthStatus | undefined): AuthStatus | undefined {
  if (!status) return undefined;
  return { ...status, source: normalizeSource(status.source) };
}

/**
 * Signal store for the authenticated GitHub account (github-real-data-guide.md §3/§6).
 *
 * The renderer never talks to GitHub: every action goes through `IpcBridge`
 * (`auth:*` channels served by the Go core). The bridge is a constructor
 * parameter (defaulting to DI) so the store can be unit-tested without TestBed.
 *
 * Root-provided so every consumer (the routed page and the shell drawer) shares
 * the same account state.
 */
@Injectable({ providedIn: 'root' })
export class GithubAccountStore {
  private readonly bridge: IpcBridge;

  /** Guards {@link autoConnectOnce} so the CLI connect runs at most once. */
  private autoConnectAttempted = false;

  constructor(bridge: IpcBridge = inject(IpcBridge)) {
    this.bridge = bridge;
  }

  // -- state ---------------------------------------------------------------
  readonly status = signal<AuthStatus | undefined>(undefined);
  readonly repos = signal<GitHubRepo[]>([]);
  readonly pageInfo = signal<PageInfo | undefined>(undefined);
  readonly rateLimit = signal<RateLimit | undefined>(undefined);
  readonly loading = signal(false);
  readonly error = signal<AppError | null>(null);
  /** True when the renderer runs without the Electron preload bridge. */
  readonly offline = signal(false);

  // -- derived -------------------------------------------------------------
  readonly authenticated = computed(() => this.status()?.authenticated ?? false);
  readonly hasMore = computed(() => this.pageInfo()?.hasMore ?? false);

  // -- actions -------------------------------------------------------------

  /**
   * Non-interactive startup connect: at most once per app lifetime, refresh
   * the status and, only when the account is neither authenticated nor offline,
   * run the non-interactive `gh auth token` connect.
   *
   * Never calls `connect()` when already authenticated. Every failure is
   * captured on `offline`/`error` by the callees, so this never throws.
   */
  async autoConnectOnce(): Promise<void> {
    if (this.autoConnectAttempted) return;
    this.autoConnectAttempted = true;
    await this.refreshStatus();
    if (!this.authenticated() && !this.offline()) {
      await this.connect();
    }
  }

  /** Fetch the current account status (`auth:getAuthStatus`). */
  async refreshStatus(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.bridge.invoke('getAuthStatus', {});
      this.offline.set(false);
      this.status.set(normalizeStatus(res.status));
    } catch (err) {
      this.captureError(err);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Authenticate using the local `gh` CLI (`auth:connectGitHubFromCLI`).
   * `ghBinary` empty -> the core resolves `gh` on PATH; `verify` validates the
   * token with `GET /user`.
   */
  async connect(ghBinary = '', verify = true): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res: ConnectGitHubFromCLIResponse = await this.bridge.invoke('connectGitHubFromCLI', {
        ghBinary,
        verify,
      });
      this.offline.set(false);
      const status = normalizeStatus(res.status);
      this.status.set(status);
      this.rateLimit.set(status?.rateLimit);
    } catch (err) {
      this.captureError(err);
    } finally {
      this.loading.set(false);
    }
  }

  /** Replace the repository list with page `page` (defaults to the first page). */
  async loadRepos(page = 1): Promise<void> {
    await this.fetchRepos(page, false);
  }

  /**
   * Append the next page when the core reports one. Guards against re-entry
   * (already loading) and exhaustion (`hasMore === false` / no `nextPage`).
   */
  async loadMore(): Promise<void> {
    if (this.loading() || !this.hasMore()) return;
    const next = this.pageInfo()?.nextPage ?? 0;
    if (next <= 0) return;
    await this.fetchRepos(next, true);
  }

  /** Revoke the in-memory session and clear all account-derived state. */
  async logout(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.bridge.invoke('logout', {});
      this.offline.set(false);
      this.status.set(undefined);
      this.repos.set([]);
      this.pageInfo.set(undefined);
      this.rateLimit.set(undefined);
    } catch (err) {
      this.captureError(err);
    } finally {
      this.loading.set(false);
    }
  }

  private async fetchRepos(page: number, append: boolean): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.bridge.invoke('listGitHubRepos', {
        perPage: REPOS_PER_PAGE,
        page,
        sort: REPOS_SORT,
        direction: REPOS_DIRECTION,
        affiliation: '',
        visibility: '',
        type: '',
      });
      this.offline.set(false);
      const pageRepos = res.repos ?? [];
      if (append) {
        this.repos.update((prev) => [...prev, ...pageRepos]);
      } else {
        this.repos.set([...pageRepos]);
      }
      this.pageInfo.set(res.pageInfo);
      this.rateLimit.set(res.rateLimit);
    } catch (err) {
      this.captureError(err);
    } finally {
      this.loading.set(false);
    }
  }

  /** Route IPC_UNAVAILABLE to `offline`; record every other failure on `error`. */
  private captureError(err: unknown): void {
    if (isIpcUnavailable(err)) {
      this.offline.set(true);
    } else {
      this.error.set(toAppError(err));
    }
  }
}
