#!/usr/bin/env node
'use strict';

/**
 * verify-go-core-fresh.js — staleness guard for the PREBUILT go-core binary.
 *
 * Why it exists
 * -------------
 * The Electron shell spawns the *prebuilt* binary (`apps/electron/src/main/
 * supervisor.ts` -> `Supervisor.spawn`): `dist/go-core` is used whenever it
 * exists, and only when it is absent does the shell fall back to
 * `go run ./apps/go-core/cmd/go-core`. That policy is deliberate (the operator
 * chose a guard, not a policy change), but it has a sharp edge: `npm start`
 * rebuilds the Angular renderer (`ng serve`) and the shell (`tsc`) and NEVER
 * rebuilds `dist/go-core`. A core RPC added after the binary was built is then
 * absent from the running app while every unit suite stays green, and the app
 * fails at runtime with
 *
 *     unknown method RelocateRepository for service singularitree.v1.GitCore
 *
 * i.e. exactly the relocate-panel defect. The fix is a guard, not a policy
 * change: fail LOUDLY (nonzero exit + an actionable message) *before* a stale
 * binary is used, instead of silently serving an outdated RPC set.
 *
 * What it compares
 * ----------------
 * `dist/go-core` mtime vs. the newest mtime of everything that feeds it:
 *
 *   - `apps/go-core` — every `.go` file, plus its `go.mod` / `go.sum`
 *   - `libs/contracts/gen` — every `.go` file (the generated Go contract
 *     stubs) plus its `go.mod` / `go.sum`; the module root sits on the `gen`
 *     directory itself (`apps/go-core/go.mod` resolves
 *     `github.com/SingulariTree/go-core/gen` to it with a `replace`, so the
 *     stubs are linked straight into the binary)
 *   - `libs/contracts/proto` — every `.proto` (indirect: a proto edit whose
 *     stubs were never regenerated is the same class of drift — a contract the
 *     binary does not serve)
 *   - `apps/go-core/internal/repository/migrations` and `data/sqlite/migrations`
 *     — the `.sql` migrations are compiled in with `//go:embed`, and the second
 *     path is their SSOT (`gen-migrations.sh` copies it into the module)
 *   - `go.work`, `go.work.sum`          (they set the module/toolchain set)
 *
 * Usage (from anywhere; the repo root is derived from `__dirname`):
 *
 *   node tools/scripts/verify-go-core-fresh.js            # check + report
 *   node tools/scripts/verify-go-core-fresh.js --root DIR # check another tree
 *   node tools/scripts/verify-go-core-fresh.js --help
 *
 * Exit codes: 0 = fresh, 1 = stale / missing / inputs unreadable.
 * It never writes and never runs the Go toolchain: it is a pure filesystem
 * check, so it is deterministic, cross-platform (no bash/`uname`) and cheap
 * enough to hang off `prestart` on every `npm start`.
 */

const fs = require('node:fs');
const path = require('node:path');

const BUILD_COMMAND = './tools/scripts/build-go-core.sh';
const GEN_COMMAND = './tools/scripts/gen-contracts.sh';

/**
 * A source newer than the binary by more than this grace period makes the
 * binary STALE. The grace only absorbs filesystem timestamp granularity
 * (1s/2s mounts: some Docker bind mounts, network and FAT-family volumes)
 * which can record a build and the last source write inside one tick. It caps
 * the blind window at 1 second — a genuinely stale binary is stale by hours.
 */
const STALE_GRACE_MS = 1000;

/**
 * Inputs that feed the binary, as `{ dir, exts, rootFiles }`: `exts` are
 * collected recursively (skipping dependency trees and nested Go modules),
 * `rootFiles` only at the top of `dir`.
 */
const SOURCE_SPECS = [
  { dir: 'apps/go-core', exts: ['.go'], rootFiles: ['go.mod', 'go.sum'] },
  { dir: 'libs/contracts/gen', exts: ['.go'], rootFiles: ['go.mod', 'go.sum'] },
  { dir: 'libs/contracts/proto', exts: ['.proto'], rootFiles: [] },
  // The SQLite migrations are compiled INTO the binary by `//go:embed
  // migrations/*.sql` (apps/go-core/internal/repository/migrations.go), so a
  // migration-only edit is a stale-binary case exactly like a Go edit.
  {
    dir: 'apps/go-core/internal/repository/migrations',
    exts: ['.sql'],
    rootFiles: [],
  },
  // SSOT for those copies (gen-migrations.sh copies it into the module above):
  // editing it without regenerating is the same class of drift as a proto edit
  // whose stubs were never regenerated.
  { dir: 'data/sqlite/migrations', exts: ['.sql'], rootFiles: [] },
];

