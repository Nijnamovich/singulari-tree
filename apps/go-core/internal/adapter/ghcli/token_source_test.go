package ghcli_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/SingulariTree/go-core/internal/adapter/ghcli"
	"github.com/SingulariTree/go-core/internal/domain"
)

// fakeEnv makes environment lookup deterministic: only the keys present in
// vars are visible, everything else is unset (so no host path can leak in).
func fakeEnv(vars map[string]string) func(string) string {
	return func(key string) string { return vars[key] }
}

func joinList(dirs ...string) string {
	return strings.Join(dirs, string(os.PathListSeparator))
}

func writeExecutable(t *testing.T, dir, name string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write executable: %v", err)
	}
	return path
}

func TestTokenFoundAndTrimmed(t *testing.T) {
	dir := t.TempDir()
	bin := writeExecutable(t, dir, "gh")
	t.Setenv("PATH", "")
	env := fakeEnv(map[string]string{"PATH": ""})

	var gotPath string
	var gotEnv []string
	var gotArgs []string
	src := ghcli.NewTokenSourceWithEnvironment(dir, func(_ context.Context, path string, env []string, args ...string) (string, string, int, error) {
		gotPath = path
		gotEnv = env
		gotArgs = args
		return "  gh_token_123 \n", "", 0, nil
	}, "windows", env)

	token, err := src.Token(context.Background(), "")
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if token != "gh_token_123" {
		t.Errorf("token = %q, want %q", token, "gh_token_123")
	}
	if gotPath != bin {
		t.Errorf("resolved path = %q, want %q", gotPath, bin)
	}
	if len(gotArgs) != 2 || gotArgs[0] != "auth" || gotArgs[1] != "token" {
		t.Errorf("args = %v, want [auth token]", gotArgs)
	}
	wantPath := "PATH=" + ghcli.SearchedPathFor(dir, "windows", env)
	foundPath := false
	for _, entry := range gotEnv {
		if entry == wantPath {
			foundPath = true
		}
	}
	if !foundPath {
		t.Errorf("child env does not carry %s: %v", wantPath, gotEnv)
	}
}

func TestTokenNotFound(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	env := fakeEnv(map[string]string{"PATH": dir})

	src := ghcli.NewTokenSourceWithEnvironment(dir, func(context.Context, string, []string, ...string) (string, string, int, error) {
		t.Fatal("runner must not be called when the binary is missing")
		return "", "", 0, nil
	}, "windows", env)

	_, err := src.Token(context.Background(), "gh")
	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want domain.AppError", err)
	}
	if appErr.Code != domain.ErrCodeGHCLINotFound {
		t.Errorf("code = %q, want %q", appErr.Code, domain.ErrCodeGHCLINotFound)
	}
	if appErr.Details["binary"] != "gh" {
		t.Errorf("details.binary = %q, want gh", appErr.Details["binary"])
	}
	want := ghcli.SearchedPathFor(dir, "windows", env)
	if appErr.Details["searched_path"] != want {
		t.Errorf("details.searched_path = %q, want %q", appErr.Details["searched_path"], want)
	}
}

func TestTokenUnauthenticatedNeverLeaksStderr(t *testing.T) {
	dir := t.TempDir()
	writeExecutable(t, dir, "gh")
	t.Setenv("PATH", "")

	const secret = "SECRET-STDERR-99"
	src := ghcli.NewTokenSourceWithRunner(dir, func(context.Context, string, []string, ...string) (string, string, int, error) {
		return "", "gh: " + secret, 1, errors.New("exit status 1")
	})

	_, err := src.Token(context.Background(), "gh")
	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want domain.AppError", err)
	}
	if appErr.Code != domain.ErrCodeGHCLIUnauthenticated {
		t.Errorf("code = %q, want %q", appErr.Code, domain.ErrCodeGHCLIUnauthenticated)
	}
	if appErr.Details["exit_code"] != "1" {
		t.Errorf("details.exit_code = %q, want 1", appErr.Details["exit_code"])
	}
	if strings.Contains(appErr.Message, secret) {
		t.Errorf("message leaked stderr: %q", appErr.Message)
	}
	for k, v := range appErr.Details {
		if strings.Contains(k, secret) || strings.Contains(v, secret) {
			t.Errorf("details leaked stderr: %s=%s", k, v)
		}
	}
}

