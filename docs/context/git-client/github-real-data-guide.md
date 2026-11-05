# GitHub as a real data source — connection via `gh` CLI

> **Design record — approved and implemented.** Sections 1–12 were approved and implemented end-to-end in this iteration, with the six §12 adjustments applied; this page is kept as the design record plus implementation status, not as a pending proposal. See §13 for implementation status and §12 for the adjustments as requested. The "Explicitly out" list in §1 states the pre-implementation scope and is only partly superseded: the adapters/IPC/handlers/renderer work and the `gen/{go,ts}` regeneration are implemented, while the OAuth app flow, the SQLite migration and `buf` wiring in CI remain deferred as recorded in §13. It coexists with the legacy docs in `git-client/` as a frozen tree (no frontmatter, excluded from the validator).

## 1. Objective and scope

Connect SingulariTree to GitHub using the **`gh` CLI as token source** and obtain **the repositories of the authenticated account as real data** (not mock), plus the necessary proto contract additions.

**Included:**

- Design of the end-to-end flow Angular → Electron → Go core → `api.github.com`.
- **Additive** additions to `libs/contracts/proto/auth.proto` and `libs/contracts/proto/errors.proto`.
- Migration plan for the renderer from mock data to real data.
- Documented resolution of the design hot spots (section 7).

**Explicitly out (see section 9):**

- Implementation of adapters, IPC, handlers or renderer (design only).
- Regeneration of `gen/{go,ts}` stubs.
- OAuth app flow (future evolution only, not this iteration).
- SQLite migration and `buf` wiring in CI.

Sibling references: OAuth flow and reused endpoints/error codes in [`./github-oauth-guide.md`](./github-oauth-guide.md); IPC transport in [`./ipc-strategy.md`](./ipc-strategy.md); hexagonal ports in [`./service-design.md`](./service-design.md) and [`./domain-model.md`](./domain-model.md).

## 2. Frozen decisions (human input)

These decisions were already made by the human and are input constraints, not proposals to debate.

| Decision | Frozen value |
|---|---|
| Token source | `gh` CLI — token obtained with `gh auth token` (no OAuth app). |
| Target account | `Nijnamovich` (authenticated account on the local machine). |
| Token scopes | `gist, read:org, repo, workflow` — **without** `read:user`. |
| OAuth app flow | Out of this iteration; future evolution only. |
| Data scope | Repositories of the authenticated account (`GET /user/repos`), not third-party repos. |

No secrets are persisted in code, docs or logs: the token lives in memory in the Go core and is never serialized to the renderer.

## 3. End-to-end flow

Proposed IPC channel `auth:*`, symmetric to the existing `git:*`. The network owner is the Go core: Electron never calls GitHub.

| # | Angular action | IPC channel (`auth:*`) | Electron | Go core | Network | Slice |
|---|---|---|---|---|---|---|
| 1 | `GithubAccountStore.connect()` in `apps/angular/src/app/features/github-account/github-account.store.ts` (new) calls `IpcBridge` | `auth:connectGitHubFromCLI` | — | — | — | renderer |
| 2 | `IpcBridge.invoke('auth:connectGitHubFromCLI', {ghBinary:'gh', verify:true})` in `apps/angular/src/app/core/services/ipc-bridge.service.ts` | `auth:connectGitHubFromCLI` | — | — | — | renderer |
| 3 | — | — | `preload.ts` exposes the method in `GitClientApi` (`apps/electron/src/preload/preload.ts`) | — | — | desktop-shell |
| 4 | — | — | `channels.ts` declares `auth:*` + `CHANNEL_TO_RPC` (`apps/electron/src/ipc/channels.ts`) | — | — | desktop-shell |
| 5 | — | — | `handlers.ts` validates and forwards (`apps/electron/src/ipc/handlers.ts`) | — | — | desktop-shell |
| 6 | — | — | `supervisor.forwardToGo()` gRPC dispatch (`apps/electron/src/main/supervisor.ts`) | — | — | desktop-shell |
| 7 | — | — | `go-core-client.ts` additionally builds the `Auth` client (`apps/electron/src/main/go-core-client.ts`) | — | — | desktop-shell |
| 8 | — | — | — | `AuthService.ConnectFromCLI()` (`apps/go-core/internal/service/auth_service.go`, new) | — | core |
| 9 | — | — | — | `TokenSource.Token()` via `apps/go-core/internal/adapter/ghcli/` (new) runs `gh auth token` | — | core |
| 10 | — | — | — | `AuthPort.GetUser()` / `ListRepos()` in `apps/go-core/internal/adapter/github/` (new) behind `domain.AuthPort` (`apps/go-core/internal/domain/auth.go`) | `GET https://api.github.com/user` and `GET /user/repos` | core |
| 11 | — | — | — | `grpc.AuthServer` registered in `apps/go-core/internal/adapter/grpc/server.go` (current gap, see §5) | — | core |

