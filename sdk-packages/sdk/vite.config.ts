import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import dts from 'vite-plugin-dts';

export default defineConfig(({ command, mode }) => {
  // vite.config.ts исполняется в Node до подгрузки .env*, поэтому переменные оттуда
  // в process.env не попадают. loadEnv читает .env / .env.local / .env.[mode] вручную,
  // чтобы VITE_API_TARGET из .env.local реально влиял на proxy.target ниже.
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
    // 5060 — SIP unsafe port в Chromium (ERR_UNSAFE_PORT), 5070 не блокируется.
    port: 5070,
    open: '/demo/',
    proxy: {
      // Куда бьёт demo/main.ts в real-backend режиме. По умолчанию локальный online
      // (нужен `cd online && pnpm dev`). Переопределяется через VITE_API_TARGET.
      '/api': {
        target: env.VITE_API_TARGET ?? 'https://local.paywall.app:5050',
        changeOrigin: true,
        secure: false
      }
    }
  }
  };
});
