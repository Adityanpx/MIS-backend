import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup-env.ts'],
    globalSetup: ['./test/global-setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }, // tests share one database: run sequentially
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['src/**/__tests__/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
