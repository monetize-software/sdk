import { defineConfig } from 'vitest/config';

// Vitest unit tests live in tests/. tests-e2e/ is a separate Playwright suite.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests-e2e/**', 'node_modules/**', 'dist/**']
  },
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat'
    }
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact'
  }
});
