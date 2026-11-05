import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Guards the go-core staleness guard itself.
 *
 * Why a guard at all: `dist/go-core` is a prebuilt artifact that no `npm start`
 * script rebuilds, while the Electron shell spawns it preferentially
 * (`main.ts` getGoCoreBinary → `Supervisor.spawn` only falls back to `go run`
 * when the file is ABSENT). A core RPC added after the artifact was built is
 * therefore missing from the running app even though every unit suite is green —
 * the relocate-panel defect (`unknown method RelocateRepository for service
 * singularitree.v1.GitCore`).
 *
 * `tools/scripts/verify-go-core-fresh.js` closes that hole: it compares the
 * deployed binary's mtime against the newest mtime of everything that feeds it
 * and fails loudly (exit 1 + the command that fixes it). It runs from the root
 * `prestart` hook and before the Playwright smoke in
 * `tools/scripts/run-tests-local.sh`, so a stale binary can no longer be used
 * silently.
 *
 * These tests exercise the guard through its CLI against throwaway fixture
 * trees, so they are hermetic (the real `dist/go-core` and the repository's own
 * build state are never asserted on — the repo's staleness is a *fact*, not a
 * test outcome) and deterministic: every fixture timestamp is set explicitly
 * with `fs.utimesSync` instead of relying on wall-clock ordering.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testDir, '..');
const repoRoot = path.resolve(packageDir, '../..');
const guardScript = path.join(repoRoot, 'tools', 'scripts', 'verify-go-core-fresh.js');

// Canonical temp base — same reasoning as the e2e suite (see
// go-core.e2e.test.ts): `os.tmpdir()` is whatever TEMP/TMP point at and Windows
// short/long path forms must never leak into a comparison.
const tmpBase = fs.realpathSync.native(os.tmpdir());
const workRoot = fs.mkdtempSync(path.join(tmpBase, 'singularitree-freshness-'));

/** Fixed reference instant: no wall-clock reads, so ordering is deterministic. */
const T0 = Date.UTC(2026, 0, 2, 12, 0, 0);
const NEWER = 60_000;

/**
 * The binary the guard inspects for the *host*: the script mirrors
 * `build-go-core.sh` (explicit GOOS wins, otherwise the host) and `main.ts`
 * (`process.platform === 'win32'` → `.exe`).
 */
const binaryRelPath =
  process.platform === 'win32' ? 'dist/go-core.exe' : 'dist/go-core';

const envWithoutGoos: NodeJS.ProcessEnv = { ...process.env, GOOS: '' };

interface GuardRun {
  status: number;
  stdout: string;
  stderr: string;
}

function runGuard(root: string): GuardRun {
  const res = spawnSync(process.execPath, [guardScript, '--root', root], {
    encoding: 'utf8',
    env: envWithoutGoos,
  });
  return {
    status: res.status ?? (res.error ? 127 : 1),
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function writeFixtureFile(root: string, rel: string, mtimeMs: number): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `// fixture: ${rel}\n`);
  const at = new Date(mtimeMs);
  fs.utimesSync(abs, at, at);
}

interface FixtureOptions {
  /** mtime applied to every file that feeds the binary. */
  sourceMtimeMs: number;
  /** mtime of the deployed binary; `null` removes it. */
  binaryMtimeMs: number | null;
  /** Extra (mtime, rel-path) pairs for inputs the guard must ignore. */
  extra?: Array<{ mtimeMs: number; rel: string }>;
  /** Shrink the fixture to a bare directory with no Go inputs at all. */
  empty?: boolean;
}

