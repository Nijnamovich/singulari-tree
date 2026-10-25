import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHANNELS, DEEP_LINK_READY_CHANNEL } from '../src/ipc/channels';

/**
 * The preload runs in a `sandbox: true` renderer (`src/window/window.ts`), whose
 * `require` shim cannot resolve relative modules. A relative import there
 * compiles and type-checks fine but throws at load time
 * (`module not found: ../ipc/channels`), silently destroying `contextBridge` so
 * the whole `window.gitClientApi` surface — and every IPC call, including
 * `auth:connectGitHubFromCLI` (the `gh-connect` button) — disappears with no
 * build error. These guards keep the preload free of project imports and keep
 * its inlined channel literals in sync with `src/ipc/channels.ts` (the SSOT).
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const preloadSrc = fs.readFileSync(path.join(testDir, '../src/preload/preload.ts'), 'utf8');

describe('preload sandbox constraints', () => {
  it('does not import or require project modules (sandboxed require cannot resolve them)', () => {
    // Any relative specifier (`./…` or `../…`) in an import or require dies at
    // preload load time under sandbox:true.
    expect(preloadSrc).not.toMatch(/(?:from\s+|require\()\s*['"]\.\.?\//);
  });

  it('inlines the deep-link readiness channel in sync with channels.ts', () => {
    // The literal must match `DEEP_LINK_READY_CHANNEL`; the preload cannot import it.
    expect(preloadSrc).toContain(`'${DEEP_LINK_READY_CHANNEL}'`);
  });

  it('inlines the ADR-0042 git channels in sync with channels.ts', () => {
    // Same sandbox constraint: these literals cannot be imported either.
    for (const channel of [
      CHANNELS.cherryPick,
      CHANNELS.revert,
      CHANNELS.resolveRevision,
    ]) {
      expect(preloadSrc).toContain(`'${channel}'`);
    }
  });
});
