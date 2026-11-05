package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	googlegrpc "google.golang.org/grpc"

	"github.com/SingulariTree/go-core/internal/adapter/ghcli"
	"github.com/SingulariTree/go-core/internal/adapter/git"
	"github.com/SingulariTree/go-core/internal/adapter/github"
	grpcadapter "github.com/SingulariTree/go-core/internal/adapter/grpc"
	httpadapter "github.com/SingulariTree/go-core/internal/adapter/http"
	"github.com/SingulariTree/go-core/internal/adapter/watcher"
	"github.com/SingulariTree/go-core/internal/config"
	"github.com/SingulariTree/go-core/internal/domain"
	"github.com/SingulariTree/go-core/internal/repository"
	"github.com/SingulariTree/go-core/internal/service"
)

// Headless proof — architecture.md §5 / ADR-007.
// Prints GO_CORE_READY addr=... http=... token=... so the Electron supervisor
// can discover the bound addresses and auth token.

type logLevel int

const (
	levelDebug logLevel = iota
	levelInfo
	levelWarn
	levelError
)

var minLevel = levelInfo

func parseLevel(s string) logLevel {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return levelDebug
	case "warn", "warning":
		return levelWarn
	case "error":
		return levelError
	default:
		return levelInfo
	}
}

func logf(l logLevel, format string, args ...any) {
	if l < minLevel {
		return
	}
	log.Printf(format, args...)
}