/** A miniature of the repo shape, with every timestamp pinned. */
function makeFixture(options: FixtureOptions): string {
  const root = fs.mkdtempSync(path.join(workRoot, 'case-'));
  if (options.empty) return root;

  const s = options.sourceMtimeMs;
  // apps/go-core — the module the binary is built from
  writeFixtureFile(root, 'apps/go-core/go.mod', s);
  writeFixtureFile(root, 'apps/go-core/go.sum', s);
  writeFixtureFile(root, 'apps/go-core/cmd/go-core/main.go', s);
  writeFixtureFile(root, 'apps/go-core/internal/service/repo_service.go', s);
  // migrations are compiled INTO the binary by `//go:embed migrations/*.sql`
  writeFixtureFile(
    root,
    'apps/go-core/internal/repository/migrations/001_initial.sql',
    s,
  );
  writeFixtureFile(root, 'data/sqlite/migrations/001_initial.sql', s);
  // generated Go contract stubs (the module root sits on `gen` itself, and
  // `apps/go-core/go.mod` resolves it with a `replace`)
  writeFixtureFile(root, 'libs/contracts/gen/go.mod', s);
  writeFixtureFile(root, 'libs/contracts/gen/go.sum', s);
  writeFixtureFile(
    root,
    'libs/contracts/gen/go/singularitree/v1/gitcore.pb.go',
    s,
  );
  // proto — indirect input: rebuilt stubs come from it
  writeFixtureFile(root, 'libs/contracts/proto/gitcore.proto', s);
  // workspace files
  writeFixtureFile(root, 'go.work', s);
  writeFixtureFile(root, 'go.work.sum', s);

  for (const extra of options.extra ?? []) {
    writeFixtureFile(root, extra.rel, extra.mtimeMs);
  }

  if (options.binaryMtimeMs !== null) {
    writeFixtureFile(root, binaryRelPath, options.binaryMtimeMs);
  }
  return root;
}

/** A fixture whose inputs all sit at T0, with the binary NEWER than them. */
function freshFixture(extra?: FixtureOptions['extra']): string {
  return makeFixture({ sourceMtimeMs: T0, binaryMtimeMs: T0 + NEWER, extra });
}

afterAll(() => {
  fs.rmSync(workRoot, { recursive: true, force: true });
});

