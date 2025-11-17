import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setupTests.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts', 'main.ts'],
    },
  },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, 'tests/mocks/obsidian.ts'),
    },
  },
});
