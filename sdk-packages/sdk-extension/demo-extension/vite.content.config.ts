// A separate build for the content-script: the MV3 manifest does NOT support
// "type": "module" in content_scripts, so content.js must be a self-contained
// IIFE (no import statements in the final file). SW/offscreen/popup are built
// separately as ESM (see vite.config.ts).

import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';

const root = __dirname;

export default defineConfig({
  // Tailwind for the modal inside the Shadow DOM (see the vite.config.ts comment).
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
    // emptyOutDir: false — don't wipe the main build's artifacts (sw/offscreen/popup).
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
        // content.js — a single file, no extra chunks.
        inlineDynamicImports: true
      }
    }
  }
});
