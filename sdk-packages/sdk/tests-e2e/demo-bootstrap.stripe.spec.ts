// Стабильный e2e smoke без реальной оплаты на Stripe Checkout. Гоняется в CI и
// как pre-commit sanity: проверяет, что `/bootstrap` отдаёт `is_test_mode`,
// SDK рисует плашку «Test mode — no real charge», UI на клик CTA сам зовёт
// `createCheckout` и эмитит `checkout_started` с Stripe `cs_test_*` URL,
// а cancel_url с hash-маркерами доходит до Stripe (проверяем через DOM).
//
// Препросы:
//   1. dev-online на http://152.42.143.9:3000 доступен (тест-БД, paywall id=3
//      настроен на Stripe в test-mode).
//   2. SDK dev на http://localhost:5070 — поднимается webServer'ом в
//      playwright.config.ts с VITE_API_TARGET=dev-online.
//   3. sdk/.env.local с VITE_PAYWALL_API_KEY (ключ от тест-БД).

import { test, expect } from '@playwright/test';

const DEMO = 'http://localhost:5070/demo/?id=3';

test('paywall id=3 (Stripe) bootstraps with test-mode badge and emits Stripe cs_test URL', async ({
  page,
  context
}) => {
  await page.goto(DEMO);

  // Уникальный email — иначе бэк отдаст 409 «active purchase» из-за подписок
  // от предыдущих прогонов.
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await page.evaluate((e) => {
    // @ts-expect-error — __paywall экспонируется в demo/main.ts
    window.__paywall.billing.setIdentity({ email: e, userId: e });
  }, email);

  // Кладём `checkout_started` в window.__checkoutStarted ДО клика, чтобы
  // зафиксировать payload (priceId выбирается дефолтно из bootstrap, ID не
  // хардкодим — провайдер прайсов может их перегенерить).
  await page.evaluate(() => {
    (window as unknown as { __checkoutStarted?: Promise<unknown> }).__checkoutStarted =
      new Promise((resolve) => {
        // @ts-expect-error — __paywall с типизированными событиями
        window.__paywall.on('checkout_started', resolve);
      });
  });

  await page.getByRole('button', { name: 'Open paywall' }).click();

  // Shadow-режим open → Playwright видит модалку через accessibility-дерево.
  await expect(page.getByRole('status')).toContainText('Test mode — no real charge');

  // is_test_mode пришёл из /bootstrap и попал в лог demo (JSON.stringify).
  await expect(page.locator('#log')).toContainText('"is_test_mode":true');

  // CTA из дефолтного layout — кнопка «Continue». На клике SDK сам вызывает
  // createCheckout(selectedPriceId) и открывает URL в новом табе.
  const stripeTabPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Continue' }).click();

  const { priceId, url } = await page.evaluate<{ priceId: string; url: string }>(
    () => (window as unknown as { __checkoutStarted: Promise<{ priceId: string; url: string }> })
      .__checkoutStarted
  );
  expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);

  const stripeTab = await stripeTabPromise;
  await stripeTab.waitForLoadState('domcontentloaded');

  // «Back»-линк на Stripe ведёт на cancel_url, который online собрал с
  // нашими hash-маркерами (paywall-return-url.ts). Проверяем end-to-end.
  const backHref = await stripeTab.evaluate<string | undefined>(
    () => document.querySelector<HTMLAnchorElement>('a[href*="paywall_status"]')?.href
  );
  expect(backHref).toBe(
    `http://localhost:5070/demo/?id=3#paywall_status=cancelled&paywall_price_id=${priceId}`
  );
  await stripeTab.close();
});
