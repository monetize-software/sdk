import { defineConfig } from 'vitest/config';

// Юнит-тесты Vitest живут в tests/. tests-e2e/ — отдельный Playwright.
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
