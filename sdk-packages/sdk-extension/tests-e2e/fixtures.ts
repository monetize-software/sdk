import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { test as base, chromium, type BrowserContext } from '@playwright/test';
import { buildRealisticBootstrap } from './fixtures-bootstrap';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../demo-extension/dist');

interface MockServer {
  url: string;
  /** Hooks для отдельных endpoints — позволяют тестам инжектить кастомные
   *  ответы и счётчики hits. Возвращают unsubscribe. */
  on: (
    pattern: string,
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
  ) => () => void;
  /** Stats для assertions: сколько раз каждый pattern был дёрнут. */
  hitCount: (pattern: string) => number;
  /** Reset счётчиков между тестами без рестарта сервера. */
  reset: () => void;
}

interface ContentPageHelpers {
  /** Адрес простой HTTP-страницы для тестов content-script injection.
   *  Сервер отдаёт минимальный HTML на этом URL. */
  contentPageUrl: string;
}

// Persistent context с загруженным MV3 extension + mock backend HTTP server +
// hook для подмены apiOrigin в demo-extension через chrome.storage.local.
export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  mockServer: MockServer;
  contentPage: ContentPageHelpers;
}>({
  mockServer: async ({}, use) => {
    const handlers = new Map<
      string,
      (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
    >();
    const hits = new Map<string, number>();

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // CORS — extension fetch'ает с любого origin'а.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Custom handler побеждает default'ы. Pattern — substring match по URL.
      for (const [pattern, handler] of handlers) {
        if (url.pathname.includes(pattern)) {
          hits.set(pattern, (hits.get(pattern) ?? 0) + 1);
          await handler(req, res);
          return;
        }
      }

      // Default mock'и для самых частых endpoint'ов. Realistic bootstrap'ом
      // покрываем больше code-path'ов (current_session-блок с Restore-кнопкой,
      // auth_panel и т.д.) — тесты ходят как реальный юзер.
      if (url.pathname.includes('/bootstrap')) {
        hits.set('/bootstrap', (hits.get('/bootstrap') ?? 0) + 1);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildRealisticBootstrap({ withCurrentSession: true })));
        return;
      }
      // Текстовая HTML-страница для content-script injection теста.
      if (url.pathname === '/test-page') {
        hits.set('/test-page', (hits.get('/test-page') ?? 0) + 1);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html><body><h1>Test page</h1></body></html>');
        return;
      }
      // Default 200 для остальных API-вызовов (events, user-state, etc.) —
      // чтобы PaywallUI не падал в error-state на нерелевантных запросах.
      hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;

    await use({
      url,
      on: (pattern, handler) => {
        handlers.set(pattern, handler);
        return () => handlers.delete(pattern);
      },
      hitCount: (pattern) => hits.get(pattern) ?? 0,
      reset: () => {
        handlers.clear();
        hits.clear();
      }
    });

    await new Promise<void>((r) => server.close(() => r()));
  },

  context: async ({ mockServer }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox'
      ]
    });

    // Перед открытием тестовых страниц прокидываем apiOrigin в chrome.storage —
    // demo-extension'овский content/popup инициализируется с нашим URL,
    // bootstrap уйдёт на mock-сервер.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await sw.evaluate(async (apiOrigin: string) => {
      await chrome.storage.local.set({
        __demo_paywall_id: 'demo',
        __demo_api_origin: apiOrigin
      });
    }, mockServer.url);

    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];
    await use(id);
  },

  contentPage: async ({ mockServer }, use) => {
    await use({ contentPageUrl: `${mockServer.url}/test-page` });
  }
});

export { expect } from '@playwright/test';
