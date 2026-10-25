// Package ghcli resolves the GitHub CLI binary and reads the authenticated
// token from `gh auth token` (github-real-data-guide.md §3 HS1, §13 item 1).
//
// The Go core is the only owner of the token and of the network: the token is
// held in memory, never serialized to the renderer, and raw stderr from `gh` is
// never surfaced (it can echo the user).
package ghcli

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/SingulariTree/go-core/internal/domain"
)

// User-facing copy. The renderer surfaces AppError.message verbatim, so each
// message names the next action instead of restating the failure.
const (
	ghNotFoundMessage        = "GitHub CLI (gh) not found. Install it (winget install --id GitHub.cli, or scoop install gh), then run: gh auth login"
	ghLaunchFailedMessage    = "GitHub CLI (gh) was found but could not be started. Check the file's permissions or antivirus, then retry."
	ghUnauthenticatedMessage = "GitHub CLI (gh) is installed but not signed in. Run: gh auth login, then retry"
)

// defaultWindowsExtensions mirrors the default PATHEXT order used by os/exec.
// It is only a fallback: the child environment's PATHEXT wins whenever it is
// set, so the resolver probes exactly what the OS would.
var defaultWindowsExtensions = []string{".com", ".exe", ".bat", ".cmd"}

// CommandRunner executes a resolved binary and returns stdout, stderr and the
// process exit code. It is injectable so tests never touch a real `gh`.
type CommandRunner func(ctx context.Context, path string, env []string, args ...string) (stdout, stderr string, exitCode int, err error)

// TokenSource obtains a GitHub token from the `gh` CLI.
type TokenSource struct {
	searchPath string
	run        CommandRunner
	goos       string
	getenv     func(string) string
}

// NewTokenSource creates a TokenSource whose binary resolution searches the
// SINGULARITREE_GH_PATH dirs (searchPath, split on os.PathListSeparator) first,
// then the inherited PATH, then the platform's well-known install directories
// (github-real-data-guide.md §13 item 1). The well-known dirs matter in packaged
// builds, whose process PATH does not include the GitHub CLI installer's
// location.
func NewTokenSource(searchPath string) *TokenSource {
	return newTokenSource(searchPath, execRunner, runtime.GOOS, os.Getenv)
}

// NewTokenSourceWithRunner creates a TokenSource with an injected runner; used
// by tests.
func NewTokenSourceWithRunner(searchPath string, runner CommandRunner) *TokenSource {
	return newTokenSource(searchPath, runner, runtime.GOOS, os.Getenv)
}

// NewTokenSourceWithEnvironment creates a TokenSource with the OS profile and
// the environment lookup injected, so resolution is deterministic in tests
// instead of depending on the host's real PATH and install locations.
func NewTokenSourceWithEnvironment(searchPath string, runner CommandRunner, goos string, getenv func(string) string) *TokenSource {
	return newTokenSource(searchPath, runner, goos, getenv)
}

func newTokenSource(searchPath string, runner CommandRunner, goos string, getenv func(string) string) *TokenSource {
	if goos == "" {
		goos = runtime.GOOS
	}
	if getenv == nil {
		getenv = os.Getenv
	}
	if runner == nil {
		runner = execRunner
	}
	return &TokenSource{searchPath: searchPath, run: runner, goos: goos, getenv: getenv}
}

// Token runs `<gh> auth token` and returns the trimmed token.
//
// Errors are structured and never include raw stderr:
//   - GH_CLI_NOT_FOUND: binary unresolved (Details {binary, searched_path}) or
//     the resolved binary could not be executed, i.e. the process never started
//     (Details {binary, exit_code}).
//   - GH_CLI_UNAUTHENTICATED: the process ran but exited non-zero or produced no
//     token; Details {binary, exit_code}.
func (s *TokenSource) Token(ctx context.Context, ghBinary string) (string, error) {
	if ghBinary == "" {
		ghBinary = "gh"
	}
	combined := SearchedPathFor(s.searchPath, s.goos, s.getenv)
	binary, ok := LookupFor(combined, ghBinary, s.goos, s.getenv)
	if !ok {
		return "", domain.AppError{
			Code:    domain.ErrCodeGHCLINotFound,
			Message: ghNotFoundMessage,
			Details: map[string]string{
				"binary":        ghBinary,
				"searched_path": combined,
			},
		}
	}

	stdout, _, exitCode, err := s.run(ctx, binary, withPath(combined), "auth", "token")
	token := strings.TrimSpace(stdout)
	if err != nil || exitCode != 0 || token == "" {
		// A runner error with a zero exit code means the process never started;
		// normalize to the -1 launch-failure sentinel (real exit codes are
		// 0-255, so a negative code is unambiguously "never ran").
		if exitCode == 0 && err != nil {
			exitCode = -1
		}
		// Launch/exec failure is a resolution problem, not an auth problem:
		// reporting it as "not authenticated" would wrongly send the user to
		// `gh auth login`, and the not-found copy would wrongly ask them to
		// install a binary that is already present. Raw stderr is never
		// surfaced.
		if exitCode < 0 {
			return "", domain.AppError{
				Code:    domain.ErrCodeGHCLINotFound,
				Message: ghLaunchFailedMessage,
				Details: map[string]string{
					"binary":    binary,
					"exit_code": strconv.Itoa(exitCode),
				},
			}
		}
		return "", domain.AppError{
			Code:    domain.ErrCodeGHCLIUnauthenticated,
			Message: ghUnauthenticatedMessage,
			Details: map[string]string{
				"binary":    binary,
				"exit_code": strconv.Itoa(exitCode),
			},
		}
	}
	return token, nil
}

