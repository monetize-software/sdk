import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, chromium, type BrowserContext } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../playgrounds/extension/dist');

// Persistent context с загруженным MV3 extension. Headless у Playwright для
// extensions — через `chromium` (не `chromium_headless_shell`). В CI можно
// оставить headless: true, локально имеет смысл запускать с headed для отладки.
export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox'
      ]
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    // Service worker стартует сразу после install — ждём его и парсим id из URL
    // вида `chrome-extension://<id>/background.js`.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];
    await use(id);
  }
});

export { expect } from '@playwright/test';
