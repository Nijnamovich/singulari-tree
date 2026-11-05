#!/usr/bin/env node
'use strict';

/**
 * Provisions the Electron binary for this repository (Windows and Linux).
 *
 * This provisioner is independent of Electron's bundled `install.js`: it runs
 * after it on `npm ci` and it is the only extraction path when Electron's own
 * install script is skipped. It also repairs trees left behind by older
 * Electron releases whose `install.js` (extract-zip -> yauzl on Node >= 26)
 * could exit 0 after a partial extraction, leaving `dist/` incomplete.
 *
 * Strategy:
 *   1. Compare the provisioned binary against the version this project pins in
 *      `apps/electron/package.json`, never against the version the installed
 *      `node_modules/electron` package declares about itself: those two can
 *      disagree on a stale tree, which would otherwise look installed.
 *   2. Resolve the checksum-verified archive through `@electron/get` (cached;
 *      no network when it is already present).
 *   3. Extract it with system `unzip`/`bsdtar`/`tar`.
 *   4. Repair the executable mode, move the type definitions up and write
 *      `path.txt`.
 *
 * It is idempotent: when the expected build is already provisioned it exits
 * immediately with code 0. It never invokes `npm install` and never commits.
 * `@electron/get` is ESM-only, so it is loaded with a dynamic `import()`.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON_DIR = path.join(REPO_ROOT, 'node_modules', 'electron');
const ELECTRON_PACKAGE_DIR = path.join(REPO_ROOT, 'apps', 'electron');
const ELECTRON_MANIFEST = path.join(ELECTRON_PACKAGE_DIR, 'package.json');

function fail(message) {
  console.error(`[provision-electron] ${message}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`[provision-electron] WARNING: ${message}`);
}

/**
 * Reads the Electron version this project actually requires from the app
 * manifest (the source of truth), stripping a leading `^` / `~` so a caret or
 * tilde range still yields the exact version to provision.
 */
function readExpectedVersion() {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(ELECTRON_MANIFEST, 'utf-8'));
  } catch (error) {
    fail(`Cannot read ${ELECTRON_MANIFEST}: ${error.message}`);
  }

  const spec = manifest && manifest.devDependencies && manifest.devDependencies.electron;
  if (typeof spec !== 'string' || spec.length === 0) {
    fail(`${ELECTRON_MANIFEST} does not declare devDependencies.electron.`);
  }

  const expected = spec.trim().replace(/^[\^~]/, '');
  if (!/^\d+\.\d+\.\d+([-+].*)?$/.test(expected)) {
    fail(
      `devDependencies.electron must resolve to an exact version; got "${spec}". ` +
        `Pin it (for example "42.11.9") so the binary can be provisioned.`
    );
  }

  return expected;
}

/** Reads `node_modules/electron/package.json` (the installed, possibly stale package). */
function readInstalledVersion() {
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf-8'));
    return typeof installed.version === 'string' ? installed.version : 'unknown';
  } catch (error) {
    fail(`Cannot read ${path.join(ELECTRON_DIR, 'package.json')}: ${error.message}`);
  }
}

/**
 * Checksums shipped inside `node_modules/electron` describe the release that
 * package was built for. They must only be used when the installed package is
 * the expected release; otherwise `@electron/get` falls back to the published
 * `SHASUMS256.txt`, which still validates the download.
 */
function readChecksums() {
  const file = path.join(ELECTRON_DIR, 'checksums.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    warn(`cannot read ${file} (${error.message}); validating against SHASUMS256.txt instead.`);
    return undefined;
  }
}

