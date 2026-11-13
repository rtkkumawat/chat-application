import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Test files share one database when TEST_DATABASE_URL points at a real
    // Postgres, so they must not run concurrently.
    fileParallelism: false,
  },
});