**Return path:** `api.github.com` → `adapter/github` (parsing + `ETag`/rate limit) → `AuthService` → gRPC response `singularitree.v1.Auth` → `go-core-client.ts` → `supervisor` → `handlers.ts` → `preload.ts` → `IpcBridge` → `GithubAccountStore` signals → UI.

## 4. GitHub endpoints

| Endpoint | Use | Parameters / notes |
|---|---|---|
| `GET https://api.github.com/user` | Profile of the authenticated account | No params. Requires token. `email` may come empty (see §8). |
| `GET https://api.github.com/user/repos` | Account repositories | Query: `per_page`, `page`, `sort` (`created`\|`updated`\|`pushed`\|`full_name`), `direction` (`asc`\|`desc`), `affiliation` (`owner,collaborator,organization_member`), `visibility` (`all`\|`public`\|`private`), `type` (`all`\|`owner`\|`public`\|`private`\|`member`). |
| `GET https://api.github.com/rate_limit` (optional) | Quota snapshot without spending a data request | Useful to preload `X-RateLimit-*` when there is no previous response. |

**Pagination (Link header):** the `user/repos` response includes `Link: <...&page=2>; rel="next"`. The adapter parses `rel="next"` and exposes it as `PageInfo.next_page` + `PageInfo.has_more`. Absence of `rel="next"` ⇒ `next_page=0`, `has_more=false`.

**Rate limits:** headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (epoch) and, on 403/429 with secondary abuse, `Retry-After`. They are mapped to `RateLimit{resource, limit, remaining, reset, reset_at}`; `reset` is epoch and `reset_at` is ISO-8601.

**Conditional requests:** cache the `ETag` of the last response per user and send `If-None-Match`; `304 Not Modified` reuses the cached payload and does not count against the primary limit.

**Implementation home:** `apps/go-core/internal/adapter/github/` implements `domain.AuthPort` and `TokenStore`; `apps/go-core/internal/adapter/ghcli/` implements the `TokenSource`. Reused endpoints and error codes are documented in [`./github-oauth-guide.md`](./github-oauth-guide.md).

## 5. Proposed contract additions (proto)

All additions are **additive** (`append` of new fields, never reuse numbers or rename). **`gen/{go,ts}` is NOT regenerated in this iteration**: the current stubs keep governing the wire until a separate approval with `buf generate`.

### 5.1 `libs/contracts/proto/auth.proto`

`service Auth`: add RPC; the existing OAuth RPCs are retained.

```proto
service Auth {
  // ... current RPCs (GetAuthStatus, StartGitHubOAuth, ExchangeCode, GetGitHubUser, ListGitHubRepos, Logout) are preserved ...
  rpc ConnectGitHubFromCLI(ConnectGitHubFromCLIRequest) returns (ConnectGitHubFromCLIResponse); // NEW
}
```

`GetAuthStatusResponse`: add field 3; 1-2 are retained.

```proto
message GetAuthStatusResponse {
  bool authenticated = 1; // retained
  string login = 2;       // retained
  AuthStatus status = 3;  // NEW
}
```

`ListGitHubReposRequest`: add 3-7; 1-2 are retained.

```proto
message ListGitHubReposRequest {
  uint32 per_page = 1;                      // retained
  uint32 page = 2;                          // retained
  string sort = 3;                           // NEW: created|updated|pushed|full_name
  string direction = 4;                      // NEW: asc|desc
  string affiliation = 5;                    // NEW: owner,collaborator,organization_member
  string visibility = 6;                     // NEW: all|public|private
  string type = 7;                           // NEW: all|owner|public|private|member
}
```

`ListGitHubReposResponse`: add 2-3; 1 is retained.

