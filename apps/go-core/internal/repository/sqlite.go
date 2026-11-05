package repository

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	// modernc.org/sqlite is the pure-Go driver chosen in ADR-006 (no CGO).
	_ "modernc.org/sqlite"
)

// dsnPragmas are applied on every connection open (ADR-006, domain-model.md §3):
// WAL journaling, NORMAL sync, FK enforcement, and a 5s busy timeout.
const dsnPragmas = "_pragma=busy_timeout(5000)" +
	"&_pragma=journal_mode(WAL)" +
	"&_pragma=synchronous(NORMAL)" +
	"&_pragma=foreign_keys(ON)"

// OpenSQLite opens (creating if needed) the per-user metadata cache database.
// It creates the parent directory, configures WAL/pragmas via the DSN, and
// verifies connectivity with a ping.
func OpenSQLite(path string) (*sql.DB, error) {
	if path == "" {
		return nil, fmt.Errorf("sqlite path is empty")
	}

	memory := isMemoryPath(path)
	if !memory {
		if dir := filepath.Dir(path); dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, fmt.Errorf("create sqlite dir %s: %w", dir, err)
			}
		}
	}

	db, err := sql.Open("sqlite", buildDSN(path))
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}

	// A private in-memory DB lives per-connection; a single connection keeps the
	// schema visible across queries.
	if memory {
		db.SetMaxOpenConns(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	return db, nil
}

func isMemoryPath(path string) bool {
	return path == ":memory:" || strings.Contains(path, "mode=memory")
}

// buildDSN converts a filesystem path into a modernc.org/sqlite DSN carrying
// the required pragmas. Handles both real files and in-memory databases.
func buildDSN(path string) string {
	if isMemoryPath(path) {
		if path == ":memory:" {
			return "file::memory:?" + dsnPragmas
		}
		return path + "?" + dsnPragmas
	}
	if strings.HasPrefix(path, "file:") {
		return path + "?" + dsnPragmas
	}
	return fileURI(path) + "?" + dsnPragmas
}

// fileURI converts a filesystem path into a SQLite "file:" URI. SQLite (and
// therefore modernc.org/sqlite, which opens the DSN with SQLITE_OPEN_URI)
// requires forward slashes and a rooted path. A Windows drive path such as
// C:\Users\me\cache.db must become file:///C:/Users/me/cache.db; passing it
// straight through net/url yields file://C:%5CUsers%5C... where SQLite parses
// "C:" as an (invalid) URI authority and fails with "invalid uri authority".
//
// Drive detection is host-independent so the conversion is deterministic when
// cross-compiled and unit-tested on a non-Windows host. Path characters that
// need escaping (spaces, '#', '?') are still handled by net/url.
func fileURI(path string) string {
	p := filepath.ToSlash(path)
	if drive, ok := windowsDrivePath(p); ok {
		p = "/" + drive
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	u := url.URL{Scheme: "file", Path: p}
	return u.String()
}

// windowsDrivePath reports whether p is a Windows drive-absolute path (e.g.
// "C:/dir/db" or "C:\dir\db") and returns it with backslashes normalized to
// forward slashes.
func windowsDrivePath(p string) (string, bool) {
	if len(p) < 2 || p[1] != ':' {
		return "", false
	}
	c := p[0]
	if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') {
		return strings.ReplaceAll(p, `\`, `/`), true
	}
	return "", false
}
