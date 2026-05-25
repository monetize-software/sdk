import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';

// Сборка MV3 demo-extension. Все entry point'ы (sw, offscreen, content)
// собираются в самодостаточные бандлы — ничего из ../node_modules не
// external'ится. Manifest и offscreen.html копируются в dist/ as-is.
//
// Output structure:
//   dist/
//     manifest.json
//     sw.js
//     content.js
//     offscreen.html
//     offscreen.js
//     popup.html (если нужен)
//     popup.js
//
// Загрузка в Chrome: `chrome://extensions` → "Load unpacked" → demo-extension/dist.

const root = __dirname;

export default defineConfig({
  plugins: [
    // Tailwind: PaywallUI'евый styles.css в @sdk/ui ссылается на `@import
    // 'tailwindcss';`. Без плагина CSS-импорт из ?inline вернёт
    // un-compiled @import-директиву, и Shadow DOM модалки уйдёт без стилей.
    tailwindcss(),
    {
      name: 'copy-extension-static',
      closeBundle() {
        const out = resolve(root, 'dist');
        mkdirSync(out, { recursive: true });
        copyFileSync(resolve(root, 'manifest.json'), resolve(out, 'manifest.json'));
        // offscreen.html — статический документ, ссылается на ./offscreen.js
        // (который собирается из offscreen-bootstrap.ts).
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
      // sdk-extension imports — реальный source (не из npm; удобно для
      // локальной отладки, иначе пришлось бы pnpm pack'ать).
      '@monetize.software/sdk-extension/sw': resolve(root, '../src/sw/index.ts'),
      '@monetize.software/sdk-extension/offscreen': resolve(root, '../src/offscreen/index.ts'),
      '@monetize.software/sdk-extension': resolve(root, '../src/content/index.ts'),
      // Sibling sdk — те же aliasы, что и в основном vite.config.ts.
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
    // false — иначе rebuild этого конфига стирает content.js, который пишет
    // vite.content.config.ts. Очистку dist/ делает rimraf в build:demo/dev:demo
    // до старта обоих vite-процессов.
    emptyOutDir: false,
    lib: {
      // content.ts билдится отдельно (vite.content.config.ts) как IIFE —
      // MV3 content_scripts не поддерживают ES-модули.
      entry: {
        sw: resolve(root, 'sw.ts'),
        offscreen: resolve(root, 'offscreen-bootstrap.ts'),
        popup: resolve(root, 'popup.ts')
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`
    },
    rollupOptions: {
      // Всё инлайнится — preact тоже бандлим в content.js (CWS требование:
      // никакого remote code, всё в одном пакете).
      external: [],
      output: {
        chunkFileNames: 'chunks/[name]-[hash].js'
      }
    }
  }
});