```proto
message ListGitHubReposResponse {
  repeated GitHubRepo repos = 1; // retained
  PageInfo page_info = 2;        // NEW
  RateLimit rate_limit = 3;      // NEW
}
```

`GitHubRepo`: add fields 10-28; 1-9 are retained.

```proto
message GitHubRepo {
  // 1-9 retained: id, name, full_name, private, html_url, description, language, stargazers_count, updated_at
  string node_id = 10;             // NEW
  string default_branch = 11;      // NEW
  string owner_login = 12;         // NEW
  string owner_avatar_url = 13;    // NEW
  string visibility = 14;          // NEW
  bool fork = 15;                  // NEW
  bool archived = 16;              // NEW
  bool disabled = 17;              // NEW
  string clone_url = 18;           // NEW
  string ssh_url = 19;             // NEW
  string git_url = 20;             // NEW
  string pushed_at = 21;           // NEW
  string created_at = 22;          // NEW
  int32 forks_count = 23;          // NEW
  int32 open_issues_count = 24;    // NEW
  repeated string topics = 25;     // NEW
  string license_spdx_id = 26;     // NEW
  bool is_template = 27;           // NEW
  string homepage = 28;            // NEW
}
```

New top-level messages and enum (no number collision: `GitHubRepo` reaches 28; the new messages are independent types):

```proto
enum AuthSource {
  AUTH_SOURCE_UNSPECIFIED = 0;
  AUTH_SOURCE_NONE = 1;
  AUTH_SOURCE_GITHUB_CLI = 2;
  AUTH_SOURCE_OAUTH = 3;
}

message AuthStatus {
  bool authenticated = 1;
  AuthSource source = 2;
  string account_login = 3;
  string name = 4;
  string avatar_url = 5;
  string email = 6;              // optional: may come empty (see §8)
  repeated string scopes = 7;
  RateLimit rate_limit = 8;
}

message ConnectGitHubFromCLIRequest {
  string gh_binary = 1;          // default "gh"
  bool verify = 2;               // if true, validates the token with GET /user
}

message ConnectGitHubFromCLIResponse {
  AuthStatus status = 1;
  GitHubUser user = 2;
}

message PageInfo {
  uint32 page = 1;
  uint32 per_page = 2;
  uint32 next_page = 3;          // 0 if there is no next
  bool has_more = 4;
  uint32 total = 5;              // 0 if GitHub does not provide it
}

message RateLimit {
  string resource = 1;           // "core" | "search" | ...
  uint32 limit = 2;
  uint32 remaining = 3;
  int64 reset = 4;               // epoch seconds
  string reset_at = 5;           // ISO-8601
}
```

### 5.2 `libs/contracts/proto/errors.proto`

`ErrorCode`: add 19-23; 0-18 are retained.

```proto
enum ErrorCode {
  // 0-18 retained
  GH_CLI_NOT_FOUND = 19;
  GH_CLI_UNAUTHENTICATED = 20;
  GITHUB_RATE_LIMITED = 21;
  GITHUB_API_ERROR = 22;
  GITHUB_TOKEN_INVALID = 23;
}
```

### 5.3 Confirmed wiring gap

Although `libs/contracts/gen/go/singularitree/v1/auth_grpc.pb.go` already exposes `RegisterAuthServer`, the `Auth` service **is not registered**:

- `apps/go-core/internal/adapter/grpc/server.go` only calls `singularitreev1.RegisterGitCoreServer` (there is no `server.RegisterAuth` nor an embedded `AuthServer`).
- `apps/electron/src/main/go-core-client.ts` builds only the `singularitree.v1.GitCore` client (`GIT_CORE_RPC_METHODS`, `GIT_CORE_PROTO_FILES`), with no `Auth` client.

Closing this gap is a prerequisite for any implementation and must go in a separate change, after approval. The current stubs are used as-is; they are not regenerated.

## 6. How the renderer moves to real data

**Current state (mock):**

- `apps/angular/src/app/core/layout/layout.ts` hardcodes `repoCards` (lines ~69-74) and `commits` (~76-85); `layout.html` renders them (repo list in `.st-right__list`, graph in `.st-graph__rows`).
- `apps/angular/src/app/features/repo/data/mock-repos.ts` (+ re-export `apps/angular/src/app/features/repo/mock-data.ts`) is **orphaned**: it no longer feeds the layout or the `GraphStore`.

**Proposed plan:**

