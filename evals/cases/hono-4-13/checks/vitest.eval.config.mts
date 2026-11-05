import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__eval__/**/*.check.ts'],
    environment: 'node',
  },
});
