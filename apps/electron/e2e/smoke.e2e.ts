import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

/**
 * Electron e2e smoke — the read/selection slice of the week-7 bar item
 * "open repo → graph → stage → commit → diff" (docs/context/git-client/roadmap-mvp.md).
 *
 * WHAT THIS SPEC ACTUALLY COVERS (honest scope)
 *   1. open repo       — type the fixture path into the repo picker and open it.
 *   2. graph           — the routed graph page renders real commits from go-core
 *                        (gRPC round-trip through the Electron IPC bridge).
 *   3. select          — clicking a row shows its details (message) in the
 *                        read-only History aside (ADR-0030); the metadata
 *                        (full oid, author, date) sits in the aside's
 *                        collapsible footer, which the spec expands.
 *   4. WIP row         — the synthetic working-tree row no longer renders a
 *                        History placeholder: it routes to the File status screen
 *                        (ADR-0030), whose `local` variant lists the dirty
 *                        fixture file.
 *   5. status / stage  — on File status, the untracked fixture file is listed and
 *                        stage → unstage round-trips through the real IPC path.
 *   6. commit          — committing the staged file moves HEAD, so the graph
 *                        reloads; History is reached again through the sidebar
 *                        WORKSPACE entry and shows the new commit row
 *                        (IPC → gRPC → git).
 *   7. diff            — re-selecting that commit and using the History toolbar
 *                        "Changes" button opens the File status `commit` variant;
 *                        picking Files in the commit-details panel's header
 *                        switch mounts its changed-file list, which diffs the
 *                        file in the viewer.
 *
 * WHAT IS ABSENT THIS ITERATION
 *   History (route `/repo`) is compare-free by design (ADR-0030): it owns the
 *   graph + commit details aside only, so all status/stage/commit/diff work is
 *   driven on the File status screen (route `/repo/file-status`, ADR-0029). The
 *   `pr` variant and the hunk/line mutations (ADR-0020) are not exercised here
 *   (they are covered by renderer unit specs); this smoke covers the local and
 *   commit variants end-to-end against the real git core.
 *
 * PREREQUISITES (build from the repo root)
 *   ./tools/scripts/build-go-core.sh                 -> dist/go-core (posix) / dist/go-core.exe (win32)
 *   (cd apps/angular && npm run build)               -> apps/angular/dist/browser/index.html
 *   (cd apps/electron && npm run build)              -> apps/electron/dist/main/main.js
 *
 * PREREQUISITE GUARD (skip vs. fail)
 *   Locally, missing artifacts make this spec `test.skip` so a developer without a
 *   full build gets an honest skip. In CI a skip would exit 0 and masquerade as a
 *   green run, so the spec must fail instead. Contract:
 *     E2E_REQUIRE_PREREQS=1   -> missing prerequisites FAIL the run.
 *     CI (any non-empty)      -> same as E2E_REQUIRE_PREREQS=1 (safety net).
 *     unset / any other value -> missing prerequisites SKIP (local default).
 *   Verified by a `test.beforeAll` throw plus non-skipping assertions in each test.
 *
 * LAUNCH NOTE — why a static server + ELECTRON_START_URL instead of app://:
 *   In production main.ts loads the renderer via the privileged `app://` protocol
 *   (`app://bundle/index.html`, see src/main/protocol.ts), whose root is
 *   `process.resourcesPath/renderer` when packaged. This spec does not package the
 *   app, so it serves the *same built bundle* (apps/angular/dist/browser) over a
 *   local HTTP server and points `ELECTRON_START_URL` at it — still the real
 *   renderer bundle, real preload bridge, real go-core. The packaged `app://` path
 *   is exercised separately by the packaging build (electron-builder extraResources
 *   `to: renderer`).
 *
 * PLAywRIGHT/ELECTRON QUIRK — resource shim:
 *   Playwright's Electron loader makes `app.isPackaged === true`, so the shell
 *   resolves go-core/proto under `process.resourcesPath`. `ensureResourceShim()`
 *   copies the repo artifacts (go-core binary + proto SSOT) into the Electron
 *   resources dir (node_modules is gitignored). Copies — not symlinks — because
 *   `fs.symlinkSync` needs Developer Mode / admin on windows-latest; re-copying
 *   is cheap and keeps the step idempotent and non-throwing on both OSes.
 *
 * Run from this package directory (never the repo root):
 *   cd apps/electron && npx playwright test
 */

