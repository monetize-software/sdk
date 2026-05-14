// Полный сквозной Stripe test-mode flow: оплата картой 4242 → редирект
// с hash-маркерами → `purchase_completed`. Хрупче, чем demo-bootstrap:
// зависит от вёрстки Stripe Checkout и доступности Sandbox. Держим вне
// основного test:e2e, запускаем вручную через `pnpm test:e2e:checkout:stripe`
// перед релизом или когда меняем return-URL контракт.
//
// Препросы те же, что у demo-bootstrap.stripe.spec.ts (paywall id=3, dev-online).

import { test, expect } from '@playwright/test';

const DEMO = 'http://localhost:5070/demo/?id=3';

// Stripe Checkout иногда грузится дольше 30s, плюс форма + редирект.
test.setTimeout(120_000);

test('paywall id=3 (Stripe) full test-mode checkout → purchase_completed', async ({
  page,
  context
}) => {
  await page.goto(DEMO);

  // Уникальный email — иначе 409 «active purchase» от предыдущих прогонов.
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await page.evaluate((e) => {
    // @ts-expect-error — __paywall экспонируется в demo/main.ts
    window.__paywall.billing.setIdentity({ email: e, userId: e });
  }, email);

  // Подписываемся на checkout_started ДО клика, чтобы взять priceId без хардкода
  // (он же дальше прилетит в #paywall_price_id success-маркера).
  await page.evaluate(() => {
    (window as unknown as { __checkoutStarted?: Promise<unknown> }).__checkoutStarted =
      new Promise((resolve) => {
        // @ts-expect-error — __paywall с типизированными событиями
        window.__paywall.on('checkout_started', resolve);
      });
  });

  await page.getByRole('button', { name: 'Open paywall' }).click();

  // CTA из дефолтного layout. SDK на клик зовёт createCheckout(selectedPriceId)
  // и открывает Stripe URL в новом табе.
  const stripeTabPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Continue' }).click();
  const stripeTab = await stripeTabPromise;

  const { priceId, url } = await page.evaluate<{ priceId: string; url: string }>(
    () => (window as unknown as { __checkoutStarted: Promise<{ priceId: string; url: string }> })
      .__checkoutStarted
  );
  expect(url).toContain('cs_test_');

  // Если Stripe показал accordion выбора метода — раскрываем карточный.
  const cardAccordion = stripeTab.getByTestId('card-accordion-item');
  if (await cardAccordion.isVisible().catch(() => false)) {
    await cardAccordion.click();
  }

  await stripeTab.getByRole('textbox', { name: 'Card number' }).fill('4242 4242 4242 4242');
  await stripeTab.getByRole('textbox', { name: 'Expiration' }).fill('12 / 34');
  await stripeTab.getByRole('textbox', { name: 'CVC' }).fill('123');
  await stripeTab.getByRole('textbox', { name: 'Cardholder name' }).fill('Test User');

  await stripeTab.getByTestId('hosted-payment-submit-button').click();

  // Stripe редиректит на success_url. Ждём, что в той же вкладке откроется demo
  // c hash-маркером paid.
  await stripeTab.waitForURL(/localhost:5070\/demo\/.*paywall_status=paid/, { timeout: 60_000 });

  // SDK на onload инстанцирует PaywallUI, а конструктор через microtask вызывает
  // checkReturn → emit purchase_completed → demo пишет в #log.
  const log = stripeTab.locator('#log');
  await expect(log).toContainText(
    `purchase_completed {"priceId":"${priceId}","sessionId":null}`,
    { timeout: 10_000 }
  );

  // И маркеры подтёрты history.replaceState.
  await expect.poll(async () => stripeTab.evaluate(() => location.hash)).toBe('');
});
