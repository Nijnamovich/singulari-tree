-- 001_initial.sql — SingulariTree SQLite schema (domain-model.md §3)
-- WAL: PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;

-- One row per tracked repository/worktree
CREATE TABLE IF NOT EXISTS repos (
  id              TEXT PRIMARY KEY,
  fs_path         TEXT NOT NULL UNIQUE,
  common_dir      TEXT NOT NULL,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_opened_at  TEXT NOT NULL
);

-- Cache of commits — windowed by GraphService (200+100 pattern)
CREATE TABLE IF NOT EXISTS commit_cache (
  repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  oid             TEXT NOT NULL,
  parents         TEXT NOT NULL,
  author_name     TEXT NOT NULL,
  author_email    TEXT NOT NULL,
  author_when     TEXT NOT NULL,
  committer_name  TEXT NOT NULL,
  committer_email TEXT NOT NULL,
  committer_when  TEXT NOT NULL,
  message         TEXT NOT NULL,
  tree_oid        TEXT NOT NULL,
  committed_at    TEXT NOT NULL,
  PRIMARY KEY (repo_id, oid)
) WITHOUT ROWID;

-- Working-tree file status (porcelain v2 / index vs HEAD)
CREATE TABLE IF NOT EXISTS file_status (
  repo_id       TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  staged        TEXT NOT NULL,
  unstaged      TEXT NOT NULL,
  is_staged     INTEGER NOT NULL,
  is_conflicted INTEGER NOT NULL,
  PRIMARY KEY (repo_id, path)
) WITHOUT ROWID;

-- Stash cache (optional — also readable from refs/stash)
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
