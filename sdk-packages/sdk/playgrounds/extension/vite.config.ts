import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';

// Сборка MV3 extension playground. Отличается от sdk/vite.config.ts тем, что:
// - preact НЕ external — бандл самодостаточный (CWS запрещает remote code).
// - IIFE-подобный output (ESM без import'ов во внешние пакеты), чтобы подключать
//   через <script src="popup.js"> в popup.html без загрузчика модулей.
// - Tailwind плагин подключён для ?inline импорта styles.css (наследуется из SDK).
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
    // Абсолютный путь — иначе vite, запущенный из sdk/, сложит файлы в sdk/dist/.
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    lib: {
      entry: {
        popup: resolve(__dirname, 'src/popup.entry.ts'),
        background: resolve(__dirname, 'src/background.ts')
      },
      // ES-модули — в popup.html подключаем через `<script type="module">`,
      // background в manifest.json помечен "type": "module".
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`
    },
    rollupOptions: {
      // Всё инлайнится — ничего не external.
      external: [],
      output: {
        chunkFileNames: 'chunks/[name]-[hash].js'
      }
    }
  }
});
