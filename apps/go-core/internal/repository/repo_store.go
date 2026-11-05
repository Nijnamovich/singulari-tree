package repository

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"

	"github.com/SingulariTree/go-core/internal/domain"
)

// RepoStore is the SQLite-backed implementation of domain.RepoPort
// (domain-model.md §1.1, ADR-006). It persists the `repos` table only; Git
// objects stay in `.git`.
type RepoStore struct {
	db *sql.DB
}

// NewRepoStore creates a RepoStore over an opened SQLite database.
// ApplyMigrations must have been called before use.
func NewRepoStore(db *sql.DB) *RepoStore {
	return &RepoStore{db: db}
}

var _ domain.RepoPort = (*RepoStore)(nil)

// Open tracks a repository, upserting by the UNIQUE fs_path. Re-opening an
// already-tracked path preserves its UUID/created_at and refreshes
// last_opened_at. The path is normalized to an absolute, cleaned form.
func (s *RepoStore) Open(ctx context.Context, fsPath string) (*domain.Repository, error) {
	abs, err := filepath.Abs(filepath.Clean(fsPath))
	if err != nil {
		return nil, domain.ErrRepoNotFound.WithDetail("fs_path", fsPath)
	}

	existing, err := s.getByPath(ctx, abs)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		now := time.Now().UTC()
		if _, err := s.db.ExecContext(ctx,
			`UPDATE repos SET last_opened_at = ? WHERE id = ?`,
			now.Format(time.RFC3339Nano), string(existing.ID),
		); err != nil {
			return nil, err
		}
		existing.LastOpenedAt = now
		return existing, nil
	}

	repo, err := domain.NewRepository(domain.RepositoryId(uuid.NewString()), abs, "", "")
	if err != nil {
		return nil, err
	}
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO repos (id, fs_path, common_dir, name, created_at, last_opened_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		string(repo.ID), repo.FsPath, repo.CommonDir, repo.Name,
		repo.CreatedAt.Format(time.RFC3339Nano), repo.LastOpenedAt.Format(time.RFC3339Nano),
	); err != nil {
		return nil, err
	}
	return &repo, nil
}

// List returns tracked repositories, most recently opened first.
//
// last_opened_at alone is not a deterministic total order: on Windows the wall
// clock is read at the coarse system-timer granularity, so two rapid Open calls
// can share the same RFC3339Nano timestamp and SQLite then returns the tied
// rows in an unspecified order. The rowid DESC term breaks the tie towards the
// later-inserted row; re-opening UPDATEs last_opened_at but not rowid, so on an
// exact tie the later-inserted row wins (insertion order, not open order).
// This mirrors the same-package precedent in commit_cache.go
// (ORDER BY committed_at DESC, oid DESC).
func (s *RepoStore) List(ctx context.Context) ([]domain.Repository, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, fs_path, common_dir, name, created_at, last_opened_at
		 FROM repos ORDER BY last_opened_at DESC, rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]domain.Repository, 0)
	for rows.Next() {
		repo, err := scanRepo(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *repo)
	}
	return out, rows.Err()
}

