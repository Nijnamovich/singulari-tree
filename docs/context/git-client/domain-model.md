# Domain model — Entities, VOs, Aggregates, SQLite, Errors

> Code source of truth: `apps/go-core/internal/domain/*.go` + `libs/contracts/proto/domain.proto` + `data/sqlite/migrations/001_initial.sql`.

## 1. Aggregates and roots

### 1.1 Repository (Aggregate Root)

**Entity:** `Repository` — `apps/go-core/internal/domain/repository.go`

```go
type RepositoryId string // local UUID v4, not a Git OID
type Repository struct {
  ID           RepositoryId
  FsPath       string    // absolute, normalized (filepath.Abs)
  CommonDir    string    // .git/commonDir (worktree-aware)
  Name         string    // basename(FsPath) by default
  CreatedAt    time.Time
  LastOpenedAt time.Time
}
```

**Invariants:**
- `FsPath` required and normalized; `CommonDir` defaults to `FsPath/.git`.
- `ID` local UUID v4 (not derived from Git).
- A `Repository` groups branches, commits (via cache), status, worktrees, stashes (projections from Git).

**Ports:**
```go
type RepoPort interface {
  Open(ctx, fsPath) (*Repository, error)
  List(ctx) ([]Repository, error)
  Remove(ctx, id) error
  Get(ctx, id) (*Repository, error)
}
```

Proto `domain.proto: Repository { id, fs_path, common_dir, name, created_at, last_opened_at }`.

### 1.2 Commit (Immutable DAG Entity)

```go
type Oid struct { Hex string; Kind string } // SHA1 40 / SHA256 64 hex, regex ^[0-9a-f]{40,64}$
type Signature struct { Name, Email string; When time.Time }
type Commit struct {
  Oid         Oid
  Parents     []Oid
  Author      Signature
  Committer   Signature
  Message     string
  TreeOid     Oid
  CommittedAt time.Time
}
type Lane struct { Index, Color int; Continues bool } // lane assignment output
```

**Invariants:** Oid validated by `NewOid(hex)`, immutable parents, message may contain conflict markers (exposed in Diff).

Ports:
```go
type CommitPort interface {
  Get(ctx, repoID, oid) (*Commit, error)
  List(ctx, repoID, offset, limit) ([]Commit, int, error)
}
type CachePort interface { GetCommits / SetCommits / Invalidate }
```

### 1.3 Other entities (Git projections)

| Entity | File | Proto | Key fields | Notes |
|---------|---------|-------|--------------|-------|
| `Branch` | `branch.go` | `Branch` | `name, ref_name, tip:Oid, upstream, is_current, is_remote` | Local vs remote (`refs/heads` vs `refs/remotes`) |
| `Remote` | `remote.go` | `Remote` | `name, urls[], fetch_specs[]` | `git remote -v` |
| `Tag` | `tag.go` | `Tag` | `name, ref_name, target:Oid, tagger?, message?, annotated` | Lightweight vs annotated |
| `Stash` | `stash.go` | `Stash` | `index, oid, message, branch_name?` | `refs/stash` reflog |
| `Worktree` | `worktree.go` | `Worktree` | `fs_path, branch?, head:Oid, is_main` | `git worktree list` |
| `Diff/Hunk/DiffLine` | `diff.go` | `Diff, Hunk, DiffLine` | `from,to Oid, hunks[], additions, deletions, is_binary, has_conflict_markers` | Monaco render |
| `FileStatus` | `diff.go` + proto | `FileStatus` | `path, staged, unstaged, is_staged, is_conflicted` | porcelain v2 |

Value Objects: `Oid`, `Signature`, `RefName{raw}`, `DiffLine{kind,text,no_newline}`, `Hunk`, `FileStatus`.

## 2. ER diagram (conceptual)

```mermaid
erDiagram
  REPOSITORY ||--o{ COMMIT_CACHE : caches
  REPOSITORY ||--o{ FILE_STATUS : has
  REPOSITORY ||--o{ STASH_CACHE : caches
  REPOSITORY {
    string id PK
    string fs_path UNIQUE
    string common_dir
    string name
    string created_at
    string last_opened_at
  }
  COMMIT_CACHE {
    string repo_id FK
    string oid PK
    string parents
    string author_name
    string author_email
    string committed_at
  }
  FILE_STATUS {
    string repo_id FK
    string path PK
    string staged
    string unstaged
    bool is_staged
    bool is_conflicted
  }
```

Git objects (branches, tags, stashes, worktrees, diffs) are **not** persisted as their own tables — they are read live from `.git`; optional cache in `commit_cache`/`stash_cache` for the visible window.

## 3. SQLite schema (`data/sqlite/migrations/001_initial.sql`)

**Principles:** only metadata cache/UI-state/config — never Git data. WAL + `synchronous=NORMAL` + `foreign_keys=ON`. Per-user DB: `~/.local/share/singularitree/cache.db` (Linux), `~/Library/Application Support/...` (macOS), `%APPDATA%` (Windows). Idempotent migrations (`IF NOT EXISTS`).

