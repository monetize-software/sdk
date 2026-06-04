import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';

// Build of the MV3 demo-extension. All entry points (sw, offscreen, content)
// are built into self-contained bundles — nothing from ../node_modules is
// externalized. The manifest and offscreen.html are copied into dist/ as-is.
//
// Output structure:
//   dist/
//     manifest.json
//     sw.js
//     content.js
//     offscreen.html
//     offscreen.js
//     popup.html (if needed)
//     popup.js
//
// Loading in Chrome: `chrome://extensions` → "Load unpacked" → demo-extension/dist.

const root = __dirname;

export default defineConfig({
  plugins: [
    // Tailwind: PaywallUI's styles.css in @sdk/ui references `@import
    // 'tailwindcss';`. Without the plugin a CSS import from ?inline would return
    // the un-compiled @import directive, and the Shadow DOM modal would ship without styles.
    tailwindcss(),
    {
      name: 'copy-extension-static',
      closeBundle() {
        const out = resolve(root, 'dist');
        mkdirSync(out, { recursive: true });
        copyFileSync(resolve(root, 'manifest.json'), resolve(out, 'manifest.json'));
        // offscreen.html — a static document, references ./offscreen.js
        // (which is built from offscreen-bootstrap.ts).
        copyFileSync(
          resolve(root, '../src/offscreen/offscreen.html'),
          resolve(out, 'offscreen.html')
        );
        copyFileSync(resolve(root, 'popup.html'), resolve(out, 'popup.html'));
      }
    }
  ],
  resolve: {
    alias: {
      // sdk-extension imports — the real source (not from npm; handy for
      // local debugging, otherwise we'd have to pnpm pack).
      '@monetize.software/sdk-extension/sw': resolve(root, '../src/sw/index.ts'),
      '@monetize.software/sdk-extension/offscreen': resolve(root, '../src/offscreen/index.ts'),
      '@monetize.software/sdk-extension': resolve(root, '../src/content/index.ts'),
      // Sibling sdk — the same aliases as in the main vite.config.ts.
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
    // false — otherwise a rebuild of this config wipes content.js, which is
    // written by vite.content.config.ts. The dist/ cleanup is done by rimraf in
    // build:demo/dev:demo before both vite processes start.
    emptyOutDir: false,
    lib: {
      // content.ts is built separately (vite.content.config.ts) as IIFE —
      // MV3 content_scripts don't support ES modules.
      entry: {
        sw: resolve(root, 'sw.ts'),
        offscreen: resolve(root, 'offscreen-bootstrap.ts'),
        popup: resolve(root, 'popup.ts')
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`
    },
    rollupOptions: {
      // Everything is inlined — preact is bundled into content.js too (a CWS
      // requirement: no remote code, everything in one package).
      external: [],
      output: {
        chunkFileNames: 'chunks/[name]-[hash].js'
      }
    }
  }
});
