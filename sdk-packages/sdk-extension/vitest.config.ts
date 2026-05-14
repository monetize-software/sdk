import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Те же aliasы, что и в основном vite.config.ts — sdk-extension импортит
      // @sdk/* напрямую из ../sdk/src.
      '@sdk': resolve(__dirname, '../sdk/src'),
      // Preact-compat: JSX в @sdk/ui/* транспилится в preact/jsx-runtime.
      react: 'preact/compat',
      'react-dom': 'preact/compat'
    }
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact'
  },
  test: {
    // tests-e2e/ — Playwright spec'и, vitest их не должен подхватывать.
    exclude: ['**/node_modules/**', '**/dist/**', '**/tests-e2e/**', '**/demo-extension/**']
  }
});
