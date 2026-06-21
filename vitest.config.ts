import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Integration/e2e tests spawn git + the CLI; give them headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tests create temp git repos and SQLite stores; isolate file-system state.
    fileParallelism: true,
    reporters: ['default'],
  },
});