const testDir = __dirname;
const packageDir = path.resolve(testDir, '..');
const repoRoot = path.resolve(packageDir, '../..');

const isWindows = process.platform === 'win32';
// build-go-core.sh / getGoCoreBinary() emit `go-core.exe` on win32.
const goCoreBin = path.join(repoRoot, 'dist', isWindows ? 'go-core.exe' : 'go-core');
const angularIndex = path.join(repoRoot, 'apps/angular/dist/browser/index.html');
const electronMain = path.join(packageDir, 'dist/main/main.js');
const protoDir = path.join(repoRoot, 'libs/contracts/proto');

/**
 * When true, missing prerequisites FAIL instead of skipping.
 * Contract: E2E_REQUIRE_PREREQS=1 or any non-empty CI env.
 */
const requirePrereqs = process.env['E2E_REQUIRE_PREREQS'] === '1' || !!process.env['CI'];

/** Collect build/runtime prerequisites; any entry makes the smoke skip loudly. */
const missing: string[] = [];
if (!fs.existsSync(goCoreBin)) missing.push(`dist/${path.basename(goCoreBin)} (run ./tools/scripts/build-go-core.sh)`);
if (!fs.existsSync(angularIndex)) missing.push('apps/angular/dist/browser/index.html (run `npm run build` in apps/angular)');
if (!fs.existsSync(electronMain)) missing.push('apps/electron/dist/main/main.js (run `npm run build` in apps/electron)');
if (spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0) missing.push('git on PATH (needed for the fixture repo)');

interface Fixture {
  dir: string;
  head: string;
  first: string;
}

/** Minimal git fixture: 2 commits, a local remote, both tag kinds, a dirty file. */
function createFixtureRepo(): Fixture {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'singularitree-pw-e2e-')));
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
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
  git(['remote', 'add', 'origin', dir]);
  git(['tag', '-a', 'v1.0.0', '-m', 'annotated release', first]);
  git(['tag', 'lightweight', head]);
  // Leave the working tree dirty so the WIP row has a reason to exist.
  fs.writeFileSync(path.join(dir, 'wip.txt'), 'uncommitted\n');
  return { dir, head, first };
}