describe('verify-go-core-fresh.js — go-core staleness guard', () => {
  it('exists as a Node script with no bash/uname dependency', () => {
    // The guard runs from the root `prestart` hook on every `npm start`,
    // including on Windows where npm uses cmd.exe; it must be plain Node.
    expect(fs.existsSync(guardScript)).toBe(true);
    expect(guardScript.endsWith('.js')).toBe(true);
  });

  it('exits 0 when the binary postdates every input that feeds it', () => {
    const run = runGuard(freshFixture());
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('[go-core freshness] OK');
    expect(run.stdout).toContain(binaryRelPath);
  });

  it('exits 1 with the offending file and the build command when a Go source is newer', () => {
    const root = makeFixture({ sourceMtimeMs: T0, binaryMtimeMs: T0 });
    // The real defect shape: a core RPC lands *after* the artifact was built.
    writeFixtureFile(
      root,
      'apps/go-core/internal/service/repo_service.go',
      T0 + NEWER,
    );

    const run = runGuard(root);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('[go-core freshness] STALE');
    expect(run.stderr).toContain('apps/go-core/internal/service/repo_service.go');
    expect(run.stderr).toContain('./tools/scripts/build-go-core.sh');
    // The message must name the failure it prevents, not just "stale".
    expect(run.stderr).toContain('unknown method');
  });

  it('exits 1 when the deployed binary is missing (the shell would fall back to `go run`)', () => {
    const root = makeFixture({
      sourceMtimeMs: T0,
      binaryMtimeMs: null,
    });

    const run = runGuard(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('[go-core freshness] MISSING');
    expect(run.stderr).toContain(binaryRelPath);
    expect(run.stderr).toContain('./tools/scripts/build-go-core.sh');
  });

  it('treats a proto edit as an input (drift through the generated Go stubs)', () => {
    const root = freshFixture();
    // Strictly newer than the binary: a proto edit that never made it into a
    // regeneration + rebuild is the same class of drift as a Go edit.
    writeFixtureFile(root, 'libs/contracts/proto/gitcore.proto', T0 + 2 * NEWER);

    const run = runGuard(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('[go-core freshness] STALE');
    expect(run.stderr).toContain('libs/contracts/proto/gitcore.proto');
  });

  it('treats an embedded SQLite migration as an input (//go:embed)', () => {
    const root = freshFixture();
    writeFixtureFile(
      root,
      'apps/go-core/internal/repository/migrations/004_git_flow.sql',
      T0 + 2 * NEWER,
    );

    const run = runGuard(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('[go-core freshness] STALE');
    expect(run.stderr).toContain(
      'apps/go-core/internal/repository/migrations/004_git_flow.sql',
    );
  });

  it('treats the SQLite migration SSOT as an input (gen-migrations.sh copies it in)', () => {
    const root = freshFixture();
    writeFixtureFile(root, 'data/sqlite/migrations/005_x.sql', T0 + 2 * NEWER);

    const run = runGuard(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('data/sqlite/migrations/005_x.sql');
  });

  it("treats the contracts module's go.mod/go.sum as inputs (they sit on gen/)", () => {
    const root = freshFixture();
    writeFixtureFile(root, 'libs/contracts/gen/go.mod', T0 + 2 * NEWER);

    const run = runGuard(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('libs/contracts/gen/go.mod');
  });

  it('exits 1 instead of passing vacuously when no input can be found', () => {
    // A root with a binary but no Go inputs at all: passing would mean the
    // guard silently stopped looking, so it must fail loudly.
    const root = makeFixture({
      sourceMtimeMs: T0,
      binaryMtimeMs: T0,
      empty: true,
    });
    writeFixtureFile(root, binaryRelPath, T0);

    const run = runGuard(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('cannot find ANY input');
  });

  it('ignores files that do not feed the binary (docs, node_modules, ts stubs)', () => {
    const root = freshFixture([
      { mtimeMs: T0 + 5 * NEWER, rel: 'docs/notes.md' },
      { mtimeMs: T0 + 4 * NEWER, rel: 'apps/go-core/node_modules/dep/index.js' },
      { mtimeMs: T0 + 3 * NEWER, rel: 'libs/contracts/gen/ts/gitcore.ts' },
    ]);

    const run = runGuard(root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('[go-core freshness] OK');
  });

  it('ignores a nested Go module (its own go.mod => not compiled in)', () => {
    const root = freshFixture([
      {
        mtimeMs: T0 + 5 * NEWER,
        rel: 'apps/go-core/testdata/nested/go.mod',
      },
      {
        mtimeMs: T0 + 5 * NEWER,
        rel: 'apps/go-core/testdata/nested/main.go',
      },
    ]);

    const run = runGuard(root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('[go-core freshness] OK');
  });

  it('accepts a binary built inside the same timestamp tick (FS granularity)', () => {
    // 1s/2s-granularity mounts can record a build and the last source write
    // inside one tick; a same-instant build must not be reported as stale.
    const root = makeFixture({ sourceMtimeMs: T0, binaryMtimeMs: T0 });
    const run = runGuard(root);
    expect(run.status).toBe(0);
  });

  it('skips (exit 0) on a missing binary with --allow-missing', () => {
    // run-tests-local.sh passes this flag: there, absence is the e2e suite's
    // honest "no build yet" skip, because the shell then uses `go run`.
    const root = makeFixture({
      sourceMtimeMs: T0,
      binaryMtimeMs: null,
    });

    const run = spawnSync(
      process.execPath,
      [guardScript, '--root', root, '--allow-missing'],
      { encoding: 'utf8', env: envWithoutGoos },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('SKIPPED');
  });

  it('never lets --allow-missing excuse a STALE binary', () => {
    const root = makeFixture({ sourceMtimeMs: T0, binaryMtimeMs: T0 });
    writeFixtureFile(
      root,
      'apps/go-core/internal/service/repo_service.go',
      T0 + NEWER,
    );

    const run = spawnSync(
      process.execPath,
      [guardScript, '--root', root, '--allow-missing'],
      { encoding: 'utf8', env: envWithoutGoos },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('[go-core freshness] STALE');
  });

  it('reports relative paths with forward slashes on every host', () => {
    // The report must not change separator: the electron suite runs on
    // windows-latest too, and these assertions (and the developer reading the
    // message) must hold on both hosts.
    const root = makeFixture({ sourceMtimeMs: T0, binaryMtimeMs: T0 });
    writeFixtureFile(root, 'apps/go-core/cmd/go-core/main.go', T0 + NEWER);

    const run = runGuard(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('apps/go-core/cmd/go-core/main.go');
    expect(run.stderr).not.toContain('\\');
  });

  it('rejects unknown options instead of failing open', () => {
    const res = spawnSync(
      process.execPath,
      [guardScript, '--definitely-not-an-option', '--root', workRoot],
      { encoding: 'utf8', env: envWithoutGoos },
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown option');
  });

  it('prints usage for --help', () => {
    const res = spawnSync(process.execPath, [guardScript, '--help'], {
      encoding: 'utf8',
      env: envWithoutGoos,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('verify-go-core-fresh.js');
  });
});
