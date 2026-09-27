import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Vitest 5 no longer excludes `dist/**` by default; `tsc` build emits compiled
    // copies of these test files, so exclude them to avoid duplicate runs.
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
