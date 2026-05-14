// Отдельный билд для content-script'а: MV3 manifest НЕ поддерживает
// "type": "module" в content_scripts, поэтому content.js должен быть
// IIFE-самодостаточным (никаких import statement'ов в готовом файле).
// SW/offscreen/popup билдятся отдельно как ESM (см. vite.config.ts).

import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';

const root = __dirname;

export default defineConfig({
  // Tailwind для модалки внутри Shadow DOM (см. vite.config.ts комментарий).
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      '@monetize.software/sdk-extension': resolve(root, '../src/content/index.ts'),
      '@sdk': resolve(root, '../../sdk/src'),
      react: 'preact/compat',
      'react-dom': 'preact/compat'
    }
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact'
  },
  build: {
    target: 'es2020',
    minify: 'esbuild',
    sourcemap: true,
    outDir: resolve(root, 'dist'),
    // emptyOutDir: false — не стираем артефакты основного builda (sw/offscreen/popup).
    emptyOutDir: false,
    lib: {
      entry: resolve(root, 'content.ts'),
      formats: ['iife'],
      name: 'MonetizeContentScript',
      fileName: () => 'content.js'
    },
    rollupOptions: {
      external: [],
      output: {
        // content.js — единственный файл, никаких extra chunks.
        inlineDynamicImports: true
      }
    }
  }
});