// Lookup resolves ghBinary against searchPath (a PATH-style list) on the host
// OS. It is exactly LookupFor with the host OS profile and process environment,
// so a boot-time diagnostic success implies Token can resolve the same binary.
// There is deliberately no exec.LookPath fallback: it would answer from the
// parent PATH even when the documented search list (and the reported
// searched_path) does not contain the binary, reintroducing the divergence
// between the diagnostic and Token.
func Lookup(searchPath, ghBinary string) (string, bool) {
	return LookupFor(searchPath, ghBinary, runtime.GOOS, os.Getenv)
}

// LookupFor is the single resolution path shared by Lookup and TokenSource.
// It walks only the supplied search list, so GH_CLI_NOT_FOUND
// details.searched_path stays honest, and returns an absolute executable path.
// The directory loop is required because exec.Command resolves against the
// parent PATH; on Windows it also probes the PATHEXT extensions read through
// getenv, because the shipped binary is `gh.exe`.
func LookupFor(searchPath, ghBinary, goos string, getenv func(string) string) (string, bool) {
	if getenv == nil {
		getenv = os.Getenv
	}
	if ghBinary == "" {
		ghBinary = "gh"
	}
	if filepath.IsAbs(ghBinary) || strings.ContainsRune(ghBinary, os.PathSeparator) {
		if isExecutable(ghBinary, goos) {
			return absolute(ghBinary), true
		}
		return "", false
	}
	names := candidateNames(ghBinary, goos, getenv)
	for _, dir := range filepath.SplitList(searchPath) {
		if dir == "" {
			dir = "."
		}
		for _, name := range names {
			candidate := filepath.Join(dir, name)
			if isExecutable(candidate, goos) {
				return absolute(candidate), true
			}
		}
	}
	return "", false
}

// candidateNames returns the file names tried in each directory: the binary
// itself first, then (on Windows only, and only when ghBinary carries no
// extension of its own) the PATHEXT extensions.
func candidateNames(ghBinary, goos string, getenv func(string) string) []string {
	if goos != "windows" || filepath.Ext(ghBinary) != "" {
		return []string{ghBinary}
	}
	exts := windowsExtensions(goos, getenv)
	names := make([]string, 0, 1+len(exts))
	names = append(names, ghBinary)
	for _, ext := range exts {
		names = append(names, ghBinary+ext)
	}
	return names
}

// windowsExtensions returns the extension probes for goos. On Windows it reads
// PATHEXT (split on ';', trimmed, empty entries skipped, deduplicated
// case-insensitively, original order and spelling preserved) so the resolver
// probes exactly what the OS would; the platform default is used only when
// PATHEXT is unset or has no usable entry. Non-Windows profiles probe nothing.
func windowsExtensions(goos string, getenv func(string) string) []string {
	if goos != "windows" {
		return nil
	}
	raw := strings.TrimSpace(getenv("PATHEXT"))
	if raw == "" {
		return defaultWindowsExtensions
	}
	seen := make(map[string]struct{}, 4)
	exts := make([]string, 0, 4)
	for _, part := range strings.Split(raw, ";") {
		ext := strings.TrimSpace(part)
		if ext == "" {
			continue
		}
		key := strings.ToUpper(ext)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		exts = append(exts, ext)
	}
	if len(exts) == 0 {
		return defaultWindowsExtensions
	}
	return exts
}

