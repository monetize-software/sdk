import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, chromium, type BrowserContext } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../playgrounds/extension/dist');

// Persistent context with the MV3 extension loaded. Headless mode in Playwright for
// extensions runs through `chromium` (not `chromium_headless_shell`). In CI you can
// keep headless: true; locally it makes sense to run headed for debugging.
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
    // The service worker starts right after install — we wait for it and parse the id
    // from a URL like `chrome-extension://<id>/background.js`.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];
    await use(id);
  }
});

export { expect } from '@playwright/test';
