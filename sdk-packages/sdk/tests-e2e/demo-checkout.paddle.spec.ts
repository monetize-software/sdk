// A full end-to-end Paddle Sandbox flow on paywall id=4 → redirect with hash
// markers → `purchase_completed`. More fragile than the bootstrap smoke: depends on
// the Paddle hosted checkout markup. We run it manually via
// `pnpm test:e2e:checkout:paddle` before a release or when we change the return-URL
// contract on the Paddle side.
//
// Prerequisites are the same as demo-bootstrap.paddle.spec.ts (paywall id=4, dev-online).
//
// The Paddle Sandbox form selectors may drift over time — Paddle Billing
// 2.0 renders an inline checkout, and the attributes are not as stable as Stripe's.
// If the test starts failing, record a new DOM snapshot via `--debug` and
// fix the selectors; do not try to adapt via retries.

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

  const paddleTabPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Continue' }).click();
  const paddleTab = await paddleTabPromise;

  const { priceId, url } = await page.evaluate<{ priceId: string; url: string }>(
    () => (window as unknown as { __checkoutStarted: Promise<{ priceId: string; url: string }> })
      .__checkoutStarted
  );
  expect(url).toMatch(/paddle\.(com|io)/);

  await paddleTab.waitForLoadState('domcontentloaded');

  // Paddle Sandbox accepts 4242. Fields by placeholder/label, no testid.
  // The email is usually pre-filled from the start-checkout payload, but if the form
  // asks for it, we send it.
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

  // The submit button on Paddle hosted checkout is usually "Pay …" / "Subscribe …".
  await paddleTab.getByRole('button', { name: /pay|subscribe/i }).click();

  await paddleTab.waitForURL(/localhost:5070\/demo\/.*paywall_status=paid/, { timeout: 60_000 });

  const log = paddleTab.locator('#log');
  await expect(log).toContainText(
    `purchase_completed {"priceId":"${priceId}","sessionId":null}`,
    { timeout: 10_000 }
  );

  await expect.poll(async () => paddleTab.evaluate(() => location.hash)).toBe('');
});
