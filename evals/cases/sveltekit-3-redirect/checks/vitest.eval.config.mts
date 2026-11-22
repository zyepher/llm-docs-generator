import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SvelteKit's own Vite plugin provides $lib in the app; the hidden checks run without it.
  resolve: { alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) } },
  test: {
    include: ['__eval__/**/*.check.ts'],
    environment: 'node',
  },
});
