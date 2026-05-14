// Полный сквозной Paddle Sandbox flow на paywall id=4 → редирект с hash-
// маркерами → `purchase_completed`. Хрупче, чем bootstrap-смоук: зависит от
// вёрстки Paddle hosted checkout. Запускаем вручную через
// `pnpm test:e2e:checkout:paddle` перед релизом или когда меняем return-URL
// контракт на стороне Paddle.
//
// Препросы те же, что у demo-bootstrap.paddle.spec.ts (paywall id=4, dev-online).
//
// Селекторы Paddle Sandbox формы могут со временем поплыть — Paddle Billing
// 2.0 рендерит inline-checkout, и атрибуты не такие стабильные, как у Stripe.
// Если тест начнёт падать — записать новый снимок DOM через `--debug` и
// поправить селекторы; не пытаться адаптировать через retries.

import { test, expect } from '@playwright/test';

const DEMO = 'http://localhost:5070/demo/?id=4';

test.setTimeout(120_000);

test('paywall id=4 (Paddle) full sandbox checkout → purchase_completed', async ({
  page,
  context
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

  const paddleTabPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Continue' }).click();
  const paddleTab = await paddleTabPromise;

  const { priceId, url } = await page.evaluate<{ priceId: string; url: string }>(
    () => (window as unknown as { __checkoutStarted: Promise<{ priceId: string; url: string }> })
      .__checkoutStarted
  );
  expect(url).toMatch(/paddle\.(com|io)/);

  await paddleTab.waitForLoadState('domcontentloaded');

  // Paddle Sandbox принимает 4242. Поля по placeholder/label, без testid.
  // Email обычно предзаполнен из start-checkout payload, но если форма его
  // спрашивает — досылаем.
  const emailInput = paddleTab.getByLabel(/email/i);
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill(email);
  }

  await paddleTab.getByLabel(/card number/i).fill('4242 4242 4242 4242');
  await paddleTab.getByLabel(/expir|mm.*yy/i).fill('12/34');
  await paddleTab.getByLabel(/cvc|security/i).fill('100');
  const nameInput = paddleTab.getByLabel(/name on card|cardholder/i);
  if (await nameInput.isVisible().catch(() => false)) {
    await nameInput.fill('Test User');
  }

  // Кнопка submit на Paddle hosted checkout — обычно «Pay …» / «Subscribe …».
  await paddleTab.getByRole('button', { name: /pay|subscribe/i }).click();

  await paddleTab.waitForURL(/localhost:5070\/demo\/.*paywall_status=paid/, { timeout: 60_000 });

  const log = paddleTab.locator('#log');
  await expect(log).toContainText(
    `purchase_completed {"priceId":"${priceId}","sessionId":null}`,
    { timeout: 10_000 }
  );

  await expect.poll(async () => paddleTab.evaluate(() => location.hash)).toBe('');
});
