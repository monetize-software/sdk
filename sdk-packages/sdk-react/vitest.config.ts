import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@monetize.software/sdk': resolve(__dirname, '../sdk/src')
    }
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    // Playwright spec'и держим в tests-e2e/ — vitest их не цепляет.
    exclude: ['**/node_modules/**', '**/dist/**', '**/tests-e2e/**', '**/demo/**']
  }
});
