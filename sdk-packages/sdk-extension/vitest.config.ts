import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // The same aliases as in the main vite.config.ts — sdk-extension imports
      // @sdk/* directly from ../sdk/src.
      '@sdk': resolve(__dirname, '../sdk/src'),
      // Preact-compat: JSX in @sdk/ui/* is transpiled to preact/jsx-runtime.
      react: 'preact/compat',
      'react-dom': 'preact/compat'
    }
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact'
  },
  test: {
    // tests-e2e/ — Playwright specs, vitest must not pick them up.
    exclude: ['**/node_modules/**', '**/dist/**', '**/tests-e2e/**', '**/demo-extension/**']
  }
});