```sql
-- PRAGMAs on open: journal_mode=WAL; synchronous=NORMAL; foreign_keys=ON;

CREATE TABLE IF NOT EXISTS repos (
  id              TEXT PRIMARY KEY,
  fs_path         TEXT NOT NULL UNIQUE,
  common_dir      TEXT NOT NULL,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_opened_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commit_cache (
  repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  oid             TEXT NOT NULL,
  parents         TEXT NOT NULL, -- JSON array hex
  author_name     TEXT NOT NULL,
  author_email    TEXT NOT NULL,
  author_when     TEXT NOT NULL, -- RFC3339
  committer_name  TEXT NOT NULL,
  committer_email TEXT NOT NULL,
  committer_when  TEXT NOT NULL,
  message         TEXT NOT NULL,
  tree_oid        TEXT NOT NULL,
  committed_at    TEXT NOT NULL, -- RFC3339
  PRIMARY KEY (repo_id, oid)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS file_status (
  repo_id       TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  staged        TEXT NOT NULL,
  unstaged      TEXT NOT NULL,
  is_staged     INTEGER NOT NULL,
  is_conflicted INTEGER NOT NULL,
  PRIMARY KEY (repo_id, path)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS stash_cache (
  repo_id     TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  stash_index INTEGER NOT NULL,
  oid         TEXT NOT NULL,
  message     TEXT NOT NULL,
  branch_name TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (repo_id, stash_index)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_commit_cache_when ON commit_cache(repo_id, committed_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_status_repo ON file_status(repo_id);
```

**Worktrees/branches/tags** have no table — they are enumerated via `GitPort`; if a cache of recents/favorites/prefs/UI-state is needed, add it in migration `002`:

```sql
-- planned 002_prefs.sql
CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE recent_repos (repo_id TEXT PRIMARY KEY REFERENCES repos(id), opened_at TEXT);
CREATE TABLE favorites (repo_id TEXT PRIMARY KEY REFERENCES repos(id));
```

Repository operations: `repo_store.go` uses `database/sql` with `modernc.org/sqlite` (pure Go, no CGO) or `mattn/go-sqlite3`.

## 4. proto ↔ domain contracts

| Go domain | Proto | Conversion |
|------------|-------|------------|
| `Oid{Hex,Kind}` | `Oid{hex,kind}` | `NewOid` validates regex |
| `Signature{Name,Email,When time.Time}` | `Signature{name,email,when RFC3339}` | `time.RFC3339` |
| `Commit{...}` | `Commit{oid, parents[], author, committer, message, tree_oid, committed_at}` | direct |
| `Branch` | `Branch{name, ref_name, tip, upstream, is_current, is_remote}` | `ref_name = RefName.raw` |
| `Diff` | `Diff{from,to,hunks,additions,deletions,is_binary,has_conflict_markers}` | aggregated hunks |

Generation: `buf generate --template buf.gen.yaml` → `libs/contracts/gen/go/singularitree/v1` + `gen/ts`.

## 5. Errors (errors.go + errors.proto)

`AppError{Code, Message, Details map[string]string}` — uniform envelope.

**Canonical codes (`errors.proto: ErrorCode` + `domain/errors.go`):**

| Code string | Enum | When | HTTP map (fallback) |
|-------------|------|--------|---------------------|
| `REPO_NOT_FOUND` | 1 | repo id does not exist | 404 |
| `NOT_A_GIT_REPO` | 2 | `Open` path without `.git` | 400 |
| `COMMIT_NOT_FOUND` | 3 | oid does not exist in DAG | 404 |
| `INVALID_OID` | 4 | hex does not match regex | 400 |
| `BRANCH_NOT_FOUND` | 5 | checkout/merge branch miss | 404 |
| `BRANCH_EXISTS` | 6 | create collision | 409 |
| `DETACHED_HEAD` | 7 | HEAD detached | 409 |
| `IPC_UNAVAILABLE` | 8 | Electron unavailable | 503 |
| `GO_CORE_UNAVAILABLE` | 9 | gRPC down | 503 |
| `QUEUE_FULL` | 10 | supervisor queue 100 | 429 |
| `STAGE_FAILED` | 11 | `git add` fail | 422 |
| `COMMIT_FAILED` | 12 | commit hook/fail | 422 |
| `CHECKOUT_FAILED` | 13 | checkout conflict | 422 |
| `FETCH_FAILED` | 14 | fetch network | 502 |
| `PUSH_FAILED` | 15 | push rejected | 502 |
| `DIFF_FAILED` | 16 | diff binary/too large | 422 |
| `WATCH_FAILED` | 17 | fsnotify error | 500 |
| `UNAUTHENTICATED` | 18 | token mismatch | 401 |

Wire: `AppError` message in gRPC `Status.details` or `application/grpc+proto` trailer; HTTP JSON `{code, message, details}`.

Go example:
```go
return AppError{Code: ErrCodeInvalidOid, Message: "invalid oid"}.WithDetail("oid", hex)
```

TS example:
```ts
try { await ipcBridge.invoke('getCommits', req) } catch(e: AppError) { if(e.code==='QUEUE_FULL') retry() }
```

## 6. Business invariants

- Never persist full blobs/trees/commits in SQLite; only the cached window (200+100) and metadata.
- `commit_cache` invalidated on `FsChangedEvent` or `HEAD` move; `file_status` refreshed with debounce.
- `refs/stash` may not exist — `ListStashes` returns empty, not an error.
- Large repo: `GetCommits` offset/limit mandatory; `StreamCommits` streaming for prefetch.
