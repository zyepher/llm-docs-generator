import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__eval__/**/*.check.ts'],
    environment: 'node',
    // The checks build local dates, so the answer must not depend on the grading host's zone. A
    // zone with daylight saving keeps the 23-hour day of 30 March 2025 in the night counts.
    env: { TZ: 'Europe/London' },
  },
});