/** Workspace-level files that change what `go build` links in. */
const WORKSPACE_FILES = ['go.work', 'go.work.sum'];

/** Never walked into: dependency and output trees. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'tmp']);

/**
 * Target OS, resolved exactly like `tools/scripts/build-go-core.sh`: an
 * explicit `GOOS` wins, otherwise the host. The binary name follows from it
 * (`main.ts` uses `process.platform === 'win32'` for the same decision).
 */
function resolveTargetOs(env = process.env) {
  const goos = (env.GOOS || '').trim();
  return goos || (process.platform === 'win32' ? 'windows' : process.platform);
}

/** Repo-relative path of the binary the deploy uses for this target. */
function resolveBinaryRelPath(targetOs = resolveTargetOs()) {
  return targetOs === 'windows' ? 'dist/go-core.exe' : 'dist/go-core';
}

/**
 * Recursive, best-effort walk: unreadable entries are skipped, never fatal.
 * A subdirectory carrying its own `go.mod` is a separate Go module, which the
 * parent build never compiles in — so it is not an input of this binary and is
 * skipped instead of reported as a false offender.
 */
function walkFiles(dir, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // Own go.mod => separate module => not compiled into this binary.
      if (fs.existsSync(path.join(full, 'go.mod'))) continue;
      walkFiles(full, onFile);
    } else if (entry.isFile()) {
      onFile(full);
    }
  }
}

/**
 * Every repo-relative path that feeds `dist/go-core`, with its mtime in ms.
 * A missing input directory is simply not present in the sources of the repo
 * shape; a *completely* empty result means the guard cannot see its inputs and
 * must fail loudly rather than pass vacuously (see `checkFreshness`).
 */
function collectInputs(root) {
  const inputs = [];
  const add = (absPath) => {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(absPath).mtimeMs;
    } catch {
      return; // vanished or unreadable between listing and stat
    }
    // Forward slashes even on Windows: the report is read by humans on both
    // hosts and asserted by tests on both, so it must not vary by separator.
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    inputs.push({ path: rel, mtimeMs });
  };

  for (const spec of SOURCE_SPECS) {
    const dir = path.join(root, spec.dir);
    if (!fs.existsSync(dir)) continue;
    walkFiles(dir, (file) => {
      if (spec.exts.includes(path.extname(file))) return add(file);
      if (spec.rootFiles.includes(path.basename(file))) return add(file);
    });
  }

  for (const file of WORKSPACE_FILES) {
    const abs = path.join(root, file);
    if (fs.existsSync(abs)) add(abs);
  }

  return inputs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** ISO-8601 to the second — enough to point at the offending file. */
