// A stable e2e smoke without a real payment on Freemius Sandbox. Mirrors the
// Paddle variant (see demo-bootstrap.paddle.spec.ts), only paywall id=5 →
// Freemius test acquiring (sandbox=true).
//
// We don't check the cancel-link DOM on the Freemius side — checkout.freemius.com
// renders an iframe with dynamic markup, and the cancel_url contract is validated
// in demo-checkout.freemius.spec.ts on the full flow (if it gets written).
//
// NB: Freemius hosted checkout has NO query parameter for a success-redirect — after
// payment the SDK learns about the purchase via polling user-state (UserWatcher), not via
// hash markers. See online/utils/freemius/server.ts.
//
// Prerequisites:
//   1. dev-online at http://152.42.143.9:3000 is reachable (test DB, paywall id=5
//      configured for Freemius in test-mode).
//   2. SDK dev at http://localhost:5070 — started by the webServer in
//      playwright.config.ts with VITE_API_TARGET=dev-online.
//   3. sdk/.env.local with VITE_PAYWALL_API_KEY.

import { test, expect } from '@playwright/test';

const DEMO = 'http://localhost:5070/demo/?id=5';

test('paywall id=5 (Freemius) bootstraps with test-mode badge and emits Freemius sandbox URL', async ({
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

  // Freemius hosted checkout: https://checkout.freemius.com/product/<id>/plan/<id>/?...&sandbox=true
  expect(url).toMatch(/^https:\/\/checkout\.freemius\.com\/product\/\d+\/plan\/\d+\//);
  // Test-mode → the query contains sandbox=true (see utils/freemius/server.ts).
  expect(url).toContain('sandbox=true');
});
