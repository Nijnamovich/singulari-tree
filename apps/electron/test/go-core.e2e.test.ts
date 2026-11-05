import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GoCoreClient } from '../src/main/go-core-client';

/**
 * Real end-to-end acceptance for the Phase 0 spine:
 *   git fixture repo → real go-core (gRPC) → GoCoreClient
 *     Ping → OpenRepository → GetCommits (asserts fixture messages & oids)
 *     GetBranches → GetRemotes → GetTags (refs read path) + domain error codes.
 *     RelocateRepository (P4.1 missing-folder recovery: same-id repoint + the
 *       REPO_PATH_MISSING / NOT_A_GIT_REPO / REPO_PATH_IN_USE typed failures).
 *
 * Spawns `go run ./apps/go-core/cmd/go-core --headless ...` from the repo root
 * (or `dist/go-core[.exe]` when already built). Skipped only if no Go toolchain.
 *
 * Stale-binary hazard: `dist/go-core[.exe]` is a build artifact that no `npm
 * start` script rebuilds, while the Electron shell spawns it preferentially
 * (main.ts getGoCoreBinary → Supervisor.spawn only falls back to `go run` when
 * it is ABSENT). A core RPC added after the artifact was built is therefore
 * missing from the running app even though every unit suite is green — the
 * renderer's relocation panel silently stops applying a new path. The
 * RelocateRepository case below is the guard: it fails with "unknown method …
 * for service singularitree.v1.GitCore" whenever the deployed binary predates
 * the contract, so a new core RPC must ship with `./tools/scripts/build-go-core.sh`.
 * The staleness itself is now caught earlier and more cheaply by
 * `tools/scripts/verify-go-core-fresh.js` (root `prestart`); this suite stays
 * the behavioural proof that a *fresh* contract works end to end.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testDir, '..');
const repoRoot = path.resolve(packageDir, '../..');
const protoDir = path.join(repoRoot, 'libs/contracts/proto');
// build-go-core.sh emits `dist/go-core.exe` on Windows, and Win32 has no
// implicit-extension resolution for fs.existsSync — probing the extension-less
// name always misses, so every Windows run would fall back to the slower `go
// run` driver. That driver spawns an *extra* process that `child.kill()` on
// Windows (TerminateProcess is single-PID) leaves alive holding cache.db open,
// which is what made the afterAll fs.rmSync fail with EPERM.
const builtBinary = path.join(
  repoRoot,
  'dist',
  process.platform === 'win32' ? 'go-core.exe' : 'go-core',
);

/**
 * Canonical temp base. `os.tmpdir()` is whatever TEMP/TMP point at, and on the
 * GitHub Windows runner that is the 8.3 short form
 * (`C:\Users\RUNNER~1\AppData\Local\Temp`). Temp roots must be created under
 * the canonical form because the Go core echoes back the *long* form it gets
 * from `git rev-parse --show-toplevel` (`C:\Users\runneradmin\…`), and a
 * short-vs-long comparison fails on Windows only.
 *
 * `fs.realpathSync.native` is the libuv binding — GetFinalPathNameByHandleW on
 * Windows (on-disk long name, 8.3 aliases expanded) and realpath(3) on POSIX.
 * Plain `fs.realpathSync` walks path components in JS and resolves symlinks
 * only, so it keeps `RUNNER~1` as written; that asymmetry is the bug.
 */
const tmpBase = fs.realpathSync.native(os.tmpdir());

/**
 * Canonical form of a filesystem path for comparison: resolves symlinks and,
 * on Windows, expands 8.3 short aliases to the on-disk long name. Both operands
 * must pass through it so `RUNNER~1` and `runneradmin` compare equal.
 */
function canonicalFsPath(fsPath: string): string {
  return fs.realpathSync.native(path.resolve(fsPath));
}

