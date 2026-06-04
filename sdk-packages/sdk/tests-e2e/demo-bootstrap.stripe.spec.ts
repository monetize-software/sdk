// A stable e2e smoke without a real payment on Stripe Checkout. Runs in CI and
// as a pre-commit sanity check: verifies that `/bootstrap` returns `is_test_mode`,
// the SDK draws the "Test mode — no real charge" badge, the UI on a CTA click itself calls
// `createCheckout` and emits `checkout_started` with a Stripe `cs_test_*` URL,
// and the cancel_url with hash markers reaches Stripe (checked via the DOM).
//
// Prerequisites:
//   1. dev-online at http://152.42.143.9:3000 is reachable (test DB, paywall id=3
//      configured for Stripe in test-mode).
//   2. SDK dev at http://localhost:5070 — started by the webServer in
//      playwright.config.ts with VITE_API_TARGET=dev-online.
//   3. sdk/.env.local with VITE_PAYWALL_API_KEY (the test DB key).

import { test, expect } from '@playwright/test';

const DEMO = 'http://localhost:5070/demo/?id=3';

test('paywall id=3 (Stripe) bootstraps with test-mode badge and emits Stripe cs_test URL', async ({
  page,
  context
}) => {
  await page.goto(DEMO);

  // A unique email — otherwise the backend returns 409 "active purchase" because of subscriptions
  // from previous runs.
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await page.evaluate((e) => {
    // @ts-expect-error — __paywall is exposed in demo/main.ts
    window.__paywall.billing.setIdentity({ email: e, userId: e });
  }, email);

  // We put `checkout_started` into window.__checkoutStarted BEFORE the click, to
  // capture the payload (priceId is chosen by default from bootstrap, we don't
  // hardcode the ID — the price provider may regenerate them).
  await page.evaluate(() => {
    (window as unknown as { __checkoutStarted?: Promise<unknown> }).__checkoutStarted =
      new Promise((resolve) => {
        // @ts-expect-error — __paywall with typed events
        window.__paywall.on('checkout_started', resolve);
      });
  });

  await page.getByRole('button', { name: 'Open paywall' }).click();

  // Shadow-mode open → Playwright sees the modal through the accessibility tree.
  await expect(page.getByRole('status')).toContainText('Test mode — no real charge');

  // is_test_mode came from /bootstrap and landed in the demo log (JSON.stringify).
  await expect(page.locator('#log')).toContainText('"is_test_mode":true');

  // The CTA from the default layout is the "Continue" button. On click the SDK itself calls
  // createCheckout(selectedPriceId) and opens the URL in a new tab.
  const stripeTabPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Continue' }).click();

  const { priceId, url } = await page.evaluate<{ priceId: string; url: string }>(
    () => (window as unknown as { __checkoutStarted: Promise<{ priceId: string; url: string }> })
      .__checkoutStarted
  );
  expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);

  const stripeTab = await stripeTabPromise;
  await stripeTab.waitForLoadState('domcontentloaded');

  // The "Back" link on Stripe points to the cancel_url that online assembled with
  // our hash markers (paywall-return-url.ts). We check this end-to-end.
  const backHref = await stripeTab.evaluate<string | undefined>(
    () => document.querySelector<HTMLAnchorElement>('a[href*="paywall_status"]')?.href
  );
  expect(backHref).toBe(
    `http://localhost:5070/demo/?id=3#paywall_status=cancelled&paywall_price_id=${priceId}`
  );
  await stripeTab.close();
});