1. **New vertical `apps/angular/src/app/features/github-account/`** — `github-account.store.ts` (signals `status`, `repos`, `pageInfo`, `rateLimit`, `loading`, `error`) + an account component that consumes the `auth:*` channels. It is the only point that talks to the `Auth` service (via `IpcBridge`).
2. **Layout repo list** — `LayoutComponent` drops `repoCards` and reads `RepoState.repos` (`apps/angular/src/app/core/services/repo-state.service.ts`, already wired to `git:listRepositories`). "Local repositories" = repos tracked in the core (SQLite), NOT the GitHub account.
3. **Layout commit graph** — replace the mock `commits` with `GraphStore` (`apps/angular/src/app/features/repo/graph/graph.store.ts`), which already uses real IPC (`getCommits` + window pagination).
4. **Remove orphaned mock** — delete `features/repo/data/mock-repos.ts` and `features/repo/mock-data.ts` once no consumer references them (deletion = human action, see safety rules).

**Explicit vocabulary distinction:**

| Concept | Source | UI |
|---|---|---|
| **Local repositories** | `git:listRepositories` → `RepoState.repos` | Right drawer "Local repositories" |
| **GitHub account repos** | `auth:listGitHubRepos` → `GithubAccountStore.repos` | New account view/drawer |
| Commit graph | `git:getCommits` → `GraphStore` | Central history panel |

## 7. Hot spots and branch-map (resolved)

| ID | Hot spot | Options evaluated | Chosen | Rationale | Risk |
|---|---|---|---|---|---|
| **HS1** | Token acquisition boundary | `gh-cli-in-core` vs Electron reads `gh` vs renderer | **`gh-cli-in-core`** | The Go core is the sole owner of the network and the in-memory `TokenStore`; the token never crosses IPC to the renderer. | If `gh` is not installed/authenticated → `GH_CLI_NOT_FOUND` / `GH_CLI_UNAUTHENTICATED`. |
| **HS2** | Pagination shape | `page` only vs `page + Link rel=next` vs cursor | **`page + link-next_page`** | GitHub paginates via `Link`; exposing `next_page`/`has_more` stops the renderer from guessing the end of the list. | Proxies that rewrite `Link` would break parsing (fallback: `has_more` by length). |
| **HS3** | Rate limit strategy | blind retry vs `headers + ETag` vs fixed backoff | **`headers + etag-conditional-backoff`** | `X-RateLimit-*`/`Retry-After` + `If-None-Match` minimize consumption and respect quotas. | `ETag` state must be invalidated when switching accounts (`GITHUB_TOKEN_INVALID`). |
| **HS4** | Cache owner | renderer vs Electron vs in-memory core vs SQLite | **`core-sqlite-metadata-cache`** | The core already persists metadata (repos); caching there unifies and survives restarts. | **Implies a FUTURE SQLite migration, subject to separate approval**; this iteration only declares it. |

## 8. Hidden assumption / caveat

The frozen scopes (`gist, read:org, repo, workflow`) **omit `read:user`**. Consequence: `GET https://api.github.com/user` may return `email` empty or null.

- The contract treats `email` as **optional** (`AuthStatus.email`, `GitHubUser.email` may be `""`).
- The UI must not assume email is present; degrade to "not available".
- Later opt-in: `gh auth refresh -s read:user` to populate the email. Out of this iteration.

## 9. Out of scope

- Implementation of adapters, IPC, handlers, supervisor or renderer.
- Regeneration of `gen/go` and `gen/ts` stubs (requires `buf generate` and separate approval).
- OAuth app flow (future evolution only; OAuth RPCs are preserved, not wired).
- SQLite migration as metadata cache (see HS4).
- `buf` wiring in CI.

## 10. Verification

**Now (design only):** run from the repo root; `buf` and `go` are not installed in this environment, so today only `protoc` + `node tools/docs/validate.js` run.

```bash
protoc --proto_path=libs/contracts/proto --descriptor_set_out=/dev/null \
  domain.proto errors.proto auth.proto gitcore.proto                   # full parse (gitcore imports domain)
node tools/docs/validate.js                                            # corpus (this doc is excluded)
```

**After human validation and implementation (buf not installed today):**