function getPlatformPath(platform) {
  switch (platform) {
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    case 'darwin':
    case 'mas':
      throw new Error(
        `macOS is no longer a supported platform for the desktop shell (ADR-0038), so the ` +
          `Electron binary cannot be provisioned on '${platform}'. A macOS host that only ` +
          `needs the JavaScript toolchain can set ELECTRON_SKIP_BINARY_DOWNLOAD=1 to skip ` +
          `binary provisioning; the root postinstall honours that variable.`
      );
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}

/**
 * Extracts the archive into `distDir` using whichever extractor is available
 * on the host. Electron's own install script is not used here (older releases
 * ship an extractor that misbehaves on newer Node versions), so we prefer OS
 * tooling and fall back across platforms:
 *   - `unzip`  : Linux CI/images (and Git Bash on Windows)
 *   - `bsdtar` : bundled with Windows 10+ (`tar -xf` handles zip)
 *   - `tar`    : last-resort alias for bsdtar/libarchive
 * A missing extractor is a hard failure (never a silent success).
 */
function extractArchive(zipPath, distDir) {
  const attempts = [
    { cmd: 'unzip', args: ['-oq', zipPath, '-d', distDir] },
    { cmd: 'bsdtar', args: ['-xf', zipPath, '-C', distDir] },
    // Windows' bsdtar is exposed as `tar`; GNU tar cannot read zip, hence last.
    { cmd: 'tar', args: ['-xf', zipPath, '-C', distDir] },
  ];

  const errors = [];
  for (const { cmd, args } of attempts) {
    try {
      execFileSync(cmd, args, { stdio: 'inherit' });
      return;
    } catch (error) {
      // ENOENT means the tool is absent; any other error means it ran and
      // failed (e.g. GNU tar rejecting a zip). Try the next extractor.
      errors.push(`${cmd}: ${error.code === 'ENOENT' ? 'not found' : error.message}`);
    }
  }

  fail(
    `Failed to extract ${zipPath}. Install one of 'unzip' or 'bsdtar' ` +
      `(libarchive) on PATH. Attempts: ${errors.join(' | ')}`
  );
}

/**
 * Mirrors Electron's install.js `isInstalled()`: a cheap, side-effect free
 * check used to keep this provisioner idempotent and fast on re-runs. The
 * version compared is the EXPECTED one, so a stale `dist/` is never accepted
 * just because it matches the stale package's self-declared version.
 */
function isInstalled({ expectedVersion, platformPath, electronBinary, versionFile, pathFile }) {
  try {
    if (fs.readFileSync(versionFile, 'utf-8').trim().replace(/^v/, '') !== expectedVersion) {
      return false;
    }
    if (fs.readFileSync(pathFile, 'utf-8') !== platformPath) {
      return false;
    }
  } catch {
    return false;
  }

  return fs.existsSync(electronBinary);
}

/**
 * Loads `@electron/get` with a dynamic `import()`: it is ESM-only, and this
 * script is CommonJS. Resolving through Electron's own install location keeps
 * working if npm nests the dependency instead of hoisting it.
 */
async function loadDownloadArtifact() {
  try {
    const getEntry = require.resolve('@electron/get', { paths: [ELECTRON_DIR] });
    const electronGet = await import(pathToFileURL(getEntry).href);
    const downloadArtifact = electronGet.downloadArtifact;
    if (typeof downloadArtifact !== 'function') {
      throw new Error('the module does not export downloadArtifact()');
    }
    return downloadArtifact;
  } catch (error) {
    fail(`Cannot load @electron/get: ${error.message}`);
  }
}

async function main() {
  // Mirror Electron's install.js: honor the explicit opt-out.
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    console.log('[provision-electron] ELECTRON_SKIP_BINARY_DOWNLOAD set; skipping provisioning.');
    return;
  }

  if (!fs.existsSync(path.join(ELECTRON_DIR, 'package.json'))) {
    fail(`Electron package not found at ${ELECTRON_DIR}. Run npm install first.`);
  }

  const expectedVersion = readExpectedVersion();
  const installedVersion = readInstalledVersion();
  const packageIsStale = installedVersion !== expectedVersion;

  const platform = process.env.npm_config_platform || process.platform;
  const arch = process.env.npm_config_arch || process.arch;
  const platformPath = getPlatformPath(platform);

  const distDir = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(ELECTRON_DIR, 'dist');
  const electronBinary = path.join(distDir, platformPath);
  const versionFile = path.join(distDir, 'version');
  const pathFile = path.join(ELECTRON_DIR, 'path.txt');

  // Warn BEFORE the idempotence check: once a stale tree has been repaired, the
  // early return would otherwise swallow this warning on every later run and a
  // stale package would be silently accepted.
  if (packageIsStale) {
    warn(
      `node_modules/electron is Electron ${installedVersion}, but this project requires ` +
        `Electron ${expectedVersion}. Run 'npm ci' to replace the stale package (the ` +
        `provisioned binary is repaired independently).`
    );
  }

  if (isInstalled({ expectedVersion, platformPath, electronBinary, versionFile, pathFile })) {
    console.log(
      `[provision-electron] Electron ${expectedVersion} already provisioned; nothing to do.`
    );
    return;
  }

  const downloadArtifact = await loadDownloadArtifact();
  // Stale packages carry checksums for THEIR release: using them would fail a
  // checksum mismatch, so let @electron/get validate against the published
  // SHASUMS256.txt instead.
  const checksums = packageIsStale ? undefined : readChecksums();

  let zipPath;
  try {
    // Resolves the cached, checksum-verified archive. No network when cached.
    zipPath = await downloadArtifact({
      version: expectedVersion,
      artifactName: 'electron',
      cacheRoot: process.env.electron_config_cache,
      checksums,
      platform,
      arch,
    });
  } catch (error) {
    fail(`Failed to resolve the Electron ${expectedVersion} archive: ${error.message}`);
  }

  console.log(`[provision-electron] Using cached archive: ${zipPath}`);

  try {
    fs.mkdirSync(distDir, { recursive: true });
  } catch (error) {
    fail(`Cannot create ${distDir}: ${error.message}`);
  }

  extractArchive(zipPath, distDir);

  // The bug this script exists to work around is a SILENT PARTIAL extraction,
  // so never trust a zero exit code: assert the artifact is actually complete
  // before declaring success or writing path.txt.
  try {
    const extracted = fs.readFileSync(versionFile, 'utf-8').trim().replace(/^v/, '');
    if (extracted !== expectedVersion) {
      fail(
        `Extraction incomplete: ${versionFile} reports "${extracted}", ` +
          `expected "${expectedVersion}".`
      );
    }
  } catch (error) {
    fail(`Extraction incomplete: ${versionFile} is missing or unreadable (${error.message}).`);
  }
  if (!fs.existsSync(electronBinary)) {
    fail(`Extraction incomplete: ${electronBinary} was not produced.`);
  }

  // If the archive ships type definitions, move them up (mirror install.js).
  const srcTypeDefPath = path.join(distDir, 'electron.d.ts');
  if (fs.existsSync(srcTypeDefPath)) {
    fs.renameSync(srcTypeDefPath, path.join(ELECTRON_DIR, 'electron.d.ts'));
  }

  try {
    // Only the main executable is made runnable; other modes are left as-is.
    fs.chmodSync(electronBinary, 0o755);
  } catch (error) {
    fail(`Cannot mark ${electronBinary} executable: ${error.message}`);
  }

  try {
    // Exactly `electron`, with no trailing newline.
    fs.writeFileSync(pathFile, platformPath);
  } catch (error) {
    fail(`Cannot write ${pathFile}: ${error.message}`);
  }

  console.log(
    `[provision-electron] Electron ${expectedVersion} provisioned at ${electronBinary}.`
  );

  if (packageIsStale) {
    // The provisioning itself succeeded, so this is not a failed install. The
    // package directory, however, still describes the old release.
    warn(
      `the node_modules/electron package still declares Electron ${installedVersion} while ` +
        `the provisioned binary is ${expectedVersion}. Run 'npm ci' to replace the package.`
    );
  }
}

main().catch((error) => {
  fail(error && error.stack ? error.stack : String(error));
});