func TestTokenLaunchFailureIsNotFound(t *testing.T) {
	dir := t.TempDir()
	bin := writeExecutable(t, dir, "gh")
	t.Setenv("PATH", "")

	const secret = "SECRET-LAUNCH-STDERR"
	src := ghcli.NewTokenSourceWithRunner(dir, func(context.Context, string, []string, ...string) (string, string, int, error) {
		// A resolved binary that could not be executed: the process never ran.
		return "", secret, -1, errors.New("fork/exec: permission denied")
	})

	_, err := src.Token(context.Background(), "gh")
	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want domain.AppError", err)
	}
	if appErr.Code != domain.ErrCodeGHCLINotFound {
		t.Errorf("code = %q, want %q (launch failure is not an auth failure)", appErr.Code, domain.ErrCodeGHCLINotFound)
	}
	if appErr.Details["binary"] != bin {
		t.Errorf("details.binary = %q, want %q", appErr.Details["binary"], bin)
	}
	if appErr.Details["exit_code"] != "-1" {
		t.Errorf("details.exit_code = %q, want -1", appErr.Details["exit_code"])
	}
	for k, v := range appErr.Details {
		if strings.Contains(k, secret) || strings.Contains(v, secret) {
			t.Errorf("details leaked stderr: %s=%s", k, v)
		}
	}
	if strings.Contains(appErr.Message, secret) {
		t.Errorf("message leaked stderr: %q", appErr.Message)
	}
	assertActionableLaunchFailureMessage(t, appErr.Message)
}

func TestTokenEmptyStdoutIsUnauthenticated(t *testing.T) {
	dir := t.TempDir()
	writeExecutable(t, dir, "gh")
	t.Setenv("PATH", "")

	src := ghcli.NewTokenSourceWithRunner(dir, func(context.Context, string, []string, ...string) (string, string, int, error) {
		return "   \n", "", 0, nil
	})

	_, err := src.Token(context.Background(), "gh")
	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want domain.AppError", err)
	}
	if appErr.Code != domain.ErrCodeGHCLIUnauthenticated {
		t.Errorf("code = %q, want %q", appErr.Code, domain.ErrCodeGHCLIUnauthenticated)
	}
}

func TestLookupPrefersSearchPathOverParentPath(t *testing.T) {
	searchDir := t.TempDir()
	otherDir := t.TempDir()
	want := writeExecutable(t, searchDir, "gh")
	writeExecutable(t, otherDir, "gh")

	searchPath := joinList(searchDir, otherDir)
	got, ok := ghcli.Lookup(searchPath, "gh")
	if !ok {
		t.Fatal("Lookup returned not found")
	}
	if got != want {
		t.Errorf("Lookup = %q, want %q", got, want)
	}
}

func TestLookupAbsolutePathReturnedAsIs(t *testing.T) {
	searchDir := t.TempDir()
	otherDir := t.TempDir()
	absolute := writeExecutable(t, otherDir, "gh")
	// A same-named binary in the search path must not shadow the absolute one.
	writeExecutable(t, searchDir, "gh")

	got, ok := ghcli.Lookup(searchDir, absolute)
	if !ok {
		t.Fatal("Lookup returned not found for an absolute executable path")
	}
	if got != absolute {
		t.Errorf("Lookup = %q, want %q", got, absolute)
	}
}

// --- well-known install locations -----------------------------------------

