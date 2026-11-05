package config

import (
	"os"
	"path/filepath"
)

// Config holds Go core configuration (Viper bindings: grpcAddr, httpAddr, dbPath, token, logLevel).
// In scaffold, loaded from env + defaults without external Viper dependency;
// real implementation will use Viper (github.com/spf13/viper) for config.yaml + env.
type Config struct {
	GrpcAddr string
	HttpAddr string
	DbPath   string
	Token    string
	LogLevel string
	// GhPath is a list of directories (os.PathListSeparator) prepended to PATH
	// when resolving and running the `gh` CLI (SINGULARITREE_GH_PATH).
	GhPath string
	// GitHub OAuth prototype (env GITHUB_*)
	GithubClientID     string
	GithubClientSecret string
	GithubRedirectPort string // e.g. "53682"
	GithubRedirectPath string // e.g. "/callback"
	GithubScopes       string // e.g. "read:user repo"
}

// Load returns Config with defaults and env overrides.
func Load() Config {
	cfg := Config{
		GrpcAddr:           getEnv("SINGULARITREE_GRPC_ADDR", "127.0.0.1:0"),
		HttpAddr:           getEnv("SINGULARITREE_HTTP_ADDR", "127.0.0.1:0"),
		DbPath:             getEnv("SINGULARITREE_DB_PATH", defaultDbPath()),
		Token:              os.Getenv("SINGULARITREE_TOKEN"),
		LogLevel:           getEnv("SINGULARITREE_LOG_LEVEL", "info"),
		GhPath:             getEnv("SINGULARITREE_GH_PATH", ""),
		GithubClientID:     os.Getenv("GITHUB_CLIENT_ID"),
		GithubClientSecret: os.Getenv("GITHUB_CLIENT_SECRET"),
		GithubRedirectPort: getEnv("GITHUB_REDIRECT_PORT", "53682"),
		GithubRedirectPath: getEnv("GITHUB_REDIRECT_PATH", "/callback"),
		GithubScopes:       getEnv("GITHUB_SCOPES", "read:user repo"),
	}
	return cfg
}

func defaultDbPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "./cache.db"
	}
	// Per-user locations per service-design.md §5:
	// macOS ~/Library/Application Support/singularitree/cache.db
	// Windows %APPDATA%/singularitree/cache.db
	// Linux ~/.local/share/singularitree/cache.db
	// Scaffold uses ~/.local/share fallback for portability
	dir := filepath.Join(home, ".local", "share", "singularitree")
	return filepath.Join(dir, "cache.db")
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
