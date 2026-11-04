import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Modules that read bindings import this; tests that need a database
      // use node:sqlite with the real migrations instead (src/test/db.ts).
      'cloudflare:workers': fileURLToPath(new URL('./src/test/cloudflare-workers.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
