/// <reference types="node" />

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the Monaco dev-server failure.
 *
 * `@angular/build:dev-server` hard-codes Vite's `server.fs.allow` to the Angular
 * workspace's `node_modules`, the Vite cache directory and the build asset roots.
 * npm workspaces hoist `monaco-editor` to the repo-root `node_modules`, so Vite's
 * dependency optimizer emits absolute imports such as
 * `/…/node_modules/monaco-editor/esm/…/codicon.css`, which fall outside that allow
 * list and are rejected with HTTP 403:
 * "The request id … is outside of Vite serving allow list."
 *
 * Keeping Monaco out of the prebundle (`prebundle.exclude`) makes esbuild bundle it
 * into the application code, exactly like the production build does. The invariant
 * can also hold when `monaco-editor` is physically installed inside the Angular
 * workspace's own `node_modules`. Do not delete this spec without re-verifying both.
 */
interface PrebundleOptions {
  readonly exclude?: readonly string[];
}

interface ServeOptions {
  readonly prebundle?: boolean | PrebundleOptions;
}

/** Non-string global-style entry (`inject: false` style bundles). */
interface StyleEntry {
  readonly input: string;
  readonly bundleName?: string;
  readonly inject?: boolean;
}

interface BuildOptions {
  readonly styles?: readonly (string | StyleEntry)[];
}

interface ArchitectTarget {
  readonly builder?: string;
  readonly options?: ServeOptions & BuildOptions;
}

interface AngularWorkspaceConfig {
  readonly projects?: Record<
    string,
    { readonly architect?: Record<string, ArchitectTarget | undefined> } | undefined
  >;
}

/**
 * Locate the Angular workspace config by walking up from the runner's cwd: the
 * unit-test builder gives the spec module a runner-dependent URL (an absolute source
 * path without coverage, a workspace-relative artifact path with it), so
 * `import.meta.url` is not a stable anchor. `process.cwd()` is. Both candidate shapes
 * are tried at each level so the lookup works whether the runner starts in
 * `apps/angular` or in the repo root.
 */
function findWorkspaceConfigPath(): string {
  let dir = process.cwd();
  for (;;) {
    const candidates = [resolve(dir, 'angular.json'), resolve(dir, 'apps/angular/angular.json')];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`angular.json not found above ${process.cwd()}`);
    dir = parent;
  }
}

/** Read and parse the workspace config at `configPath`. */
function readWorkspaceConfig(configPath: string): AngularWorkspaceConfig {
  return JSON.parse(readFileSync(configPath, 'utf8')) as AngularWorkspaceConfig;
}

/**
 * True only when `monaco-editor` really lives inside the Angular workspace's own
 * `node_modules`. `existsSync` follows symlinks, so resolve the real path: a link
 * pointing at the hoisted repo-root copy is still served from outside the Vite
 * `server.fs.allow` list and must not satisfy the invariant.
 */
function isInstalledInWorkspace(workspaceRoot: string): boolean {
  const packagePath = join(workspaceRoot, 'node_modules', 'monaco-editor');
  if (!existsSync(packagePath)) return false;

  try {
    const modulesRoot = realpathSync(join(workspaceRoot, 'node_modules'));
    const realPackagePath = realpathSync(packagePath);
    const relativePath = relative(modulesRoot, realPackagePath);
    return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
  } catch {
    // A dangling link or a race with an install makes the branch false, never fatal.
    return false;
  }
}

describe('dev-server configuration', () => {
  it("keeps monaco-editor's CSS inside Vite's serving allow list", () => {
    const configPath = findWorkspaceConfigPath();
    const config = readWorkspaceConfig(configPath);
    const workspaceRoot = dirname(configPath);

    const serve = config.projects?.['singularitree-angular']?.architect?.['serve'];
    const prebundle = serve?.options?.prebundle;

    // `prebundle: false` disables Vite's dependency optimizer entirely, so esbuild
    // bundles Monaco (including its CSS) instead of serving it from disk.
    const prebundleDisabled = prebundle === false;
    const excludedFromPrebundle =
      typeof prebundle === 'object' &&
      prebundle !== null &&
      prebundle.exclude?.includes('monaco-editor') === true;
    const installedInWorkspace = isInstalledInWorkspace(workspaceRoot);

    expect(
      prebundleDisabled || excludedFromPrebundle || installedInWorkspace,
      'Monaco CSS would be served from outside the Vite serving allow list. ' +
        '@angular/build:dev-server hard-codes `server.fs.allow` to <angular-workspace>/node_modules, ' +
        'but npm workspaces hoist monaco-editor to the repo-root node_modules, so Vite emits imports like ' +
        '"/…/node_modules/monaco-editor/esm/…/codicon.css" and answers HTTP 403 ' +
        '("outside of Vite serving allow list"). Fix: add `prebundle.exclude: ["monaco-editor"]` to the ' +
        'serve target in apps/angular/angular.json (or install monaco-editor inside apps/angular).',
    ).toBe(true);
  });
});

/**
 * Regression guard for the Monaco diff panes rendering unstyled.
 *
 * `@angular/build` 22 ignores esbuild's `cssBundle` association and only collects
 * CSS whose output has an `entryPoint`, so Monaco's `import '*.css'` side bundles
 * are emitted as orphan `chunk-*.css` files that `index.html` never links. The
 * editor then computes `position: static` / `overflow: visible` and its panes
 * bleed into each other.
 *
 * The fix is a second global-style entry with `inject: false` and a stable
 * `bundleName: "monaco"`: the builder emits `monaco.css` outside the initial
 * bundler context (excluded from `index.html` and the initial budget), and the
 * diff viewer's lazy loader links it before `createDiffEditor`. The entry must
 * stay non-injected; promoting it to an initial style would breach the 600 kB
 * warning budget.
 */
describe('Monaco CSS asset configuration', () => {
  it('emits Monaco CSS as a single non-injected, stable-named global style', () => {
    const configPath = findWorkspaceConfigPath();
    const config = readWorkspaceConfig(configPath);

    const styles: readonly (string | StyleEntry)[] =
      config.projects?.['singularitree-angular']?.architect?.['build']?.options?.styles ?? [];
    const monacoEntries = styles.filter(
      (style): style is StyleEntry => typeof style === 'object' && style.bundleName === 'monaco',
    );

    expect(monacoEntries).toHaveLength(1);
    const [monaco] = monacoEntries;
    expect(monaco.inject).toBe(false);
    expect(monaco.input.endsWith('monaco-editor/min/vs/editor/editor.main.css')).toBe(true);

    // Only the app stylesheet may be injected into index.html: the Monaco sheet is
    // a lazy, stable-named asset and must never become part of the initial bundle.
    const injected = styles.filter((style) => typeof style === 'string' || style.inject !== false);
    expect(injected).toEqual(['src/styles.scss']);
  });
});
