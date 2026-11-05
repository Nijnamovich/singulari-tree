import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static guard: every testid literal used by the Electron e2e specs must exist
 * in the renderer sources. A renderer testid rename (e.g. `commit-details-message`
 * → `commit-details-subject`) that updates the renderer spec but forgets the e2e
 * would otherwise surface as a 30s Playwright timeout; this catches the drift at
 * unit-test speed instead. It runs inside the existing `apps/electron` vitest
 * suite (`test/**\/*.test.ts`), never under Playwright (`e2e/**\/*.e2e.ts`).
 *
 * INPUT (test-side names):
 *   apps/electron/e2e/**\/*.ts — `getByTestId('X')` / `getByTestId("X")` and
 *   `[data-testid="X"]` locator strings. Non-literal usages are skipped.
 *
 * GROUND TRUTH (renderer, non-spec):
 *   apps/angular/src/** + libs/ui-kit/src/**
 *     - literal template attributes: `data-testid="X"`
 *     - component host metadata:    `'data-testid': 'X'`
 *     - dynamic composition prefixes: string fragments inside
 *       `[attr.data-testid]="..."`, e.g. `'st-sidebar-workspace-' + item.kind`
 *       yields the accepted prefix `st-sidebar-workspace-` (covering
 *       `st-sidebar-workspace-history|status|repos`).
 *   A test-side name passes when it equals a literal or starts with a prefix.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testDir, '..');
const repoRoot = path.resolve(packageDir, '../..');

const E2E_DIR = path.join(packageDir, 'e2e');
const RENDERER_ROOTS = [
  path.join(repoRoot, 'apps/angular/src'),
  path.join(repoRoot, 'libs/ui-kit/src'),
];

/** Recursively collect file paths under `dir` whose basename matches `keep`. */
function walk(dir: string, keep: (name: string) => boolean): string[] {
  const found: string[] = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, keep));
    else if (keep(entry.name)) found.push(full);
  }
  return found;
}

/** 1-based line number of a character offset, for actionable failure reports. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

interface Usage {
  readonly name: string;
  readonly file: string;
  readonly line: number;
}

// Test-side name extraction. Group 1 is the quote, group 2 the literal name.
const E2E_GET_BY_TEST_ID = /getByTestId\(\s*(['"])([^'"]+)\1\s*\)/g;
const E2E_DATA_TESTID_ATTR = /\[data-testid=(['"])([^'"]+)\1\]/g;

/** Collect every literal testid the e2e specs reference, with its location. */
function collectE2eTestids(): Usage[] {
  const usages: Usage[] = [];
  for (const file of walk(E2E_DIR, (name) => name.endsWith('.ts'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of [E2E_GET_BY_TEST_ID, E2E_DATA_TESTID_ATTR]) {
      for (const match of text.matchAll(pattern)) {
        usages.push({ name: match[2]!, file, line: lineOf(text, match.index ?? 0) });
      }
    }
  }
  return usages;
}

interface RendererIndex {
  readonly literals: Set<string>;
  readonly prefixes: string[];
}

/** Build the set of renderer testids (literal names) and dynamic prefixes. */
function buildRendererIndex(): RendererIndex {
  const literals = new Set<string>();
  const prefixes = new Set<string>();
  // `.spec.ts` files document expected testids, not the live ones — never ground truth.
  const keep = (name: string) =>
    (name.endsWith('.ts') || name.endsWith('.html')) && !name.endsWith('.spec.ts');

  for (const root of RENDERER_ROOTS) {
    for (const file of walk(root, keep)) {
      const text = fs.readFileSync(file, 'utf8');
      // (a) literal template attributes. Does not match `[attr.data-testid]="..."`
      // because a `]` sits between the name and the `=`.
      for (const match of text.matchAll(/data-testid=(['"])([^'"]+)\1/g)) {
        literals.add(match[2]!);
      }
      // (b) component host metadata: `host: { 'data-testid': 'X' }`.
      for (const match of text.matchAll(/'data-testid'\s*:\s*(['"])([^'"]+)\1/g)) {
        literals.add(match[2]!);
      }
      // (c) dynamic prefixes: only string-literal fragments that end in `-` are
      // true composition prefixes (`'st-sidebar-workspace-' + kind`). Bare
      // fallback literals (`testId() || 'textarea'`) are not prefixes and must
      // not over-accept any name that merely starts with them.
      for (const match of text.matchAll(/\[attr\.data-testid\]\s*=\s*(['"])([\s\S]*?)\1/g)) {
        for (const fragment of match[2]!.matchAll(/['"]([^'"]+-)['"]/g)) {
          prefixes.add(fragment[1]!);
        }
      }
    }
  }
  return { literals, prefixes: [...prefixes] };
}

function isCovered(name: string, index: RendererIndex): boolean {
  return index.literals.has(name) || index.prefixes.some((prefix) => name.startsWith(prefix));
}

describe('e2e testid drift guard', () => {
  it('every testid used by apps/electron/e2e exists in the renderer sources', () => {
    const usages = collectE2eTestids();
    // Sanity: the scanner must actually find usages, else the guard is vacuous.
    expect(usages.length).toBeGreaterThan(0);

    const index = buildRendererIndex();
    const drifted = usages.filter((usage) => !isCovered(usage.name, index));
    const report = drifted
      .map((usage) => `  ${usage.name} — ${path.relative(repoRoot, usage.file)}:${usage.line}`)
      .join('\n');

    expect(
      drifted.length === 0
        ? null
        : `e2e testid(s) with no renderer counterpart (renamed or removed):\n${report}`,
    ).toBeNull();
  });
});