const sdkBin = path.join(os.homedir(), 'sdk/go1.27.0/bin');
const goEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${sdkBin}${path.delimiter}${process.env['PATH'] ?? ''}`,
};
const sdkGo = path.join(sdkBin, 'go');
const goCmd = fs.existsSync(sdkGo) ? sdkGo : 'go';
const goVersionProbe = spawnSync(goCmd, ['version'], { env: goEnv, encoding: 'utf8' });
const goAvailable = goVersionProbe.status === 0;
const goVersion = (goVersionProbe.stdout ?? '').trim() || 'unavailable';

interface Fixture {
  dir: string;
  branch: string;
  first: string;
  head: string;
}

function run(cmd: string, args: string[], cwd: string): string {
  const res = spawnSync(cmd, args, { cwd, env: goEnv, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed (${res.status}): ${res.stderr || res.stdout}`,
    );
  }
  return res.stdout;
}

function createFixtureRepo(): Fixture {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(tmpBase, 'singularitree-e2e-')),
  );
  const git = (args: string[]) => run('git', args, dir);
  git(['init', '-q']);
  git(['config', 'user.email', 'e2e@singularitree.test']);
  git(['config', 'user.name', 'SingulariTree E2E']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial commit']);
  const first = git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(dir, 'second.txt'), 'second\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'second commit']);
  const head = git(['rev-parse', 'HEAD']).trim();
  // Current branch name (works whether git defaults to main or master).
  const branch = git(['symbolic-ref', '--short', 'HEAD']).trim();
  // Offline/local refs so GetRemotes/GetTags exercise the non-empty mapping
  // path: a local-path remote (no network) plus both tag kinds.
  git(['remote', 'add', 'origin', dir]);
  git(['tag', '-a', 'v1.0.0', '-m', 'annotated release', first]);
  git(['tag', 'lightweight', head]);
  return { dir, branch, first, head };
}

function spawnGoCore(dbPath: string): ChildProcessWithoutNullStreams {
  const args = [
    '--headless',
    '--grpc-addr',
    '127.0.0.1:0',
    '--http-fallback-addr',
    '127.0.0.1:0',
    '--db',
    dbPath,
  ];
  if (fs.existsSync(builtBinary)) {
    return spawn(builtBinary, args, {
      cwd: repoRoot,
      env: goEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }) as ChildProcessWithoutNullStreams;
  }
  return spawn(goCmd, ['run', './apps/go-core/cmd/go-core', ...args], {
    cwd: repoRoot,
    env: goEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  }) as ChildProcessWithoutNullStreams;
}

function awaitReady(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ addr: string; http: string; token: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout.off('data', onOut);
      proc.stderr.off('data', onErr);
      proc.off('exit', onExit);
    };
    const onOut = (chunk: Buffer) => {
      stdout += chunk.toString();
      const m = stdout.match(
        /GO_CORE_READY\s+addr=(\S+)\s+http=(\S+)\s+token=(\S+)/,
      );
      if (m) {
        cleanup();
        resolve({ addr: m[1], http: m[2], token: m[3] });
      }
    };
    const onErr = (chunk: Buffer) => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `go-core exited before GO_CORE_READY (code=${code})\n--- stderr ---\n${stderr}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `GO_CORE_READY timeout after ${timeoutMs}ms\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        ),
      );
    }, timeoutMs);

    proc.stdout.on('data', onOut);
    proc.stderr.on('data', onErr);
    proc.on('exit', onExit);
  });
}

function killProc(proc: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    // Windows has no POSIX process groups: Node maps `child.kill()` and
    // `process.kill(-pid)` to TerminateProcess on a single PID, so killing the
    // `go run` driver leaves the go-core binary it spawned running with
    // cache.db still open → the afterAll fs.rmSync hits EPERM. `taskkill /T /F`
    // walks the whole tree and ships as a built-in on every Windows runner.
    const terminate = (force: boolean) => {
      if (proc.pid && process.platform === 'win32') {
        // spawnSync reports a missing binary as `{ status: null }` — it does not
        // throw — and taskkill exits 128 when the /PID target is already gone.
        // Any other outcome means the sweep did not happen, so fall through to
        // the single-PID signal below.
        const res = spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        if (res.error == null && (res.status === 0 || res.status === 128)) return;
      }
      const signal = force ? ('SIGKILL' as const) : ('SIGTERM' as const);
      try {
        if (proc.pid && process.platform !== 'win32') {
          process.kill(-proc.pid, signal);
        } else {
          proc.kill(signal);
        }
      } catch {
        try {
          proc.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    if (proc.exitCode !== null || proc.signalCode !== null) {
      // The direct child is already reaped. `go run` only exits after its own
      // child does, so normally nothing survives it; on Win32 a `taskkill` here
      // is a no-op (dead PID → 128) and would not reach a true orphan, which is
      // why this branch is defensive rather than load-bearing.
      terminate(false);
      resolve();
      return;
    }
    const done = () => resolve();
    proc.once('exit', () => {
      // `taskkill /F` returns once termination has been *requested*, and this
      // exit event only reports the direct (`go run`) child — the go-core
      // grandchild may still be releasing cache.db when we start deleting.
      // A short settle avoids that handle-release race; harmless on POSIX.
      if (process.platform === 'win32') {
        setTimeout(done, 500);
      } else {
        done();
      }
    });
    terminate(false);
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) terminate(true);
      done();
    }, 3000);
  });
}