func TestSearchedPathPrecedenceExplicitThenPathThenWellKnown(t *testing.T) {
	explicitDir := filepath.Join("fake", "explicit")
	pathA := filepath.Join("fake", "path-a")
	pathB := filepath.Join("fake", "path-b")
	localAppData := filepath.Join("fake", "local")
	userProfile := filepath.Join("fake", "home")
	programFiles := filepath.Join("fake", "pf")
	programFilesX86 := filepath.Join("fake", "pf86")

	env := fakeEnv(map[string]string{
		"PATH":              joinList(pathA, pathB),
		"LOCALAPPDATA":      localAppData,
		"USERPROFILE":       userProfile,
		"ProgramFiles":      programFiles,
		"ProgramFiles(x86)": programFilesX86,
	})

	got := ghcli.SearchedPathFor(explicitDir, "windows", env)
	dirs := filepath.SplitList(got)

	want := []string{
		explicitDir,
		pathA,
		pathB,
		filepath.Join(localAppData, "Programs", "GitHub CLI"),
		filepath.Join(localAppData, "Microsoft", "WinGet", "Links"),
		filepath.Join(localAppData, "GitHubCLI", "bin"),
		filepath.Join(userProfile, "scoop", "shims"),
		filepath.Join(programFiles, "GitHub CLI"),
		filepath.Join(programFilesX86, "GitHub CLI"),
	}
	if !reflect.DeepEqual(dirs, want) {
		t.Fatalf("SearchedPathFor =\n%q\nwant\n%q", dirs, want)
	}
}

func TestSearchedPathDeduplicates(t *testing.T) {
	shared := filepath.Join("fake", "shared")
	localAppData := filepath.Join("fake", "local")
	winGet := filepath.Join(localAppData, "Microsoft", "WinGet", "Links")
	upperShared := strings.ToUpper(shared)

	explicit := joinList(shared, upperShared, winGet)
	env := fakeEnv(map[string]string{
		"PATH":         joinList(shared, winGet, shared),
		"LOCALAPPDATA": localAppData,
	})

	dirs := filepath.SplitList(ghcli.SearchedPathFor(explicit, "windows", env))
	counts := make(map[string]int, len(dirs))
	for _, dir := range dirs {
		counts[dir]++
	}
	for _, want := range []string{
		shared,
		winGet,
		filepath.Join(localAppData, "Programs", "GitHub CLI"),
		filepath.Join(localAppData, "GitHubCLI", "bin"),
	} {
		if counts[want] != 1 {
			t.Errorf("%q appears %d times, want 1 (dirs: %q)", want, counts[want], dirs)
		}
	}
	// Windows matching is case-insensitive, so the upper-case duplicate is gone.
	if counts[upperShared] != 0 {
		t.Errorf("case-variant duplicate %q survived: %q", upperShared, dirs)
	}
	// shared, winGet, Programs/GitHub CLI, GitHubCLI/bin: USERPROFILE and the
	// ProgramFiles variables are unset and therefore skipped.
	if wantLen := 4; len(dirs) != wantLen {
		t.Errorf("len(dirs) = %d, want %d (dirs: %q)", len(dirs), wantLen, dirs)
	}
}

func TestSearchedPathSkipsEmptyEnvValues(t *testing.T) {
	// No PATH and no well-known env vars at all.
	if got := ghcli.SearchedPathFor("", "windows", fakeEnv(nil)); got != "" {
		t.Errorf("SearchedPathFor with empty env = %q, want empty", got)
	}

	// Empty PATH entries (e.g. "a;;b") are skipped, not turned into ".".
	a := filepath.Join("fake", "a")
	b := filepath.Join("fake", "b")
	dirs := filepath.SplitList(ghcli.SearchedPathFor("", "windows", fakeEnv(map[string]string{
		"PATH": a + string(os.PathListSeparator) + string(os.PathListSeparator) + b,
	})))
	if !reflect.DeepEqual(dirs, []string{a, b}) {
		t.Errorf("dirs = %q, want [%q %q]", dirs, a, b)
	}

	// Unix profile: HOME unset means ~/.local/bin is skipped.
	dirs = filepath.SplitList(ghcli.SearchedPathFor("", "linux", fakeEnv(nil)))
	if !reflect.DeepEqual(dirs, []string{"/usr/local/bin", "/opt/homebrew/bin"}) {
		t.Errorf("linux dirs = %q, want [/usr/local/bin /opt/homebrew/bin]", dirs)
	}
}

