// A stable e2e smoke without a real payment on Paddle Sandbox. Mirrors the Stripe
// variant (see demo-bootstrap.stripe.spec.ts), only paywall id=4 → Paddle
// test acquiring. We don't check the cancel-link DOM on the Paddle side here —
// Paddle hosted checkout renders differently, and the cancel_url contract is
// validated in demo-checkout.paddle.spec.ts on the full flow.
//
// Prerequisites:
//   1. dev-online at http://152.42.143.9:3000 is reachable (test DB, paywall id=4
//      configured for Paddle in test-mode).
//   2. SDK dev at http://localhost:5070 — started by the webServer in
//      playwright.config.ts with VITE_API_TARGET=dev-online.
//   3. sdk/.env.local with VITE_PAYWALL_API_KEY.

import { test, expect } from '@playwright/test';

const DEMO = 'http://localhost:5070/demo/?id=4';

test('paywall id=4 (Paddle) bootstraps with test-mode badge and emits Paddle checkout URL', async ({
  page
}) => {
  await page.goto(DEMO);

  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await page.evaluate((e) => {
    // @ts-expect-error — __paywall is exposed in demo/main.ts
    window.__paywall.billing.setIdentity({ email: e, userId: e });
  }, email);

  await page.evaluate(() => {
    (window as unknown as { __checkoutStarted?: Promise<unknown> }).__checkoutStarted =
      new Promise((resolve) => {
        // @ts-expect-error — __paywall with typed events
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
  // A general pattern is enough — the specific subdomain varies between environments.
  expect(url).toMatch(/paddle\.(com|io)/);
});