/** Locate the Electron resources dir where Playwright reports `isPackaged=true`. */
function electronResourcesDir(): string | null {
  const candidates = [
    path.join(repoRoot, 'node_modules/electron/dist/resources'),
    path.join(packageDir, 'node_modules/electron/dist/resources'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Copy the real artifacts into the Electron resources dir so the packaged-
 * resolution paths (`resourcesPath/go-core/go-core[.exe]`, `resourcesPath/proto`)
 * find them under Playwright. Copies work on Windows (unlike `symlinkSync`,
 * which needs Developer Mode/admin); it is idempotent and non-throwing because
 * `copyFileSync`/`cpSync` overwrite in place and create missing dirs.
 */
function ensureResourceShim(): void {
  const res = electronResourcesDir();
  if (!res) return;
  const goCoreDir = path.join(res, 'go-core');
  fs.mkdirSync(goCoreDir, { recursive: true });
  // Mirror main.ts: `go-core` on posix, `go-core.exe` on win32.
  const goCoreTarget = path.join(goCoreDir, path.basename(goCoreBin));
  // Remove any pre-existing file/symlink first: copying through a symlink that
  // points back at the source would truncate it or copy a dir into itself.
  fs.rmSync(goCoreTarget, { recursive: true, force: true });
  fs.copyFileSync(goCoreBin, goCoreTarget);
  const protoTarget = path.join(res, 'proto');
  fs.rmSync(protoTarget, { recursive: true, force: true });
  fs.cpSync(protoDir, protoTarget, { recursive: true });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/** Tiny static server for the built Angular bundle with SPA fallback. */
function createStaticServer(root: string): http.Server {
  return http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = path.join(root, rel);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(root, 'index.html');
    }
    res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
}

let app: ElectronApplication | null = null;
let window: Page | null = null;
let server: http.Server | null = null;
let fixture: Fixture | null = null;

/**
 * Test isolation — each test owns its own entry steps through these helpers
 * (variant: explicit per-test entry, NOT a blanket `beforeEach`). Test 1's
 * subject IS the picker → open flow, so a blanket `beforeEach` reopening the
 * repo would conflict with it. Explicit entry steps make every test
 * self-contained and re-runnable (`--grep` of any single test works from a
 * fresh run) while keeping all existing assertions intact.
 */

/**
 * Ensure a repo session is open. Races the picker against the rendered graph
 * (both with a generous timeout): the picker winning means there is no session,
 * so open the fixture through it and wait for the graph; the graph winning means
 * the repo is already open. The open-path log is load-bearing observability: in a
 * full-suite run it appearing under test 2/3 means the repo session was torn down
 * between tests.
 */
async function ensureRepoOpen(): Promise<void> {
  if (!window || !fixture) throw new Error('e2e setup did not initialise');
  const pathInput = window.getByTestId('repo-path-input');
  const graphFirst = window.getByTestId('graph-row-message').first();
  // Race the two states with a generous timeout so a slow cold boot (lazy route
  // chunks render after `domcontentloaded`) can never be mistaken for "repo
  // already open"; the race resolves as soon as EITHER state appears, so the fast
  // path stays fast. Both sides catch, so a losing/rejecting waiter can never
  // surface as an unhandled rejection.
  const state = await Promise.race([
    pathInput
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'picker' as const)
      .catch(() => 'neither' as const),
    graphFirst
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'graph' as const)
      .catch(() => 'neither' as const),
  ]);
  if (state !== 'picker') {
    console.log('ensureRepoOpen: repo already open');
    return;
  }
  console.log('ensureRepoOpen: opened repo via picker');
  await pathInput.fill(fixture.dir);
  await window.getByTestId('repo-open').click();
  await expect(graphFirst).toBeVisible({ timeout: 60_000 });
}

/** Ensure the History workspace (`/repo`) is open and its graph is rendered. */
async function ensureHistory(): Promise<void> {
  if (!window) throw new Error('e2e setup did not initialise');
  await window.getByTestId('st-sidebar-workspace-history').click();
  await expect(window).toHaveURL(/\/repo$/);
  await expect(window.getByTestId('graph-row-message').first()).toBeVisible({ timeout: 60_000 });
}

test.describe('SingulariTree Electron smoke: open repo → graph → stage → commit → diff', () => {
  test.beforeAll(async () => {
    if (missing.length > 0) {
      // In CI a skip exits 0 and hides a broken build — fail loudly instead.
      if (requirePrereqs) {
        throw new Error(
          `e2e prerequisites missing and E2E_REQUIRE_PREREQS/CI is set: ${missing.join('; ')}`,
        );
      }
      return;
    }

    ensureResourceShim();
    fixture = createFixtureRepo();

    server = createStaticServer(path.join(repoRoot, 'apps/angular/dist/browser'));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server!.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/`;

    // The sandbox / dev-shm workarounds are Linux-only; passing them on Windows
    // is at best noise and at worst an unsupported switch.
    const linuxFlags =
      process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];

    app = await electron.launch({
      // Passing the package directory => `electron apps/electron` so
      // app.getAppPath() === apps/electron (go-core/proto resolve correctly).
      args: [packageDir, ...linuxFlags],
      cwd: packageDir,
      env: { ...process.env, ELECTRON_START_URL: url, MOCK_GO_CORE: '0' },
      timeout: 120_000,
    });
    window = await app.firstWindow({ timeout: 60_000 });
    await window.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    if (app) {
      try {
        await app.close();
      } catch {
        /* already closed */
      }
    }
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (fixture) fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

  test('opens the fixture repo and renders the real commit graph', async () => {
    test.skip(missing.length > 0 && !requirePrereqs, `missing prerequisites: ${missing.join('; ')}`);
    if (!window || !fixture) throw new Error('e2e setup did not initialise');

    // (a) open repo via the in-page picker.
    const pathInput = window.getByTestId('repo-path-input');
    await pathInput.waitFor({ state: 'visible', timeout: 30_000 });
    await pathInput.fill(fixture.dir);
    await window.getByTestId('repo-open').click();

    // (b) graph: rows come from a real go-core getCommits gRPC round-trip.
    const messages = window.getByTestId('graph-row-message');
    await expect(messages.first()).toBeVisible({ timeout: 60_000 });
    const texts = await messages.allInnerTexts();
    expect(texts.length).toBeGreaterThanOrEqual(2);
    expect(texts).toContain('second commit');
    expect(texts).toContain('initial commit');

    // Errors/offline states must not be present on a healthy run.
    await expect(window.getByTestId('graph-error')).toHaveCount(0);
    await expect(window.getByTestId('repo-picker-error')).toHaveCount(0);
  });

  test('selects a commit, then the WIP row routes to the File status screen', async () => {
    test.skip(missing.length > 0 && !requirePrereqs, `missing prerequisites: ${missing.join('; ')}`);
    if (!window || !fixture) throw new Error('e2e setup did not initialise');

    // Entry steps (self-contained): open the repo if needed, then go to History.
    await ensureRepoOpen();
    await ensureHistory();

    // (c) selection → details panel (read-only history + details, ADR-0030).
    await window.getByTestId('graph-row-message').first().click();
    const detailSubject = window.getByTestId('commit-details-subject');
    await expect(detailSubject).toBeVisible();
    await expect(detailSubject).toContainText('second commit');

    // The metadata (oid / author / date / parents / refs) lives in the panel's
    // COLLAPSIBLE footer, which starts collapsed: the metadata markup is not in
    // the DOM until the disclosure is expanded (the commit-details panel is a
    // header / content / footer surface).
    const footerToggle = window.getByTestId('commit-details-footer-toggle');
    await expect(footerToggle).toBeVisible();
    await expect(footerToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(window.getByTestId('commit-details-oid')).toHaveCount(0);

    await footerToggle.click();
    await expect(footerToggle).toHaveAttribute('aria-expanded', 'true');
    // Full OID coverage: the metadata shows the complete 40-hex oid, not the
    // abbreviated one.
    const detailOid = window.getByTestId('commit-details-oid');
    await expect(detailOid).toBeVisible();
    await expect(detailOid).toContainText(fixture.head);

    // Collapsing it again hides the metadata again.
    await footerToggle.click();
    await expect(footerToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(window.getByTestId('commit-details-oid')).toHaveCount(0);

    // (d) pinned synthetic WIP row → routes to the File status screen (ADR-0030).
    // History no longer renders status details, so the dirty fixture file is
    // listed by the `local` variant of `/repo/file-status`.
    await window.getByTestId('graph-wip').click();
    await expect(window).toHaveURL(/\/repo\/file-status/);

    const wipFile = window.getByTestId('status-file').filter({ hasText: 'wip.txt' });
    await expect(wipFile).toHaveCount(1, { timeout: 30_000 });
    await expect(wipFile).toBeVisible();
    await expect(window.getByTestId('status-error')).toHaveCount(0);

    // The local variant pins `isWip` to false, so the panel's WIP branch exists
    // only in History's aside — File status never mounts that placeholder.
    await expect(window.getByTestId('commit-details-wip')).toHaveCount(0);
  });

  test('stage → commit → diff against the real git core', async () => {
    test.skip(missing.length > 0 && !requirePrereqs, `missing prerequisites: ${missing.join('; ')}`);
    if (!window || !fixture) throw new Error('e2e setup did not initialise');

    // Entry steps (self-contained): open the repo if needed, go to History, then
    // navigate to the File status screen through the sidebar WORKSPACE "Commit
    // analyzer" entry. This test performs its own navigation instead of inheriting
    // test 2's WIP hand-off. With no real commit selected (WIP or nothing
    // selected), FileStatusPage's selection-following effect dispatches
    // `openLocal()`, so the screen lands on the `local` variant. Verified: the
    // WORKSPACE `status` entry routes to `/repo/file-status` via
    // `LayoutComponent.onWorkspaceSelected` and defaults to the local variant.
    await ensureRepoOpen();
    await ensureHistory();
    await window.getByTestId('st-sidebar-workspace-status').click();
    await expect(window).toHaveURL(/\/repo\/file-status/);

    // (e) File status `local` variant: the fixture's untracked `wip.txt` must be
    // listed here (IPC → gRPC → git status).
    const wipFile = window.getByTestId('status-file').filter({ hasText: 'wip.txt' });
    await expect(wipFile).toHaveCount(1, { timeout: 30_000 });
    await expect(wipFile).toBeVisible();
    await expect(window.getByTestId('status-error')).toHaveCount(0);

    // (f) stage: the row moves to the staged section, exposing "Unstage".
    await wipFile.getByTestId('status-stage').click();
    await expect(
      window.getByTestId('status-file').filter({ hasText: 'wip.txt' }).getByTestId('status-unstage'),
    ).toBeVisible({ timeout: 30_000 });

    // (g) unstage round-trip: the row returns to unstaged, exposing "Stage" again.
    await window
      .getByTestId('status-file')
      .filter({ hasText: 'wip.txt' })
      .getByTestId('status-unstage')
      .click();
    await expect(
      window.getByTestId('status-file').filter({ hasText: 'wip.txt' }).getByTestId('status-stage'),
    ).toBeVisible({ timeout: 30_000 });

    // (h) stage again, write a message and commit through the full IPC path.
    await window
      .getByTestId('status-file')
      .filter({ hasText: 'wip.txt' })
      .getByTestId('status-stage')
      .click();
    await expect(
      window.getByTestId('status-file').filter({ hasText: 'wip.txt' }).getByTestId('status-unstage'),
    ).toBeVisible({ timeout: 30_000 });

    // `commit-message-input` sits on the `<st-textarea>` host; `fill` must target
    // the inner native control (the host is not fillable). Same app, test-side fix.
    await window.getByTestId('commit-message-input').locator('textarea').fill('wip commit');
    const commitButton = window.getByTestId('commit-button');
    await expect(commitButton).toBeEnabled();
    await commitButton.click();
    await expect(window.getByTestId('commit-error')).toHaveCount(0);

    // (i) a real commit exists: go back to History through the sidebar WORKSPACE
    // entry, where the reloaded graph pins the new `wip commit` node.
    await window.getByTestId('st-sidebar-workspace-history').click();
    await expect(window).toHaveURL(/\/repo$/);

    const newCommitMessage = window.getByTestId('graph-row-message').filter({ hasText: 'wip commit' });
    await expect(newCommitMessage).toHaveCount(1, { timeout: 60_000 });
    await expect(newCommitMessage).toBeVisible();
    await expect(window.getByTestId('graph-error')).toHaveCount(0);

    // (j) select the new commit, then open the File status `commit` variant via the
    // History toolbar "Changes" button (the selection diff is the commit against
    // its first parent). Assert the viewer host, not Monaco internals: Monaco
    // loads lazily and the plain unified fallback stands in until (and if) it does.
    await newCommitMessage.click();
    await window.getByTestId('graph-open-changes').click();
    await expect(window).toHaveURL(/\/repo\/file-status/);

    // The analyzer opens in DESCRIPTION mode (the shared `description | files`
    // mode defaults to description), so its changed-file list is not mounted
    // yet. The switch now lives in the commit-details PANEL HEADER (it used to
    // sit in the diff-pane title), so pick Files there. Clicking the already
    // active segment is a no-op, which keeps this step idempotent.
    const filesSegment = window
      .getByTestId('commit-details-view-switch')
      .getByTestId('toggle-segment-files');
    await expect(filesSegment).toBeVisible();
    await filesSegment.click();

    // In Files mode the changed-file list belongs to the commit-details PANEL,
    // not to the page: its rows are PATHS ONLY (no status badge, no +/- counts —
    // those live on `st-file-diff-list`, which now renders only in the `pr`
    // variant) and, because the analyzer opts into `filesSelectable`, each row
    // emits the picked path so the right pane projects that one file's diff.
    const changedRow = window
      .getByTestId('commit-details-file-path')
      .filter({ hasText: 'wip.txt' });
    await expect(changedRow).toHaveCount(1, { timeout: 30_000 });
    await expect(changedRow).toBeVisible();
    await changedRow.click();

    const diffViewer = window.locator('[data-testid="diff-viewer"]');
    await expect(diffViewer).toBeVisible();
    await expect(diffViewer.getByTestId('diff-empty')).toHaveCount(0);
    await expect(diffViewer.getByTestId('diff-error')).toHaveCount(0);
    // Monaco mounts several `.monaco-editor` nodes (gutter + original + modified);
    // the gutter is zero-size, so assert "fallback visible OR a diff editor present"
    // (count, not visibility of an arbitrary node) rather than a bare visibility check.
    const diffFallback = diffViewer.getByTestId('diff-fallback');
    const monacoDiff = diffViewer.locator('.monaco-diff-editor');
    await expect(async () => {
      const fallbackVisible = await diffFallback.isVisible().catch(() => false);
      const monacoCount = await monacoDiff.count();
      expect(fallbackVisible || monacoCount > 0).toBe(true);
    }).toPass({ timeout: 30_000 });

    // (k) Monaco's stylesheet is delivered lazily (non-injected `monaco.css`, not
    // linked by index.html): the loader must have appended it before the editor
    // mounted, otherwise the diff panes render with `position: static` /
    // `overflow: visible` and bleed into each other. Assert the real editor
    // mounted (not just the fallback) and that the applied CSS is the Monaco one.
    await expect(async () => {
      const count = await monacoDiff.count();
      expect(count).toBeGreaterThan(0);
      expect(await monacoDiff.first().isVisible()).toBe(true);
    }).toPass({ timeout: 30_000 });

    const monacoCssState = await window.evaluate(() => {
      const stylesheet = document.querySelector<HTMLLinkElement>('link[data-st-monaco-css]');
      const editors = Array.from(document.querySelectorAll<HTMLElement>('.monaco-editor'))
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 100)
        .sort((a, b) => b.rect.width - a.rect.width);
      const largest = editors[0];
      const guard = largest?.element.querySelector<HTMLElement>('.overflow-guard') ?? null;
      return {
        href: stylesheet?.href ?? null,
        editorCount: editors.length,
        position: largest ? getComputedStyle(largest.element).position : null,
        guardOverflow: guard ? getComputedStyle(guard).overflow : null,
        height: largest?.rect.height ?? 0,
      };
    });

    expect(monacoCssState.href).not.toBeNull();
    expect(monacoCssState.href).toMatch(/monaco\.css$/);
    expect(monacoCssState.editorCount).toBeGreaterThan(0);
    expect(monacoCssState.position).toBe('relative');
    expect(monacoCssState.guardOverflow).toBe('hidden');
    expect(monacoCssState.height).toBeGreaterThan(100);
  });
});