/**
 * Deletes a temp tree, tolerating Windows' delayed handle release. The killed
 * core has closed its SQLite handles (cache.db / -wal / -shm) by the time
 * `killProc` resolves, but the OS may still be tearing those file objects down
 * and real-time AV scanners race the unlink, surfacing as EPERM/EBUSY. Node's
 * rimraf honours `maxRetries`/`retryDelay` (linear backoff) for exactly those
 * errors, and `force` keeps a missing path a non-event.
 */
function rmTmpDir(target: string): void {
  fs.rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}

describe.skipIf(!goAvailable)(
  `go-core GetCommits e2e [Go: ${goVersion}]`,
  () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(tmpBase, 'singularitree-e2e-run-'),
    );
    let fixture: Fixture;
    let proc: ChildProcessWithoutNullStreams | null = null;
    let client: GoCoreClient | null = null;
    let authClient: GoCoreClient | null = null;

    beforeAll(async () => {
      fixture = createFixtureRepo();
      proc = spawnGoCore(path.join(tmpRoot, 'cache.db'));
      const ready = await awaitReady(proc, 180_000);
      client = new GoCoreClient({ protoDir });
      client.connect(ready.addr, ready.token);
      // Second channel-bound client for the distinct singularitree.v1.Auth
      // service registered on the same go-core process/addr/token.
      authClient = new GoCoreClient({ protoDir, serviceName: 'Auth' });
      authClient.connect(ready.addr, ready.token);
    });

    afterAll(async () => {
      client?.close();
      authClient?.close();
      if (proc) await killProc(proc);
      rmTmpDir(tmpRoot);
      if (fixture) rmTmpDir(fixture.dir);
    });

    it('round-trips Ping → OpenRepository → GetCommits', async () => {
      if (!client) throw new Error('client not initialised');

      const pong = await client.ping();
      expect(pong.ok).toBe(true);

      const repo = await client.openRepository({ fsPath: fixture.dir });
      expect(repo.id).toBeTruthy();
      // Both sides canonicalised: the core echoes the long-form path it gets
      // from `git rev-parse --show-toplevel`, while the fixture is created from
      // TEMP which the GitHub Windows runner publishes as the 8.3 short form
      // (RUNNER~1). Comparing canonical vs canonical is stable on Windows and
      // still an exact match on POSIX (realpath(3) both sides).
      expect(canonicalFsPath(repo.fsPath)).toBe(canonicalFsPath(fixture.dir));

      const result = await client.getCommits({
        repoId: repo.id,
        offset: 0,
        limit: 50,
      });
      const messages = result.commits.map((c) => c.message.trim());
      expect(messages).toContain('initial commit');
      expect(messages).toContain('second commit');

      const oids = result.commits.map((c) => c.oid?.hex);
      expect(oids).toContain(fixture.head);
      expect(oids).toContain(fixture.first);
      expect(result.total).toBeGreaterThanOrEqual(2);
    });

    it('round-trips GetBranches → GetRemotes → GetTags and preserves REPO_NOT_FOUND', async () => {
      if (!client) throw new Error('client not initialised');

      const repo = await client.openRepository({ fsPath: fixture.dir });

      const { branches } = await client.getBranches({ repoId: repo.id });
      const current = branches.find((b) => b.isCurrent);
      expect(current, 'fixture must expose its current branch').toBeDefined();
      expect(current?.name).toBe(fixture.branch);
      expect(current?.tip?.hex).toBe(fixture.head);
      expect(branches.every((b) => b.isRemote === false)).toBe(true);

      const { remotes } = await client.getRemotes({ repoId: repo.id });
      expect(remotes.map((r) => r.name)).toContain('origin');
      const origin = remotes.find((r) => r.name === 'origin');
      expect(origin?.urls).toContain(fixture.dir);

      const { tags } = await client.getTags({ repoId: repo.id });
      const annotated = tags.find((t) => t.name === 'v1.0.0');
      const lightweight = tags.find((t) => t.name === 'lightweight');
      expect(annotated?.annotated).toBe(true);
      expect(annotated?.target?.hex).toBe(fixture.first);
      expect(lightweight?.annotated).toBe(false);
      expect(lightweight?.target?.hex).toBe(fixture.head);

      // Unknown repo id → domain REPO_NOT_FOUND crosses the wire via the
      // x-app-error-code trailer (proves the handler routes through the service).
      await expect(
        client.getBranches({ repoId: '00000000-0000-0000-0000-000000000000' }),
      ).rejects.toMatchObject({ code: 'REPO_NOT_FOUND' });
    });

    it('streams Fetch progress against a local-path remote and resolves at EOF', async () => {
      if (!client) throw new Error('client not initialised');

      const repo = await client.openRepository({ fsPath: fixture.dir });
      const progress: Array<{ percent: number; message: string }> = [];
      await expect(
        client.invokeStream(
          'Fetch',
          { repoId: repo.id, remote: 'origin' },
          (p) => progress.push(p),
        ),
      ).resolves.toBeUndefined();

      // The adapter always emits a synthetic "git fetch started" chunk, so a
      // successful stream must deliver at least one Progress message.
      expect(progress.length).toBeGreaterThan(0);
      for (const p of progress) {
        expect(typeof p.percent).toBe('number');
        expect(typeof p.message).toBe('string');
      }
      expect(progress.some((p) => p.message.includes('git fetch started'))).toBe(true);

      // The generic unary dispatch must also drive the stream to completion.
      await expect(
        client.invoke('Fetch', { repoId: repo.id, remote: 'origin' }),
      ).resolves.toBeUndefined();
    });

    it('preserves the domain error code NOT_A_GIT_REPO across the wire', async () => {
      if (!client) throw new Error('client not initialised');

      const notARepo = fs.mkdtempSync(
        path.join(tmpBase, 'singularitree-nonrepo-'),
      );
      try {
        await expect(
          client.openRepository({ fsPath: notARepo }),
        ).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' });
      } finally {
        rmTmpDir(notARepo);
      }
    });

    it('talks to the real Auth service: status, logout, unauthenticated, gh-missing', async () => {
      if (!authClient) throw new Error('auth client not initialised');

      // Fresh core holds no token.
      const status = (await authClient.invoke('GetAuthStatus', {})) as {
        authenticated: boolean;
      };
      expect(status.authenticated).toBe(false);

      // Logout is idempotent and always resolves on a fresh core.
      await expect(authClient.invoke('Logout', {})).resolves.toBeDefined();

      // No token → domain code preserved through the x-app-error-code trailer.
      await expect(authClient.invoke('ListGitHubRepos', {})).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });

      // A guaranteed-missing gh binary must fail deterministically without
      // touching the developer's gh or the network.
      let caught: unknown;
      try {
        await authClient.invoke('ConnectGitHubFromCLI', {
          ghBinary: 'singularitree-nonexistent-gh-binary',
          verify: true,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({ code: 'GH_CLI_NOT_FOUND' });

      // NEW x-app-error-details trailer round-trips as structured JSON.
      const err = caught as { message: string; details: Record<string, unknown> };
      expect(err.details.binary).toBe('singularitree-nonexistent-gh-binary');
      expect(typeof err.details.searched_path).toBe('string');
      expect((err.details.searched_path as string).length).toBeGreaterThan(0);

      // Structured fields only — never raw stderr in message or details.
      expect(err.message).not.toContain('fatal:');
      expect(err.message).not.toContain('not logged');
      for (const value of Object.values(err.details)) {
        expect(String(value)).not.toContain('fatal:');
        expect(String(value)).not.toContain('not logged');
      }
    });

    it('repoints the same repository id when the folder moves (RelocateRepository) and names its typed failures', async () => {
      if (!client) throw new Error('client not initialised');

      // Dedicated fixture: the shared `fixture` is asserted by the tests above
      // and the folder must not be moved on disk.
      const second = createFixtureRepo();
      const moved = path.join(tmpRoot, 'relocated-repo');
      // An existing folder that is not a Git repository (typed failure target).
      const nonRepo = fs.mkdtempSync(path.join(tmpRoot, 'singularitree-nonrepo-'));
      try {
        const before = await client.openRepository({ fsPath: second.dir });
        expect(before.id).toBeTruthy();

        // Simulate the operator moving/renaming the tracked folder outside the
        // app: the row still records the old path, the folder is gone from it.
        fs.renameSync(second.dir, moved);

        // GoCoreClient has no typed wrapper for RelocateRepository (the TS
        // surface predates it), so dispatch generically and cast the `unknown`
        // response to the same locally-declared shape Auth results use.
        const relocated = (await client.invoke('RelocateRepository', {
          repoId: before.id,
          fsPath: moved,
        })) as {
          id: string;
          fsPath: string;
          commonDir: string;
          name: string;
          createdAt: string;
        };

        // Same id: relocate repoints the row, it never deletes + re-adds (which
        // would mint a new id and cascade the cached rows away).
        expect(relocated.id).toBe(before.id);
        // Both sides canonicalised: the core echoes the long-form path it gets
        // from `git rev-parse --show-toplevel` while the fixture lives under the
        // 8.3 short TEMP form (RUNNER~1) on the GitHub Windows runner — same
        // rationale as the OpenRepository assertion above.
        expect(canonicalFsPath(relocated.fsPath)).toBe(canonicalFsPath(moved));
        // Registration history survives: created_at is the row's original value.
        expect(relocated.createdAt).toBe(before.createdAt);
        // common_dir and name are re-derived from the new path exactly like Open.
        expect(canonicalFsPath(relocated.commonDir)).toBe(
          canonicalFsPath(path.join(moved, '.git')),
        );
        expect(relocated.name).toBe(path.basename(moved));

        // The persisted list reflects the repointed path under the same id.
        const listed = await client.listRepositories({});
        const row = listed.repositories.find((r) => r.id === before.id);
        expect(row, 'relocated repo must stay listed under its original id').toBeDefined();
        expect(canonicalFsPath(row?.fsPath ?? '')).toBe(canonicalFsPath(moved));

        // Reopening the new path resolves to the same registration — a fresh
        // OpenRepository must not mint a second id (the renderer's
        // reopen-after-relocate path).
        const reopened = await client.openRepository({ fsPath: moved });
        expect(reopened.id).toBe(before.id);

        // Typed failures, each with its own target, carried by the
        // x-app-error-code trailer exactly like REPO_NOT_FOUND / NOT_A_GIT_REPO.
        await expect(
          client.invoke('RelocateRepository', {
            repoId: before.id,
            fsPath: path.join(tmpRoot, 'relocated-repo-gone'),
          }),
        ).rejects.toMatchObject({ code: 'REPO_PATH_MISSING' });

        await expect(
          client.invoke('RelocateRepository', {
            repoId: before.id,
            fsPath: nonRepo,
          }),
        ).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' });

        // A target already tracked by a *different* id → REPO_PATH_IN_USE. The
        // shared fixture is only registered here (never moved) to supply that
        // distinct id.
        await client.openRepository({ fsPath: fixture.dir });
        await expect(
          client.invoke('RelocateRepository', {
            repoId: before.id,
            fsPath: fixture.dir,
          }),
        ).rejects.toMatchObject({ code: 'REPO_PATH_IN_USE' });
      } finally {
        rmTmpDir(moved);
        rmTmpDir(second.dir);
        rmTmpDir(nonRepo);
      }
    });
  },
);
