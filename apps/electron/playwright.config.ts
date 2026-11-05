import { defineConfig } from '@playwright/test';

/**
 * Playwright end-to-end configuration for the SingulariTree Electron shell.
 *
 * Scope is deliberately separate from the Vitest suite:
 *   - Vitest (`vitest.config.ts`) globs `test/**\/*.test.ts`.
 *   - This config globs `e2e/**\/*.e2e.ts` so a Playwright spec can never be
 *     picked up by the unit/integration runner (and vice-versa).
 *
 * The Electron driver ships inside `@playwright/test` (`playwright-core`), so
 * no Chromium download (`npx playwright install`) is required — Electron
 * provides its own Chromium runtime.
 *
 * Run from this package directory (never the repo root):
 *   cd apps/electron && npx playwright test
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  // One real Electron app + one go-core child at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  // go-core cold start + Angular boot + gRPC round-trips need headroom.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'e2e-results/html', open: 'never' }],
  ],
  // All per-test artifacts are gitignored (see repo .gitignore).
  outputDir: 'e2e-results/artifacts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
});
