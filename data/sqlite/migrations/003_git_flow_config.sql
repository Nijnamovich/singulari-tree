-- 003_git_flow_config.sql — per-repo git-flow preset configuration (ADR-027)
-- Config metadata only (branch names + prefixes). NEVER Git objects or refs.

CREATE TABLE IF NOT EXISTS git_flow_config (
  repo_id            TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  main_branch        TEXT NOT NULL,
  develop_branch     TEXT NOT NULL,
  feature_prefix     TEXT NOT NULL,
  release_prefix     TEXT NOT NULL,
  hotfix_prefix      TEXT NOT NULL,
  version_tag_prefix TEXT NOT NULL
) WITHOUT ROWID;