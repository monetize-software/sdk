// Стабильный e2e smoke без реальной оплаты на Paddle Sandbox. Зеркало Stripe-
// варианта (см. demo-bootstrap.stripe.spec.ts), только paywall id=4 → Paddle
// тест-эквайринг. Cancel-link DOM на стороне Paddle здесь не проверяем —
// Paddle hosted checkout рендерится по-другому, и контракт cancel_url
// валидируется в demo-checkout.paddle.spec.ts на полном flow.
//
// Препросы:
//   1. dev-online на http://152.42.143.9:3000 доступен (тест-БД, paywall id=4
//      настроен на Paddle в test-mode).
//   2. SDK dev на http://localhost:5070 — поднимается webServer'ом в
//      playwright.config.ts с VITE_API_TARGET=dev-online.
//   3. sdk/.env.local с VITE_PAYWALL_API_KEY.

import { test, expect } from '@playwright/test';

const DEMO = 'http://localhost:5070/demo/?id=4';

test('paywall id=4 (Paddle) bootstraps with test-mode badge and emits Paddle checkout URL', async ({
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

  // Paddle Sandbox URL: pay.paddle.io / paddle.com (Billing 2.0 hosted checkout).
  // Достаточно общего паттерна — конкретный субдомен меняется между средами.
  expect(url).toMatch(/paddle\.(com|io)/);
});