func main() {
	var (
		headless  = flag.Bool("headless", false, "run in headless mode (no Electron required)")
		grpcAddr  = flag.String("grpc-addr", "127.0.0.1:0", "gRPC listen addr (unix:///tmp/... or 127.0.0.1:0)")
		httpAddr  = flag.String("http-fallback-addr", "127.0.0.1:0", "HTTP fallback listen addr")
		dbPath    = flag.String("db", "", "SQLite DB path (default per-user location)")
		logLevel  = flag.String("log-level", "info", "log level (debug|info|warn|error)")
		tokenFlag = flag.String("token", "", "auth token (generated if empty in headless)")
	)
	// Alias --http-addr for --http-fallback-addr.
	httpFallbackAlias := flag.String("http-addr", "", "alias for --http-fallback-addr")
	flag.Parse()

	minLevel = parseLevel(*logLevel)

	effectiveHTTP := *httpAddr
	if *httpFallbackAlias != "" {
		effectiveHTTP = *httpFallbackAlias
	}

	token := *tokenFlag
	if token == "" && *headless {
		generated, err := generateToken()
		if err != nil {
			// A predictable security token is worse than failing to start.
			log.Fatalf("generate auth token: %v", err)
		}
		token = generated
	}
	if token == "" {
		token = "dev-token"
	}

	// Load configuration once and reuse it (DB default + GitHub CLI search path).
	cfg := config.Load()

	// Early, non-fatal diagnostic: warn when `gh` cannot be resolved so the user
	// learns within the first seconds (github-real-data-guide.md §13 item 1).
	if _, ok := ghcli.Lookup(ghcli.SearchedPath(cfg.GhPath), "gh"); !ok {
		logf(levelWarn, "gh CLI not found (searched: %s)", ghcli.SearchedPath(cfg.GhPath))
	}

	// Resolve DB path: flag wins, else per-user config default.
	effectiveDB := *dbPath
	if effectiveDB == "" {
		effectiveDB = cfg.DbPath
	}
	db, err := repository.OpenSQLite(effectiveDB)
	if err != nil {
		log.Fatalf("open sqlite %s: %v", effectiveDB, err)
	}
	defer func() { _ = db.Close() }()

	if err := repository.ApplyMigrations(context.Background(), db); err != nil {
		log.Fatalf("apply migrations: %v", err)
	}
	logf(levelInfo, "sqlite ready db=%s", effectiveDB)

	// Composition root wiring (ADR-001).
	repoStore := repository.NewRepoStore(db)
	gitAdapter := git.NewAdapter(repoStore)
	repoSvc := service.NewRepoService(repoStore, gitAdapter)
	commitCache := repository.NewCommitCache(db)
	cacheSvc := service.NewCacheServiceWithStore(service.DefaultLRUCapacity, commitCache)
	graphSvc := service.NewGraphService(gitAdapter, cacheSvc)
	watcherSvc := service.NewWatcherService(watcher.NewFsnotifyAdapter(
		func(id domain.RepositoryId) (string, bool) {
			r, err := repoStore.Get(context.Background(), id)
			if err != nil || r == nil {
				return "", false
			}
			return r.FsPath, true
		},
	))
	gitSvc := service.NewGitService(gitAdapter, cacheSvc, watcherSvc)

	// git-flow presets (ADR-027): workflow semantics over the ADR-028 Git ops,
	// with per-repo config persisted as SQLite metadata.
	gitflowSvc := service.NewGitFlowService(gitAdapter, repository.NewGitFlowStore(db))

	// GitHub real-data vertical: token from `gh` CLI, REST over api.github.com.
	githubAdapter := github.NewAdapter(&http.Client{Timeout: 15 * time.Second})
	ghSource := ghcli.NewTokenSource(cfg.GhPath)
	authSvc := service.NewAuthService(githubAdapter, ghSource, service.AuthConfig{GhSearchPath: cfg.GhPath})
	authServer := grpcadapter.NewAuthServer(authSvc)

	// A filesystem change (including HEAD moves from GitService mutating ops)
	// invalidates derived state: the stateful lane layout and the commit cache,
	// so both are recomputed from the new tip instead of serving stale data.
	watcherSvc.OnChange(func(ev domain.FsChangedEvent) {
		graphSvc.Invalidate(ev.RepoID)
		cacheSvc.Invalidate(ev.RepoID)
	})

	// Listeners — unix socket for gRPC when requested, TCP loopback otherwise.
	grpcLis, grpcAddrStr, err := listen(*grpcAddr)
	if err != nil {
		log.Fatalf("grpc listen failed: %v", err)
	}
	defer func() { _ = grpcLis.Close() }()

	httpLis, httpAddrStr, err := listenTCP(effectiveHTTP)
	if err != nil {
		log.Fatalf("http listen failed: %v", err)
	}
	defer func() { _ = httpLis.Close() }()

	// HTTP fallback (JSON, loopback-only, token-guarded).
	handler := httpadapter.NewHandler(repoSvc, gitSvc, graphSvc, token)
	mux := http.NewServeMux()
	handler.Register(mux)
	httpSrv := &http.Server{Handler: handler.AuthMiddleware(mux)}
	go func() {
		if err := httpSrv.Serve(httpLis); err != nil && err != http.ErrServerClosed {
			logf(levelError, "http serve error: %v", err)
		}
	}()

	// gRPC server with token interceptors.
	grpcSrv := grpcadapter.NewServer(repoSvc, gitSvc, graphSvc, watcherSvc, cacheSvc, gitflowSvc, token)
	gs := googlegrpc.NewServer(
		googlegrpc.UnaryInterceptor(grpcadapter.UnaryAuthInterceptor(token)),
		googlegrpc.StreamInterceptor(grpcadapter.StreamAuthInterceptor(token)),
	)
	grpcSrv.Register(gs)
	authServer.Register(gs)
	go func() {
		if err := gs.Serve(grpcLis); err != nil && err != googlegrpc.ErrServerStopped {
			logf(levelError, "grpc serve error: %v", err)
		}
	}()

	if *headless {
		// Required stdout line for supervisor discovery (ipc-strategy.md §2.6).
		fmt.Printf("GO_CORE_READY addr=%s http=%s token=%s\n", grpcAddrStr, httpAddrStr, token)
		_ = os.Stdout.Sync()
	} else {
		logf(levelInfo, "go-core listening grpc=%s http=%s (use --headless to emit GO_CORE_READY)", grpcAddrStr, httpAddrStr)
	}

	// Graceful shutdown on SIGTERM/SIGINT (5s hard fallback).
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	<-ctx.Done()
	logf(levelInfo, "shutting down...")

	stopped := make(chan struct{})
	go func() {
		gs.GracefulStop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		logf(levelWarn, "grpc graceful stop timed out; forcing stop")
		gs.Stop()
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
}

// listen binds addr, supporting unix:///path sockets and TCP loopback.
// It returns the listener and the address string to advertise.
func listen(addr string) (net.Listener, string, error) {
	if isUnixAddr(addr) {
		path := strings.TrimPrefix(addr, "unix://")
		if dir := filepath.Dir(path); dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, "", err
			}
		}
		// Remove a stale socket left by a crashed previous process.
		if _, err := os.Stat(path); err == nil {
			if err := os.Remove(path); err != nil {
				return nil, "", fmt.Errorf("remove stale socket %s: %w", path, err)
			}
		}
		// Restrict the umask before Listen so the socket is never briefly
		// world/group-accessible (0o600 is still applied explicitly below).
		prevUmask := setUmask(0o077)
		lis, err := net.Listen("unix", path)
		setUmask(prevUmask)
		if err != nil {
			return nil, "", err
		}
		_ = os.Chmod(path, 0o600)
		return lis, "unix://" + path, nil
	}
	return listenTCP(addr)
}

// listenTCP binds a TCP listener on loopback only.
func listenTCP(addr string) (net.Listener, string, error) {
	normalized, err := normalizeTCPAddr(addr)
	if err != nil {
		return nil, "", err
	}
	lis, err := net.Listen("tcp", normalized)
	if err != nil {
		return nil, "", err
	}
	return lis, lis.Addr().String(), nil
}

// normalizeTCPAddr forces the host to loopback (ADR-004 / ipc-strategy.md §2.7).
func normalizeTCPAddr(addr string) (string, error) {
	if addr == "" {
		return "127.0.0.1:0", nil
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "", err
	}
	switch host {
	case "", "0.0.0.0", "::", "[::]":
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, port), nil
}

func isUnixAddr(addr string) bool {
	return strings.HasPrefix(addr, "unix://")
}

// generateToken returns 32 cryptographically-random bytes as 64 hex chars
// (ipc-strategy.md §2.4). It never falls back to a predictable value: on entropy
// failure the error is returned so the caller can refuse to start.
func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("crypto/rand.Read: %w", err)
	}
	return hex.EncodeToString(b), nil
}
