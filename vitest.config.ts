import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Scope collection to this checkout so nested worktrees (for example under
    // .claude/) never contribute their own copies of the suite.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Many CLI tests spawn a real `node`/`tsx` subprocess per case; under
    // parallel load each spawn is slow, so the default 5s is too tight. Set a
    // generous global default (heavier cases also set their own timeout).
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', 'tests/', '**/*.test.ts', '**/*.spec.ts', '**/types.ts'],
    },
  },
});