```bash
buf lint && buf generate                                              # contracts (when buf is available)
cd apps/go-core && go vet ./... && go test ./...                      # core
npm run typecheck --workspace=@singularitree/electron && npm test     # desktop-shell
npm test --workspace=@singularitree/angular                           # renderer (vitest)
# e2e live: gh auth status && <connect> && list real repos without error
```

## 11. Pending human validation

- Approve the contract additions in section 5 (field numbering and new messages).
- Approve `gh-cli-in-core` as the token boundary (HS1) and `core-sqlite-metadata-cache` as the cache owner (HS4, with its future migration).
- Approve the `auth:*` channel mapping and the new `features/github-account/` vertical.
- Confirm the decision NOT to regenerate `gen/{go,ts}` in this iteration.
- Confirm the vocabulary distinction "local repositories" vs "GitHub account repos".
- Confirm optional treatment of `email` and the opt-in `gh auth refresh -s read:user` (section 8).
- Approve the retirement of the orphaned mocks as a separate human action.

## 12. Independent review (analyst) — adjustments requested before implementing

An independent second opinion (model from another family) reviewed this plan: **verdict `revise`**, confidence 0.72. The design is directionally correct, but it demands six adjustments before implementing. They are recorded here for human validation.

1. **`gh` and the child's PATH (HS1).** The supervisor launches go-core with `spawn(bin, args)` without an explicit `env` (`apps/electron/src/main/supervisor.ts`), so the core inherits Electron's environment. On macOS launched from Finder/Launcher, the PATH is the stub (`/usr/bin:/bin:/usr/sbin:/sbin`) and `gh` (Homebrew, `/opt/homebrew/bin`) would not be found. Adjustment: add a configuration knob `SINGULARITREE_GH_PATH` (pattern `getEnv` from `internal/config/config.go`, pattern of `gh_binary` already in `ConnectGitHubFromCLIRequest`), include the searched PATH in `error.details` of `GH_CLI_NOT_FOUND`, and an early check to diagnose within the first seconds. **As implemented this became one resolver with a three-step precedence, not the knob alone — see §13, item 1.**
2. **Pagination (HS2).** `total` is unknowable in `/user/repos` (there is no `X-Total-Count`). Adjustment: document `PageInfo.total` as "best-effort, 0 = unknown" (already annotated in proto §5), **set the default of `sort`** (`full_name`) so that page boundaries are stable, and note that GitHub clamps `per_page` to 100.
3. **Cache/ETag correction (HS3+HS4).** A `304` brings no body: `(key, etag, body)` must be persisted atomically. Adjustment: honor `304` only if a body exists for that `etag`; **invalidate rows including the etags** when switching account/token; and **pin the cache per account** (`account_login`) so that a new token does not serve data from another account.
4. **Separate `Auth` service (HS1/HS6).** It is confirmed as the lowest-risk option (additive; `auth.proto` already declares `service Auth`). Implementation adjustment: the service-aware refactor must keep the `satisfies Record<ChannelName, string>` check of `channels.ts` green for both services and must not drop `auth:*` into the `isStreamingRpc` guard (which is GitCore-shaped); the second client must follow the same reconnection path (`supervisor.ts` → `connectClient`).
5. **Secret surface.** `ExchangeCodeResponse.access_token` (`auth.proto` line 42) remains **unwired/unused** in the `gh` flow; declare it explicitly. Also, the `error.details` must never dump raw `stderr` from `gh` (it may echo the user): only structured fields.
6. **Scope correction (HS8/§6).** `LayoutComponent` is a **completely static** shell (hardcoded tabs, sidebar trees and diff pane, with no store injection), not a thin consumer of `mock-repos.ts`. "Changing the layout to `RepoState`/`GraphStore`" is a feature-scale effort and must NOT travel in the same vertical as the account linking. Retiring `features/repo/data/mock-repos.ts` is the trivial cleanup (verify first that no spec imports it).

**Status of the independent verification:** the four hot spots remain resolved; the `revise` verdict is about design/scope adjustments, not an abandonment. Human approval of §11 must incorporate these six points.

## 13. Implementation status

The plan §1-§12 was **approved and implemented end-to-end** in this iteration, with the adjustments from §12 applied; this document is no longer design-only.

