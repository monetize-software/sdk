// Стабильный e2e smoke без реальной оплаты на Freemius Sandbox. Зеркало
// Paddle-варианта (см. demo-bootstrap.paddle.spec.ts), только paywall id=5 →
// Freemius тест-эквайринг (sandbox=true).
//
// Cancel-link DOM на стороне Freemius не проверяем — checkout.freemius.com
// рендерит iframe с динамической вёрсткой, и контракт cancel_url валидируется
// в demo-checkout.freemius.spec.ts на полном flow (если будет писаться).
//
// NB: у Freemius hosted checkout НЕТ query-параметра для success-redirect — после
// оплаты SDK узнаёт о покупке через polling user-state (UserWatcher), а не через
// hash-маркеры. См. online/utils/freemius/server.ts.
//
// Препросы:
//   1. dev-online на http://152.42.143.9:3000 доступен (тест-БД, paywall id=5
//      настроен на Freemius в test-mode).
//   2. SDK dev на http://localhost:5070 — поднимается webServer'ом в
//      playwright.config.ts с VITE_API_TARGET=dev-online.
//   3. sdk/.env.local с VITE_PAYWALL_API_KEY.

import { test, expect } from '@playwright/test';

const DEMO = 'http://localhost:5070/demo/?id=5';

test('paywall id=5 (Freemius) bootstraps with test-mode badge and emits Freemius sandbox URL', async ({
  page
}) => {
  await page.goto(DEMO);

  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await page.evaluate((e) => {
    // @ts-expect-error — __paywall экспонируется в demo/main.ts
    window.__paywall.billing.setIdentity({ email: e, userId: e });
  }, email);

  await page.evaluate(() => {
    (window as unknown as { __checkoutStarted?: Promise<unknown> }).__checkoutStarted =
      new Promise((resolve) => {
        // @ts-expect-error — __paywall с типизированными событиями
        window.__paywall.on('checkout_started', resolve);
      });
  });

  await page.getByRole('button', { name: 'Open paywall' }).click();

  await expect(page.getByRole('status')).toContainText('Test mode — no real charge');
  await expect(page.locator('#log')).toContainText('"is_test_mode":true');

  await page.getByRole('button', { name: 'Continue' }).click();

  const { url } = await page.evaluate<{ url: string }>(
    () => (window as unknown as { __checkoutStarted: Promise<{ url: string }> }).__checkoutStarted
  );

  // Freemius hosted checkout: https://checkout.freemius.com/product/<id>/plan/<id>/?...&sandbox=true
  expect(url).toMatch(/^https:\/\/checkout\.freemius\.com\/product\/\d+\/plan\/\d+\//);
  // Test-mode → query содержит sandbox=true (см. utils/freemius/server.ts).
  expect(url).toContain('sandbox=true');
});
