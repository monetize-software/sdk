import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import dts from 'vite-plugin-dts';

export default defineConfig(({ command, mode }) => {
  // vite.config.ts runs in Node before .env* is loaded, so variables from there
  // do not end up in process.env. loadEnv reads .env / .env.local / .env.[mode]
  // manually, so VITE_API_TARGET from .env.local actually affects proxy.target below.
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') };

  return {
  plugins: [
    tailwindcss(),
    command === 'build' &&
      dts({
        entryRoot: 'src',
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        rollupTypes: true,
        tsconfigPath: './tsconfig.json'
      })
  ].filter(Boolean),

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
    cssCodeSplit: false,
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        core: resolve(__dirname, 'src/core/index.ts'),
        ui: resolve(__dirname, 'src/ui/index.ts')
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
  },

  server: {
    // 5060 is a SIP unsafe port in Chromium (ERR_UNSAFE_PORT); 5070 is not blocked.
    port: 5070,
    open: '/demo/',
    proxy: {
      // Where demo/main.ts hits in real-backend mode. Defaults to local online
      // (requires `cd online && pnpm dev`). Overridable via VITE_API_TARGET.
      '/api': {
        target: env.VITE_API_TARGET ?? 'https://local.paywall.app:5050',
        changeOrigin: true,
        secure: false
      }
    }
  }
  };
});