| Area | Status |
|---|---|
| Contracts proto | **Additive** additions to `auth.proto` (§5.1) and `errors.proto` (§5.2) + regeneration of `gen/{go,ts}` via `buf generate`. |
| Go core — `Auth` service | `RegisterAuthServer` registered alongside `GitCore` in `apps/go-core/internal/adapter/grpc/server.go`. |
| Go core — token | Token via `gh auth token` in `apps/go-core/internal/adapter/ghcli/`, with the single resolver behind it (`SINGULARITREE_GH_PATH` → `PATH` → well-known install dirs; §13 item 1). |
| Go core — GitHub REST | `apps/go-core/internal/adapter/github/`: pagination via `Link rel="next"`, rate limit by headers and **in-memory ETag** cache. |
| Go core — service | `AuthService` (`apps/go-core/internal/service/auth_service.go`). |
| Electron | Second gRPC client `Auth` + `auth:*` **non-streaming** channels (they do not fall into GitCore's `isStreamingRpc` guard). |
| Renderer | Vertical `features/github-account/` with the four bridge methods. |
| Cleanup | Orphaned mocks `features/repo/data/mock-repos.ts` + `mock-data.ts` retired. |

**Adjustments from §12 applied:**

1. **(a) `gh` and child PATH** — resolution is one shared code path in `apps/go-core/internal/adapter/ghcli/token_source.go` (`SearchedPathFor` → `LookupFor`, consumed by both the boot diagnostic and `Token`, so the two cannot disagree), in this precedence: the explicit `SINGULARITREE_GH_PATH` dirs → the inherited `PATH` → the platform's well-known install dirs (Windows: `%LOCALAPPDATA%\Programs\GitHub CLI`, `%LOCALAPPDATA%\Microsoft\WinGet\Links`, `%LOCALAPPDATA%\GitHubCLI\bin`, `%USERPROFILE%\scoop\shims`, `%ProgramFiles%\GitHub CLI`, `%ProgramFiles(x86)%\GitHub CLI`; Unix: `/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`), with `PATHEXT` probing on Windows, empty entries skipped and duplicates removed (case-insensitive on Windows); the same combined list is exported to the child as `PATH`. `GH_CLI_NOT_FOUND.details` carries `binary` + `searched_path`, and the message names the next action (`winget install --id GitHub.cli` or `scoop install gh`, then `gh auth login`).
2. **(b) Pagination** — `PageInfo.total` best-effort (`0` = unknown); default `sort` = `full_name`; `per_page` clamped to 100 by GitHub.
3. **(c) Cache/ETag** — `304` honored only with a body for that `etag`; cache pinned by `account_login` and invalidated on token change.
4. **(d) Separate `Auth` service** — the `satisfies Record<ChannelName, string>` of `channels.ts` stays green for both services; the second client follows the same reconnection path (`supervisor.ts` → `connectClient`).
5. **(e) Secret surface** — `ExchangeCodeResponse.access_token` unwired; `error.details` with structured fields only (never raw `stderr` from `gh`).
6. **(f) Scope** — the shell/mocks migration is separated from the account linking vertical (see debt).

**Deferred / accepted debt:**

- **SQLite migration (HS4)** to persist the ETag cache: this iteration uses an **in-memory** cache with `TODO(HS4)`, subject to separate approval.
- **Migration of `LayoutComponent`/static shell to `RepoState`/`GraphStore`** (§12f): the shell outlet is still hidden; the vertical is reached at `/github-account`.
- **OAuth app flow** and `ExchangeCodeResponse.access_token` remain unwired.
- **~~`gh` resolution on Windows~~ — RETIRED (2026-10-24).** The POSIX executable-bit check is no longer the gate: on Windows any existing non-directory candidate is considered runnable (mirroring `os/exec`'s own `chkStat`), `gh.exe` is found by probing `PATHEXT`, and the well-known installer directories above are searched after `PATH`, so a packaged build no longer depends on the process `PATH` containing the GitHub CLI. What remains actionable is the user-facing error: `GH_CLI_NOT_FOUND` names the install command (`winget install --id GitHub.cli` / `scoop install gh`) plus `gh auth login`, and `GH_CLI_UNAUTHENTICATED` names `gh auth login`.

**Canonical verification executed (all green):**

```bash
./tools/ci/verify-contracts.sh
cd apps/go-core && go vet ./... && go test ./...
npm run typecheck --workspace=@singularitree/electron && npm test --workspace=@singularitree/electron
npm test --workspace=@singularitree/angular
node tools/docs/validate.js
```
