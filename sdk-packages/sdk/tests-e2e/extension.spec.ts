import { test, expect } from './fixtures';

// Evaluate-хелпер: PaywallUI инстанс прокинут в window.__paywall из popup.entry.ts.
declare global {
  interface Window {
    __paywall: {
      open: () => void;
      close: () => void;
      on: (event: string, handler: (payload: unknown) => void) => () => void;
      checkReturn: () => void;
    };
  }
}

test('popup boots, SDK инстанс доступен на window', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await page.waitForFunction(() => !!window.__paywall);
  const hasAPI = await page.evaluate(
    () => typeof window.__paywall.open === 'function' && typeof window.__paywall.on === 'function'
  );
  expect(hasAPI).toBe(true);
});

test('open() создаёт shadow host в DOM и эмитит ready', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForFunction(() => !!window.__paywall);

  // Регистрируем listener ДО open() — ловим ready в промисе.
  const readyPromise = page.evaluate(
    () =>
      new Promise<unknown>((resolve) => {
        window.__paywall.on('ready', (payload) => resolve(payload));
      })
  );

  await page.evaluate(() => window.__paywall.open());
  // `all: initial` на host превращает div в inline-бокс с нулевым box-model —
  // Playwright-у он кажется hidden. Проверяем наличие в DOM, а не видимость.
  await page.waitForSelector('[data-paywall-host]', { state: 'attached', timeout: 5000 });

  const payload = (await readyPromise) as { settings: { name: string }; prices: unknown[] };
  expect(payload.settings.name).toBe('Upgrade to Pro');
  expect(payload.prices).toHaveLength(2);
});

test('визуальный snapshot модалки', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 780, height: 600 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForFunction(() => !!window.__paywall);

  // Дожидаемся рендер-ready (приходит после bootstrap). Через тот же listener.
  const ready = page.evaluate(
    () => new Promise<void>((resolve) => window.__paywall.on('ready', () => resolve()))
  );
  await page.evaluate(() => window.__paywall.open());
  await ready;
  // Один frame чтобы модалка успела закоммитить стили.
  await page.waitForTimeout(150);

  await expect(page).toHaveScreenshot('paywall-ext-popup.png', { fullPage: false });
});

test('checkReturn ловит URL-маркеры и чистит URL', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForFunction(() => !!window.__paywall);

  // Chrome-extension navigation с query уходит в closed-page — стартуем "чистым"
  // и подменяем URL через replaceState перед ручным вызовом checkReturn().
  const payload = await page.evaluate(() => {
    window.history.replaceState(
      null,
      '',
      '?paywall_status=paid&paywall_price_id=yearly&paywall_session_id=sess_1&keep=me'
    );
    return new Promise<{ priceId: string | null; sessionId: string | null }>((resolve) => {
      window.__paywall.on('purchase_completed', (p) =>
        resolve(p as { priceId: string | null; sessionId: string | null })
      );
      window.__paywall.checkReturn();
    });
  });

  expect(payload).toEqual({ priceId: 'yearly', sessionId: 'sess_1' });

  const search = await page.evaluate(() => window.location.search);
  expect(search).toBe('?keep=me');
});