// SearchedPath returns the PATH actually searched when resolving the gh binary
// on the host OS: the SINGULARITREE_GH_PATH dirs, then the inherited PATH, then
// the platform's well-known install dirs. It feeds both Lookup and the
// GH_CLI_NOT_FOUND details.searched_path and the early startup diagnostic.
func SearchedPath(searchPath string) string {
	return SearchedPathFor(searchPath, runtime.GOOS, os.Getenv)
}

// SearchedPathFor is SearchedPath with the OS profile and the environment
// lookup injected, so tests never depend on the host's real paths. Precedence
// is preserved: explicit searchPath dirs → inherited PATH → well-known dirs.
// Empty entries are skipped and duplicates (case-insensitive on Windows) are
// removed while keeping the first occurrence.
func SearchedPathFor(searchPath, goos string, getenv func(string) string) string {
	if getenv == nil {
		getenv = os.Getenv
	}
	seen := make(map[string]struct{}, 8)
	out := make([]string, 0, 8)
	appendDir := func(dir string) {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			return
		}
		key := dirKey(dir, goos)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		out = append(out, dir)
	}
	for _, dir := range filepath.SplitList(searchPath) {
		appendDir(dir)
	}
	for _, dir := range filepath.SplitList(getenv("PATH")) {
		appendDir(dir)
	}
	for _, dir := range wellKnownDirs(goos, getenv) {
		appendDir(dir)
	}
	return strings.Join(out, string(os.PathListSeparator))
}

// wellKnownDirs returns the platform's documented GitHub CLI install
// locations, in priority order, resolved through getenv so it is deterministic
// under test. Variables that are unset or empty are skipped; the directories do
// not have to exist (Lookup stats the candidate binary instead).
func wellKnownDirs(goos string, getenv func(string) string) []string {
	var dirs []string
	if goos == "windows" {
		// winget, the GitHub CLI MSI, Scoop, and (x86) Program Files.
		specs := []struct{ env, sub string }{
			{"LOCALAPPDATA", filepath.Join("Programs", "GitHub CLI")},
			{"LOCALAPPDATA", filepath.Join("Microsoft", "WinGet", "Links")},
			{"LOCALAPPDATA", filepath.Join("GitHubCLI", "bin")},
			{"USERPROFILE", filepath.Join("scoop", "shims")},
			{"ProgramFiles", "GitHub CLI"},
			{"ProgramFiles(x86)", "GitHub CLI"},
		}
		for _, spec := range specs {
			base := strings.TrimSpace(getenv(spec.env))
			if base == "" {
				continue
			}
			dirs = append(dirs, filepath.Join(base, spec.sub))
		}
		return dirs
	}
	// A deliberately small set of standard Unix locations: Homebrew (both
	// prefixes) and the conventional per-user bin directory.
	dirs = append(dirs, "/usr/local/bin", "/opt/homebrew/bin")
	if home := strings.TrimSpace(getenv("HOME")); home != "" {
		dirs = append(dirs, filepath.Join(home, ".local", "bin"))
	}
	return dirs
}

func dirKey(dir, goos string) string {
	cleaned := filepath.Clean(dir)
	if goos == "windows" {
		// Windows filesystems and PATH matching are case-insensitive.
		return strings.ToLower(cleaned)
	}
	return cleaned
}

func absolute(path string) string {
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return path
}

func isExecutable(path, goos string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	// Windows has no POSIX execute bit: os.Stat reports mode 0666 for every
	// regular file and sets 0111 only for directories (GOROOT/src/os/types_windows.go),
	// so the Unix check below would reject every candidate on Windows. That
	// silently demotes the search-path loop in Lookup and lets the exec.LookPath
	// fallback resolve `gh` from the inherited PATH, inverting the documented
	// search-path-first precedence (see NewTokenSource and Lookup). Mirror
	// os/exec's own chkStat (lp_windows.go): any existing non-directory is a
	// runnable candidate.
	if goos == "windows" {
		return true
	}
	return info.Mode().Perm()&0o111 != 0
}

// withPath returns a copy of the process environment with PATH replaced by
// combined, so the child `gh` resolves its own helpers from the same list.
func withPath(combined string) []string {
	env := os.Environ()
	out := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if strings.HasPrefix(strings.ToUpper(entry), "PATH=") {
			continue
		}
		out = append(out, entry)
	}
	return append(out, "PATH="+combined)
}

// execRunner is the default CommandRunner; it executes the resolved absolute
// path directly and captures stdout/stderr separately.
func execRunner(ctx context.Context, path string, env []string, args ...string) (string, string, int, error) {
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = env
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}
	return stdout.String(), stderr.String(), exitCode, err
}
