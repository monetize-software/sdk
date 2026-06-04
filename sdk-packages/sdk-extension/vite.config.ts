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
        // rollupTypes is disabled: api-extractor stumbles over the sibling
        // package ../sdk when trying to find the project root. Per-file .d.ts
        // works fine; we can return to bundling later when publishing.
        tsconfigPath: './tsconfig.json',
        // The tsconfig paths alias `@sdk → ../sdk/src` is baked by vite-plugin-dts
        // into the emitted .d.ts as a relative path like `from '../../../sdk/src/core/...'`.
        // In the monorepo this works, but in the published npm package the sdk/src
        // folder doesn't exist — TS silently resolves the types to any, and
        // consumers see broken PaywallUI/BillingClient signatures. The fix is
        // mirrored in sdk-react/vite.config.ts.
        beforeWriteFile(filePath, content) {
          const rewritten = content.replace(
            /from\s+(['"])(?:\.\.\/){2,}sdk\/src(?:\/[^'"]+)?\1/g,
            "from '@monetize.software/sdk'"
          );
          return { filePath, content: rewritten };
        }
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
