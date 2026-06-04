// A full end-to-end Stripe test-mode flow: payment with card 4242 → redirect
// with hash markers → `purchase_completed`. More fragile than demo-bootstrap:
// depends on the Stripe Checkout markup and Sandbox availability. We keep it out of
// the main test:e2e and run it manually via `pnpm test:e2e:checkout:stripe`
// before a release or when we change the return-URL contract.
//
// Prerequisites are the same as demo-bootstrap.stripe.spec.ts (paywall id=3, dev-online).

import { test, expect } from '@playwright/test';

const DEMO = 'http://localhost:5070/demo/?id=3';

// Stripe Checkout sometimes loads longer than 30s, plus the form + redirect.
test.setTimeout(120_000);

test('paywall id=3 (Stripe) full test-mode checkout → purchase_completed', async ({
  page,
  context
}) => {
  await page.goto(DEMO);

  // A unique email — otherwise 409 "active purchase" from previous runs.
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await page.evaluate((e) => {
    // @ts-expect-error — __paywall is exposed in demo/main.ts
    window.__paywall.billing.setIdentity({ email: e, userId: e });
  }, email);

  // We subscribe to checkout_started BEFORE the click to grab priceId without hardcoding it
  // (it will also arrive later in the #paywall_price_id success marker).
  await page.evaluate(() => {
    (window as unknown as { __checkoutStarted?: Promise<unknown> }).__checkoutStarted =
      new Promise((resolve) => {
        // @ts-expect-error — __paywall with typed events
        window.__paywall.on('checkout_started', resolve);
      });
  });

  await page.getByRole('button', { name: 'Open paywall' }).click();

  // The CTA from the default layout. On click the SDK calls createCheckout(selectedPriceId)
  // and opens the Stripe URL in a new tab.
  const stripeTabPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Continue' }).click();
  const stripeTab = await stripeTabPromise;

  const { priceId, url } = await page.evaluate<{ priceId: string; url: string }>(
    () => (window as unknown as { __checkoutStarted: Promise<{ priceId: string; url: string }> })
      .__checkoutStarted
  );
  expect(url).toContain('cs_test_');

  // If Stripe showed a method-selection accordion, we expand the card one.
  const cardAccordion = stripeTab.getByTestId('card-accordion-item');
  if (await cardAccordion.isVisible().catch(() => false)) {
    await cardAccordion.click();
  }

  await stripeTab.getByRole('textbox', { name: 'Card number' }).fill('4242 4242 4242 4242');
  await stripeTab.getByRole('textbox', { name: 'Expiration' }).fill('12 / 34');
  await stripeTab.getByRole('textbox', { name: 'CVC' }).fill('123');
  await stripeTab.getByRole('textbox', { name: 'Cardholder name' }).fill('Test User');

  await stripeTab.getByTestId('hosted-payment-submit-button').click();

  // Stripe redirects to success_url. We wait for the demo to open in the same tab
  // with the paid hash marker.
  await stripeTab.waitForURL(/localhost:5070\/demo\/.*paywall_status=paid/, { timeout: 60_000 });

  // On onload the SDK instantiates PaywallUI, and the constructor via a microtask calls
  // checkReturn → emit purchase_completed → demo writes to #log.
  const log = stripeTab.locator('#log');
  await expect(log).toContainText(
    `purchase_completed {"priceId":"${priceId}","sessionId":null}`,
    { timeout: 10_000 }
  );

  // And the markers are wiped by history.replaceState.
  await expect.poll(async () => stripeTab.evaluate(() => location.hash)).toBe('');
});