function stamp(mtimeMs) {
  return new Date(mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Compare the deployed binary against its inputs.
 *
 * @returns {{status: 'ok'|'stale'|'missing'|'no-inputs',
 *            binaryRelPath: string, binaryMtimeMs: number|null,
 *            inputs: Array<{path: string, mtimeMs: number}>,
 *            offenders: Array<{path: string, mtimeMs: number}>}}
 */
function checkFreshness(root) {
  const binaryRelPath = resolveBinaryRelPath();
  const binaryPath = path.join(root, binaryRelPath);
  const inputs = collectInputs(root);

  let binaryMtimeMs = null;
  try {
    binaryMtimeMs = fs.statSync(binaryPath).mtimeMs;
  } catch {
    return { status: 'missing', binaryRelPath, binaryMtimeMs, inputs, offenders: [] };
  }

  if (inputs.length === 0) {
    return {
      status: 'no-inputs',
      binaryRelPath,
      binaryMtimeMs,
      inputs,
      offenders: [],
    };
  }

  // Inputs are sorted newest-first, so a single comparison settles it: either
  // the newest input predates the binary (fresh) or the input list has a
  // non-empty prefix of inputs that postdate it.
  const newest = inputs[0];
  if (newest.mtimeMs <= binaryMtimeMs + STALE_GRACE_MS) {
    return { status: 'ok', binaryRelPath, binaryMtimeMs, inputs, offenders: [] };
  }

  const offenders = inputs.filter(
    (input) => input.mtimeMs > binaryMtimeMs + STALE_GRACE_MS,
  );
  return { status: 'stale', binaryRelPath, binaryMtimeMs, inputs, offenders };
}

/** The loud, actionable report. Returned as one block (multi-line) string. */
function formatReport(result) {
  const { status, binaryRelPath, binaryMtimeMs, inputs } = result;

  if (status === 'ok') {
    const newest = inputs[0];
    return (
      `[go-core freshness] OK: ${binaryRelPath} (${stamp(binaryMtimeMs)}) is up to date ` +
      `with ${inputs.length} input(s); newest input ${newest.path} (${stamp(newest.mtimeMs)}).`
    );
  }

  if (status === 'no-inputs') {
    const dirs = [...SOURCE_SPECS.map((s) => s.dir), ...WORKSPACE_FILES].join(', ');
    return (
      `[go-core freshness] ERROR: cannot find ANY input that feeds ${binaryRelPath} — ` +
      `expected ${dirs}.\n` +
      `Run this guard against a SingulariTree checkout (it derives the root from its own ` +
      `location) instead of assuming the binary is fine.`
    );
  }

  if (status === 'missing') {
    return (
      `[go-core freshness] MISSING: ${binaryRelPath} does not exist.\n` +
      `The Electron shell would silently fall back to \`go run ./apps/go-core/cmd/go-core\` ` +
      `(slow, and it needs the Go toolchain on PATH), so a missing binary looks like a bug.\n` +
      `Build it once:  ${BUILD_COMMAND}`
    );
  }

  // stale — the offenders are newest-first, so the first ones are what matter.
  const shown = result.offenders.slice(0, 3);
  const hidden = result.offenders.length - shown.length;
  const lines = shown.map((o) => `  - ${o.path} (${stamp(o.mtimeMs)})`);
  if (hidden > 0) lines.push(`  - ... and ${hidden} more input(s)`);
  return (
    `[go-core freshness] STALE: ${binaryRelPath} was built at ${stamp(binaryMtimeMs)}, but ` +
    `its inputs changed after that:\n` +
    `${lines.join('\n')}\n` +
    `A stale binary serves an outdated RPC set — the classic symptom is a runtime\n` +
    `\`unknown method <RPC> for service singularitree.v1.GitCore\` while every unit suite\n` +
    `stays green (the relocate-panel defect).\n` +
    `Rebuild it:  ${BUILD_COMMAND}\n` +
    `(a proto changed? regenerate the Go stubs first: ${GEN_COMMAND})`
  );
}

const USAGE = `Usage: node tools/scripts/verify-go-core-fresh.js [--root DIR]
Fails loudly (exit 1) when the prebuilt go-core binary that the Electron shell
spawns is older than the Go core sources that feed it.

Options:
  --root DIR        repo root to check (default: derived from this script)
  --allow-missing   exit 0 when the binary is ABSENT (the shell then falls back
                    to 'go run', which is current source — slow, not wrong).
                    Used by run-tests-local.sh so a developer without a build
                    keeps the local e2e suite's honest skip.
  --help, -h        show this help

Notes:
  * The shell resolves the binary from the HOST platform (main.ts
    getGoCoreBinary), while this guard mirrors build-go-core.sh, where an
    explicit GOOS wins. With GOOS=windows exported on Linux it therefore checks
    the cross-compiled dist/go-core.exe, not the one the local shell spawns;
    unset GOOS before 'npm start' if that matters.
  * Reported paths always use forward slashes, so one message reads the same on
    every host (and can be asserted by tests on every host).

Exit codes:
  0  the binary is up to date with its inputs (or absent with --allow-missing)
  1  stale, missing (without --allow-missing), or the inputs were not found
`;

function main(argv = process.argv.slice(2)) {
  let root = path.resolve(__dirname, '..', '..');
  let allowMissing = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    }
    if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) {
        process.stderr.write('[go-core freshness] ERROR: --root needs a directory\n');
        return 1;
      }
      root = path.resolve(value);
      i += 1;
    } else if (arg === '--allow-missing') {
      allowMissing = true;
    } else {
      process.stderr.write(`[go-core freshness] ERROR: unknown option '${arg}' (try --help)\n`);
      return 1;
    }
  }

  const result = checkFreshness(root);
  if (result.status === 'ok') {
    process.stdout.write(`${formatReport(result)}\n`);
    return 0;
  }
  // An absent binary is only a *hint* about the dev loop (the shell then runs
  // `go run`, which is current source); a caller that treats absence as its own
  // distinct case opts in with --allow-missing.
  if (result.status === 'missing' && allowMissing) {
    process.stdout.write(
      `[go-core freshness] SKIPPED: ${result.binaryRelPath} does not exist — nothing to ` +
        `compare, and the shell falls back to \`go run\` (current source, slower).\n`,
    );
    return 0;
  }
  process.stderr.write(`${formatReport(result)}\n`);
  return 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  checkFreshness,
  collectInputs,
  formatReport,
  resolveBinaryRelPath,
  resolveTargetOs,
  SKIP_DIRS,
  SOURCE_SPECS,
  STALE_GRACE_MS,
  WORKSPACE_FILES,
};
