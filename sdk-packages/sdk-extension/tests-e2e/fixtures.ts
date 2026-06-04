import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { test as base, chromium, type BrowserContext } from '@playwright/test';
import { buildRealisticBootstrap } from './fixtures-bootstrap';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../demo-extension/dist');

interface MockServer {
  url: string;
  /** Hooks for individual endpoints — let tests inject custom
   *  responses and hit counters. Return an unsubscribe. */
  on: (
    pattern: string,
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
  ) => () => void;
  /** Stats for assertions: how many times each pattern was hit. */
  hitCount: (pattern: string) => number;
  /** Reset counters between tests without restarting the server. */
  reset: () => void;
}

interface ContentPageHelpers {
  /** Address of a simple HTTP page for content-script injection tests.
   *  The server serves minimal HTML at this URL. */
  contentPageUrl: string;
}

// Persistent context with a loaded MV3 extension + mock backend HTTP server +
// a hook to override apiOrigin in the demo-extension via chrome.storage.local.
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
      // CORS — the extension fetches from any origin.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // A custom handler wins over the defaults. Pattern — substring match on the URL.
      for (const [pattern, handler] of handlers) {
        if (url.pathname.includes(pattern)) {
          hits.set(pattern, (hits.get(pattern) ?? 0) + 1);
          await handler(req, res);
          return;
        }
      }

      // Default mocks for the most common endpoints. With a realistic bootstrap
      // we cover more code-paths (current_session block with the Restore button,
      // auth_panel, etc.) — tests behave like a real user.
      if (url.pathname.includes('/bootstrap')) {
        hits.set('/bootstrap', (hits.get('/bootstrap') ?? 0) + 1);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildRealisticBootstrap({ withCurrentSession: true })));
        return;
      }
      // A plain HTML page for the content-script injection test.
      if (url.pathname === '/test-page') {
        hits.set('/test-page', (hits.get('/test-page') ?? 0) + 1);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html><body><h1>Test page</h1></body></html>');
        return;
      }
      // Default 200 for the remaining API calls (events, user-state, etc.) —
      // so PaywallUI doesn't fall into an error-state on irrelevant requests.
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

    // Before opening test pages we push apiOrigin into chrome.storage —
    // the demo-extension's content/popup initializes with our URL,
    // bootstrap goes to the mock server.
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
