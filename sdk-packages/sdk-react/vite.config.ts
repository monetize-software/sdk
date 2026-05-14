import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';

// React bindings for @monetize.software/sdk. Single ESM/CJS bundle that ships
// Provider + hooks + components. SDK is left external — consumers install
// @monetize.software/sdk (or @monetize.software/sdk-extension) themselves and
// either pass options to PaywallProvider or supply a ready PaywallUI instance.
//
// Note: react/preact lives in two separate trees. SDK internals render Preact
// inside Shadow DOM, our bindings render real React in the host app — they
// never share a component tree, so no preact/compat aliasing here. We want the
// real React runtime end-to-end on the host side.
export default defineConfig(({ command, mode }) => ({
  plugins: [
    react(),
    command === 'build' &&
      dts({
        entryRoot: 'src',
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        // rollupTypes off for the same reason as sdk-extension: api-extractor
        // chokes on sibling-package ../sdk when looking for project root.
        tsconfigPath: './tsconfig.json'
      })
  ].filter(Boolean),

  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // Runtime resolution → sibling sdk source, so live edits in ../sdk/src
      // flow through dev/test without a separate build step.
      //
      // Type resolution lives in tsconfig.json:paths and points at ../sdk
      // (the built dist via sdk/package.json `exports.types`), not at
      // ../sdk/src. The split is intentional: SDK source is preact-JSX
      // (`class=`, `preact/jsx-runtime`), our package is real React JSX
      // (`className=`, `react/jsx-runtime`). Feeding SDK .tsx through our
      // tsconfig would surface preact-typed JSX as type errors. The built
      // .d.ts has no JSX left, so TS just reads declarations cleanly.
      // After changing types in ../sdk/src, run `pnpm --filter sdk build`
      // to refresh dist for sdk-react typecheck.
      '@monetize.software/sdk': resolve(__dirname, '../sdk/src')
    }
  },

  build: {
    target: 'es2020',
    minify: 'esbuild',
    sourcemap: true,
    cssCodeSplit: false,
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts')
      },
      formats: ['es', 'cjs'],
      fileName: (format, entryName) =>
        format === 'es' ? `${entryName}.js` : `${entryName}.cjs`
    },
    rollupOptions: {
      external: [
        'react',
        'react/jsx-runtime',
        'react-dom',
        '@monetize.software/sdk'
      ],
      output: {
        chunkFileNames: 'chunks/[name]-[hash].js'
      }
    }
  },

  server: {
    // 5080 — keep clear of sdk (5070). Demo entry served from /demo/.
    port: 5080,
    open: '/demo/'
  }
}));