func TestLookupForUsesCustomPathext(t *testing.T) {
	dir := t.TempDir()
	want := writeExecutable(t, dir, "gh.EXE")

	// A custom PATHEXT (with a case-varied duplicate and a dead extension) is
	// the probe set; the platform default must not be used.
	env := fakeEnv(map[string]string{"PATHEXT": ".EXE;.exe;.CMD"})
	got, ok := ghcli.LookupFor(dir, "gh", "windows", env)
	if !ok {
		t.Fatal("LookupFor did not resolve gh.EXE via the custom PATHEXT")
	}
	if got != want {
		t.Errorf("LookupFor = %q, want %q", got, want)
	}
}

func TestLookupForRespectsPathextExclusion(t *testing.T) {
	dir := t.TempDir()
	writeExecutable(t, dir, "gh.exe")
	env := fakeEnv(map[string]string{"PATH": dir, "PATHEXT": ".CMD"})

	// gh.exe exists but PATHEXT does not include .EXE: no resolution.
	if got, ok := ghcli.LookupFor(dir, "gh", "windows", env); ok {
		t.Errorf("LookupFor = %q, want not found when PATHEXT excludes .EXE", got)
	}

	// Token must agree with the same goos+env instead of probing past PATHEXT.
	src := ghcli.NewTokenSourceWithEnvironment("", func(context.Context, string, []string, ...string) (string, string, int, error) {
		t.Fatal("runner must not be called when the binary is not resolvable")
		return "", "", 0, nil
	}, "windows", env)
	_, err := src.Token(context.Background(), "gh")
	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want domain.AppError", err)
	}
	if appErr.Code != domain.ErrCodeGHCLINotFound {
		t.Errorf("code = %q, want %q", appErr.Code, domain.ErrCodeGHCLINotFound)
	}
}

func TestLookupForFallsBackToDefaultPathext(t *testing.T) {
	dir := t.TempDir()
	want := writeExecutable(t, dir, "gh.exe")

	for name, env := range map[string]func(string) string{
		"unset": fakeEnv(nil),
		"empty": fakeEnv(map[string]string{"PATHEXT": "   "}),
	} {
		t.Run(name, func(t *testing.T) {
			got, ok := ghcli.LookupFor(dir, "gh", "windows", env)
			if !ok {
				t.Fatal("LookupFor did not resolve gh.exe with the default PATHEXT")
			}
			if got != want {
				t.Errorf("LookupFor = %q, want %q", got, want)
			}
		})
	}
}

func TestResolverParityLookupLookupForToken(t *testing.T) {
	dir := t.TempDir()
	want := writeExecutable(t, dir, "gh")
	t.Setenv("PATH", dir)
	t.Setenv("PATHEXT", "")

	looked, ok := ghcli.Lookup(dir, "gh")
	if !ok {
		t.Fatal("Lookup returned not found")
	}
	lookedFor, ok := ghcli.LookupFor(dir, "gh", runtime.GOOS, os.Getenv)
	if !ok {
		t.Fatal("LookupFor returned not found")
	}

	var tokenPath string
	src := ghcli.NewTokenSourceWithEnvironment("", func(_ context.Context, path string, _ []string, _ ...string) (string, string, int, error) {
		tokenPath = path
		return "parity_token\n", "", 0, nil
	}, runtime.GOOS, os.Getenv)
	if _, err := src.Token(context.Background(), "gh"); err != nil {
		t.Fatalf("Token: %v", err)
	}

	if looked != want {
		t.Errorf("Lookup = %q, want %q", looked, want)
	}
	if lookedFor != want {
		t.Errorf("LookupFor = %q, want %q", lookedFor, want)
	}
	if tokenPath != want {
		t.Errorf("Token resolved %q, want %q", tokenPath, want)
	}
}

