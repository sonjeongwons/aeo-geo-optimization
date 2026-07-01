import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    // Allow longer timeouts for integration tests
    testTimeout: 30_000,
  },
  resolve: {
    conditions: ['import', 'node'],
  },
});
