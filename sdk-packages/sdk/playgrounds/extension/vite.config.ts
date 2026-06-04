import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';

// Build for the MV3 extension playground. Differs from sdk/vite.config.ts in that:
// - preact is NOT external — the bundle is self-contained (CWS forbids remote code).
// - IIFE-like output (ESM with no imports of external packages), so it can be loaded
//   via <script src="popup.js"> in popup.html without a module loader.
// - The Tailwind plugin is enabled for the ?inline import of styles.css (inherited from the SDK).
export default defineConfig({
  plugins: [
    tailwindcss(),
    {
      name: 'copy-extension-static',
      closeBundle() {
        const root = __dirname;
        const out = resolve(root, 'dist');
        mkdirSync(out, { recursive: true });
        copyFileSync(resolve(root, 'manifest.json'), resolve(out, 'manifest.json'));
        copyFileSync(resolve(root, 'popup.html'), resolve(out, 'popup.html'));
      }
    }
  ],
  resolve: {
    alias: {
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
    // Absolute path — otherwise vite, launched from sdk/, would put files in sdk/dist/.
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    lib: {
      entry: {
        popup: resolve(__dirname, 'src/popup.entry.ts'),
        background: resolve(__dirname, 'src/background.ts')
      },
      // ES modules — in popup.html we load via `<script type="module">`,
      // background is marked "type": "module" in manifest.json.
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`
    },
    rollupOptions: {
      // Everything is inlined — nothing is external.
      external: [],
      output: {
        chunkFileNames: 'chunks/[name]-[hash].js'
      }
    }
  }
});
