-- 002_commit_stats.sql — per-commit change-size gauge cache (ADR-0023)
-- Counts only: additions/deletions/files_changed. NEVER Git objects/blobs.

-- Cached change-size counts, computed lazily for the visited commit window.
CREATE TABLE IF NOT EXISTS commit_stats (
  repo_id       TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  oid           TEXT NOT NULL,
  additions     INTEGER NOT NULL,
  deletions     INTEGER NOT NULL,
  files_changed INTEGER NOT NULL,
  PRIMARY KEY (repo_id, oid)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_commit_stats_repo ON commit_stats(repo_id);
