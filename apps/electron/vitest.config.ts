import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The e2e suite compiles/runs the real Go core; allow generous budgets.
    testTimeout: 180_000,
    hookTimeout: 200_000,
  },
});