func TestLookupHostPathextParity(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("PATHEXT resolution only applies on Windows")
	}
	dir := t.TempDir()
	want := writeExecutable(t, dir, "gh.EXE")
	t.Setenv("PATH", dir)
	t.Setenv("PATHEXT", ".EXE")

	looked, ok := ghcli.Lookup(dir, "gh")
	if !ok {
		t.Fatal("Lookup returned not found with PATHEXT=.EXE")
	}
	lookedFor, ok := ghcli.LookupFor(dir, "gh", runtime.GOOS, os.Getenv)
	if !ok {
		t.Fatal("LookupFor returned not found with PATHEXT=.EXE")
	}
	if looked != want || lookedFor != want {
		t.Errorf("Lookup = %q, LookupFor = %q, want %q", looked, lookedFor, want)
	}
}

func TestLookupResolvesWindowsExtensionInWellKnownDir(t *testing.T) {
	dir := t.TempDir()
	bin := writeExecutable(t, dir, "gh.exe")

	got, ok := ghcli.LookupFor(dir, "gh", "windows", fakeEnv(nil))
	if !ok {
		t.Fatal("LookupFor did not resolve gh.exe on the windows profile")
	}
	if got != bin {
		t.Errorf("LookupFor = %q, want %q", got, bin)
	}

	// The extension probe is Windows-only: on Unix, `gh.exe` is not `gh`.
	if found, ok := ghcli.LookupFor(dir, "gh", "linux", fakeEnv(nil)); ok {
		t.Errorf("LookupFor(linux) = %q, want not found for gh.exe", found)
	}
}

func TestTokenResolvesFromWellKnownDirectory(t *testing.T) {
	localAppData := t.TempDir()
	ghDir := filepath.Join(localAppData, "Programs", "GitHub CLI")
	if err := os.MkdirAll(ghDir, 0o755); err != nil {
		t.Fatalf("mkdir well-known dir: %v", err)
	}
	bin := writeExecutable(t, ghDir, "gh.exe")

	env := fakeEnv(map[string]string{"LOCALAPPDATA": localAppData})

	var gotPath string
	src := ghcli.NewTokenSourceWithEnvironment("", func(_ context.Context, path string, _ []string, args ...string) (string, string, int, error) {
		gotPath = path
		if len(args) != 2 || args[0] != "auth" || args[1] != "token" {
			t.Errorf("args = %v, want [auth token]", args)
		}
		return "well_known_token\n", "", 0, nil
	}, "windows", env)

	token, err := src.Token(context.Background(), "")
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if token != "well_known_token" {
		t.Errorf("token = %q, want well_known_token", token)
	}
	if gotPath != bin {
		t.Errorf("resolved path = %q, want %q", gotPath, bin)
	}
}

// --- actionable error copy ------------------------------------------------

func assertActionableNotFoundMessage(t *testing.T, message string) {
	t.Helper()
	for _, want := range []string{"GitHub CLI (gh) not found", "winget install --id GitHub.cli", "scoop install gh", "gh auth login"} {
		if !strings.Contains(message, want) {
			t.Errorf("message %q does not contain %q", message, want)
		}
	}
}

func assertActionableLaunchFailureMessage(t *testing.T, message string) {
	t.Helper()
	for _, want := range []string{"GitHub CLI (gh) was found but could not be started", "permissions", "antivirus", "retry"} {
		if !strings.Contains(message, want) {
			t.Errorf("message %q does not contain %q", message, want)
		}
	}
	if strings.Contains(strings.ToLower(message), "install") {
		t.Errorf("launch-failure message must not tell the user to install gh: %q", message)
	}
}

func assertActionableUnauthenticatedMessage(t *testing.T, message string) {
	t.Helper()
	for _, want := range []string{"GitHub CLI (gh) is installed but not signed in", "gh auth login"} {
		if !strings.Contains(message, want) {
			t.Errorf("message %q does not contain %q", message, want)
		}
	}
}

