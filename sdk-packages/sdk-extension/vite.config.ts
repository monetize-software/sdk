import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import dts from 'vite-plugin-dts';

// Three runtime targets bundled from one source tree:
//   content  — content-script side, drop-in PaywallUI with RemoteBillingClient
//   offscreen — offscreen page server, owns real BillingClient/Auth/Tracker state
//   sw       — service worker router, forwards messages and proxies chrome.identity
//
// Each gets its own bundle so hosts pick exactly the runtime they need without
// pulling chrome.* references into surfaces that can't run them (e.g. SW imports
// are kept out of content-script bundle, offscreen imports out of SW bundle).
export default defineConfig(({ command }) => ({
  plugins: [
    command === 'build' &&
      dts({
        entryRoot: 'src',
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        // rollupTypes отключён: api-extractor спотыкается о sibling-package
        // ../sdk при попытке найти project root. Per-file .d.ts работает
        // нормально, при публикации можно вернуться к bundling позже.
        tsconfigPath: './tsconfig.json'
      })
  ].filter(Boolean),

  resolve: {
    alias: {
      // Sibling sdk package — sdk-extension reuses BillingClient/AuthClient/UI
      // verbatim. Goes through ../sdk/src so types stay in sync without a
      // workspace-wide build step.
      '@sdk': resolve(__dirname, '../sdk/src'),
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
    cssCodeSplit: false,
    lib: {
      entry: {
        content: resolve(__dirname, 'src/content/index.ts'),
        offscreen: resolve(__dirname, 'src/offscreen/index.ts'),
        sw: resolve(__dirname, 'src/sw/index.ts')
      },
      formats: ['es', 'cjs'],
      fileName: (format, entryName) =>
        format === 'es' ? `${entryName}.js` : `${entryName}.cjs`
    },
    rollupOptions: {
      external: ['preact', 'preact/compat', 'preact/hooks', 'preact/jsx-runtime'],
      output: {
        chunkFileNames: 'chunks/[name]-[hash].js'
      }
    }
  }
}));
