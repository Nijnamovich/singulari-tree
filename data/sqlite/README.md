# SQLite — Per-User Persistence

SQLite WAL database for SingulariTree Go core (per `service-design.md §5`, `domain-model.md §3`).

## Location (per-user, outside repo)

Runtime DB is **not committed** — it lives in the platform data directory:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/singularitree/cache.db` (core-only: the product no longer ships a macOS app) |
| Windows | `%APPDATA%\singularitree\cache.db` |
| Linux | `~/.local/share/singularitree/cache.db` |

Create parent dir if missing: `mkdir -p "$(dirname "$DB_PATH")"`.

## WAL Mode (required on open)

```go
db.Exec("PRAGMA journal_mode=WAL")
db.Exec("PRAGMA synchronous=NORMAL")
db.Exec("PRAGMA foreign_keys=ON")
```

- WAL allows concurrent readers + one writer (see `risks.md` SQLite concurrency).
- `synchronous=NORMAL` is safe with WAL.

## Migrations

Committed SQL in `data/sqlite/migrations/*.sql` drives schema:

- `001_initial.sql` — `repos`, `commit_cache`, `file_status`, `stash_cache` (per `domain-model.md §3`)

Go opens DB and runs `AutoMigrate` or `golang-migrate` over `migrations/` (no seeding — cache derived from `.git`).

## Tables (canonical DDL in `001_initial.sql`)

- `repos(id, fs_path UNIQUE, common_dir, name, created_at, last_opened_at)`
- `commit_cache(repo_id, oid, parents JSON, author_*, committer_*, message, tree_oid, committed_at) PK(repo_id, oid) WITHOUT ROWID, idx on committed_at DESC`
- `file_status(repo_id, path, staged, unstaged, is_staged, is_conflicted) PK(repo_id, path) WITHOUT ROWID`
- `stash_cache(repo_id, stash_index, oid, message, branch_name, created_at) PK(repo_id, stash_index) WITHOUT ROWID`

## Ignored Files

`data/sqlite/*.db`, `*.db-wal`, `*.db-shm`, `*.sqlite*` are gitignored — only `migrations/` and this `README.md` are committed.

## Verification

```bash
sqlite3 ~/.local/share/singularitree/cache.db "PRAGMA journal_mode; SELECT name FROM sqlite_master WHERE type='table';"
```