func TestNotFoundMessageIsActionableAndKeepsDetails(t *testing.T) {
	env := fakeEnv(nil)
	src := ghcli.NewTokenSourceWithEnvironment("", func(context.Context, string, []string, ...string) (string, string, int, error) {
		t.Fatal("runner must not be called when the binary is missing")
		return "", "", 0, nil
	}, "windows", env)

	_, err := src.Token(context.Background(), "gh")
	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want domain.AppError", err)
	}
	if appErr.Code != domain.ErrCodeGHCLINotFound {
		t.Errorf("code = %q, want %q", appErr.Code, domain.ErrCodeGHCLINotFound)
	}
	assertActionableNotFoundMessage(t, appErr.Message)
	if appErr.Details["binary"] != "gh" {
		t.Errorf("details.binary = %q, want gh", appErr.Details["binary"])
	}
	if _, ok := appErr.Details["searched_path"]; !ok {
		t.Errorf("details.searched_path missing: %v", appErr.Details)
	}
}

func TestLaunchFailureMessageIsDistinctAndNotInstallAdvice(t *testing.T) {
	// Not-found copy.
	notFoundSrc := ghcli.NewTokenSourceWithEnvironment("", func(context.Context, string, []string, ...string) (string, string, int, error) {
		t.Fatal("runner must not be called when the binary is missing")
		return "", "", 0, nil
	}, "windows", fakeEnv(nil))
	_, notFoundErr := notFoundSrc.Token(context.Background(), "gh")
	var notFound domain.AppError
	if !errors.As(notFoundErr, &notFound) {
		t.Fatalf("not-found err = %v, want domain.AppError", notFoundErr)
	}

	// Launch-failure copy: the binary resolves but the process never starts.
	dir := t.TempDir()
	bin := writeExecutable(t, dir, "gh")
	launchSrc := ghcli.NewTokenSourceWithEnvironment(dir, func(context.Context, string, []string, ...string) (string, string, int, error) {
		return "", "SECRET-LAUNCH", -1, errors.New("fork/exec: permission denied")
	}, "windows", fakeEnv(map[string]string{"PATH": ""}))
	_, launchErr := launchSrc.Token(context.Background(), "gh")
	var launch domain.AppError
	if !errors.As(launchErr, &launch) {
		t.Fatalf("launch err = %v, want domain.AppError", launchErr)
	}

	if launch.Code != domain.ErrCodeGHCLINotFound {
		t.Errorf("launch code = %q, want %q", launch.Code, domain.ErrCodeGHCLINotFound)
	}
	if launch.Message == notFound.Message {
		t.Errorf("launch-failure message must differ from the not-found message: %q", launch.Message)
	}
	assertActionableLaunchFailureMessage(t, launch.Message)
	if launch.Details["binary"] != bin {
		t.Errorf("details.binary = %q, want %q", launch.Details["binary"], bin)
	}
	if launch.Details["exit_code"] != "-1" {
		t.Errorf("details.exit_code = %q, want -1", launch.Details["exit_code"])
	}
}

func TestUnauthenticatedMessageIsActionableAndKeepsDetails(t *testing.T) {
	dir := t.TempDir()
	bin := writeExecutable(t, dir, "gh")

	src := ghcli.NewTokenSourceWithEnvironment(dir, func(context.Context, string, []string, ...string) (string, string, int, error) {
		return "", "fatal: not logged in", 1, errors.New("exit status 1")
	}, "windows", fakeEnv(map[string]string{"PATH": ""}))

	_, err := src.Token(context.Background(), "gh")
	var appErr domain.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("err = %v, want domain.AppError", err)
	}
	if appErr.Code != domain.ErrCodeGHCLIUnauthenticated {
		t.Errorf("code = %q, want %q", appErr.Code, domain.ErrCodeGHCLIUnauthenticated)
	}
	assertActionableUnauthenticatedMessage(t, appErr.Message)
	if appErr.Details["binary"] != bin {
		t.Errorf("details.binary = %q, want %q", appErr.Details["binary"], bin)
	}
	if appErr.Details["exit_code"] != "1" {
		t.Errorf("details.exit_code = %q, want 1", appErr.Details["exit_code"])
	}
	if strings.Contains(appErr.Message, "fatal: not logged in") {
		t.Errorf("message leaked stderr: %q", appErr.Message)
	}
}