// Remove untracks a repository and (via ON DELETE CASCADE) its cached rows.
func (s *RepoStore) Remove(ctx context.Context, id domain.RepositoryId) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM repos WHERE id = ?`, string(id))
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return domain.ErrRepoNotFound.WithDetail("repo_id", string(id))
	}
	return nil
}

// Get returns a repository by ID.
func (s *RepoStore) Get(ctx context.Context, id domain.RepositoryId) (*domain.Repository, error) {
	return getRepoByID(ctx, s.db, id)
}

// Relocate repoints an already-tracked repository at a new filesystem path,
// preserving its id and created_at and refreshing fs_path, common_dir and name.
// The recorded id is kept on purpose: a delete + re-create would mint a new id,
// cascade away the cached rows and silently lose the registration.
//
// A target already tracked by a different repository id is rejected with
// ErrRepoPathInUse. The repos.fs_path column is UNIQUE, so the conflict check
// and the UPDATE run inside one transaction (s.db.BeginTx): under SQLite's
// single-writer model that makes them atomic, so an interleaved Open/Relocate on
// the target can no longer slip between the check and the write and surface the
// raw constraint error instead of the typed envelope. As belt-and-braces, a
// UNIQUE failure on the UPDATE itself is also mapped to ErrRepoPathInUse (other
// sqlite errors are returned unchanged). A no-op relocate (same path) is allowed
// and still refreshes common_dir and name.
func (s *RepoStore) Relocate(ctx context.Context, id domain.RepositoryId, fsPath string) (*domain.Repository, error) {
	if strings.TrimSpace(fsPath) == "" {
		return nil, domain.ErrRepoPathMissing.WithDetail("fs_path", fsPath)
	}
	abs, err := filepath.Abs(filepath.Clean(fsPath))
	if err != nil {
		return nil, domain.ErrRepoPathMissing.WithDetail("fs_path", fsPath)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	// A read-only path (any error before Commit) leaves the transaction open;
	// roll it back. After a successful Commit this is a no-op returning
	// sql.ErrTxDone, which is deliberately ignored.
	defer func() { _ = tx.Rollback() }()

	// Load by id first so an unknown registration is REPO_NOT_FOUND before any
	// conflict check runs.
	if _, err := getRepoByID(ctx, tx, id); err != nil {
		return nil, err
	}

	other, err := getRepoByPath(ctx, tx, abs)
	if err != nil {
		return nil, err
	}
	if other != nil && other.ID != id {
		return nil, domain.ErrRepoPathInUse.WithDetail("fs_path", abs)
	}

	// common_dir and name are refreshed from the new path exactly like Open
	// derives them for a fresh registration (the default .git under the
	// normalized work tree, and its basename).
	commonDir := filepath.Join(abs, ".git")
	name := filepath.Base(abs)
	if _, err := tx.ExecContext(ctx,
		`UPDATE repos SET fs_path = ?, common_dir = ?, name = ? WHERE id = ?`,
		abs, commonDir, name, string(id),
	); err != nil {
		if isUniqueConstraintErr(err) {
			return nil, domain.ErrRepoPathInUse.WithDetail("fs_path", abs)
		}
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		if isUniqueConstraintErr(err) {
			return nil, domain.ErrRepoPathInUse.WithDetail("fs_path", abs)
		}
		return nil, err
	}
	return s.Get(ctx, id)
}

// rowQuerier is implemented by both *sql.DB and *sql.Tx, letting the read
// helpers run standalone or inside Relocate's transaction.
type rowQuerier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// getRepoByID loads a repository by primary key, mapping "no rows" to the typed
// REPO_NOT_FOUND envelope.
func getRepoByID(ctx context.Context, q rowQuerier, id domain.RepositoryId) (*domain.Repository, error) {
	row := q.QueryRowContext(ctx,
		`SELECT id, fs_path, common_dir, name, created_at, last_opened_at
		 FROM repos WHERE id = ?`, string(id))
	repo, err := scanRepo(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrRepoNotFound.WithDetail("repo_id", string(id))
	}
	if err != nil {
		return nil, err
	}
	return repo, nil
}

// getRepoByPath loads a repository by its UNIQUE fs_path, returning (nil, nil)
// when the path is untracked.
func getRepoByPath(ctx context.Context, q rowQuerier, fsPath string) (*domain.Repository, error) {
	row := q.QueryRowContext(ctx,
		`SELECT id, fs_path, common_dir, name, created_at, last_opened_at
		 FROM repos WHERE fs_path = ?`, fsPath)
	repo, err := scanRepo(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return repo, nil
}

// isUniqueConstraintErr reports whether err is a SQLite UNIQUE-constraint
// violation. modernc.org/sqlite enables extended result codes on every
// connection (conn.go, extendedResultCodes(true)), so a duplicate repos.fs_path
// surfaces as SQLITE_CONSTRAINT_UNIQUE rather than the generic
// SQLITE_CONSTRAINT. Only the UNIQUE code is matched: every other sqlite error
// (including other constraint classes) is returned to the caller untouched.
func isUniqueConstraintErr(err error) bool {
	var sqliteErr *sqlite.Error
	if !errors.As(err, &sqliteErr) {
		return false
	}
	return sqliteErr.Code() == sqlite3.SQLITE_CONSTRAINT_UNIQUE
}

func (s *RepoStore) getByPath(ctx context.Context, fsPath string) (*domain.Repository, error) {
	return getRepoByPath(ctx, s.db, fsPath)
}

// rowScanner unifies *sql.Row and *sql.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanRepo(sc rowScanner) (*domain.Repository, error) {
	var (
		id, fsPath, commonDir, name string
		createdAt, lastOpenedAt     string
	)
	if err := sc.Scan(&id, &fsPath, &commonDir, &name, &createdAt, &lastOpenedAt); err != nil {
		return nil, err
	}
	created, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return nil, err
	}
	opened, err := time.Parse(time.RFC3339Nano, lastOpenedAt)
	if err != nil {
		return nil, err
	}
	return &domain.Repository{
		ID:           domain.RepositoryId(id),
		FsPath:       fsPath,
		CommonDir:    commonDir,
		Name:         name,
		CreatedAt:    created,
		LastOpenedAt: opened,
	}, nil
}
