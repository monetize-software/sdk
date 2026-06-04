// A full end-to-end Freemius Sandbox flow on paywall id=5 → polling user-state →
// `purchase_completed`. KEY DIFFERENCE from Stripe/Paddle: Freemius hosted
// checkout does NOT redirect to success_url (see online/utils/freemius/server.ts:106-113),
// so the SDK learns about payment not via hash markers but via UserWatcher
// polling (starts on `checkout_started`, ticks every 5s in a visible tab —
// see sdk/src/ui/UserWatcher.ts). After submitting the form we return to the demo tab,
// so visibility-change wakes the watcher and check() runs immediately.
//
// More fragile than Stripe/Paddle: the checkout.freemius.com markup may drift, plus
// success depends on the webhook from Freemius reaching dev-online and
// updating the user's subscription before the test times out. We run it manually
// via `pnpm test:e2e:checkout:freemius` before a release.
//
// Prerequisites are the same as demo-bootstrap.freemius.spec.ts (paywall id=5, dev-online).
//
// The Freemius Sandbox form selectors are best-effort. If the test starts failing on
// filling the form, record a new DOM snapshot via `--debug` and fix the
// selectors; do not try to adapt via retries.

import { test, expect } from '@playwright/test';

const DEMO = 'http://localhost:5070/demo/?id=5';

test.setTimeout(180_000);

test('paywall id=5 (Freemius) full sandbox checkout → purchase_completed via polling', async ({
  page,
  context
}) => {
  await page.goto(DEMO);

  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await page.evaluate((e) => {
    // @ts-expect-error — __paywall is exposed in demo/main.ts
    window.__paywall.billing.setIdentity({ email: e, userId: e });
  }, email);

  // We subscribe to checkout_started and purchase_completed BEFORE the click. The watcher
  // starts synchronously on checkout_started, so the subscription must be in place
  // beforehand, otherwise the first polling tick may fire before we attach the
  // listener.
  await page.evaluate(() => {
    const w = window as unknown as {
      __checkoutStarted?: Promise<unknown>;
      __purchaseCompleted?: Promise<unknown>;
    };
    w.__checkoutStarted = new Promise((resolve) => {
      // @ts-expect-error — __paywall with typed events
      window.__paywall.on('checkout_started', resolve);
    });
    w.__purchaseCompleted = new Promise((resolve) => {
      // @ts-expect-error — __paywall with typed events
      window.__paywall.on('purchase_completed', resolve);
    });
  });

  await page.getByRole('button', { name: 'Open paywall' }).click();

  const freemiusTabPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Continue' }).click();
  const freemiusTab = await freemiusTabPromise;

  const { url } = await page.evaluate<{ url: string }>(
    () => (window as unknown as { __checkoutStarted: Promise<{ url: string }> }).__checkoutStarted
  );
  expect(url).toMatch(/checkout\.freemius\.com\/product\/\d+\/plan\/\d+\//);
  expect(url).toContain('sandbox=true');

  await freemiusTab.waitForLoadState('domcontentloaded');

  // The email is pre-filled via user_email + readonly_user=true in the query
  // (see utils/freemius/server.ts) — we send it only if the form does
  // ask for it. The name is required in most Freemius checkout configs.
  const nameInput = freemiusTab.getByLabel(/name|full name|customer name/i).first();
  if (await nameInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await nameInput.fill('Test User');
  }

  const emailInput = freemiusTab.getByLabel(/email/i).first();
  if (await emailInput.isEditable().catch(() => false)) {
    await emailInput.fill(email);
  }

  // Freemius card fields are usually in Stripe Elements iframes. We try
  // both the main document (some configs serve their own inputs) and via
  // frameLocator by characteristic placeholder/label.
  const fillCard = async () => {
    const directNumber = freemiusTab.getByLabel(/card number/i).first();
    if (await directNumber.isVisible().catch(() => false)) {
      await directNumber.fill('4242 4242 4242 4242');
      await freemiusTab.getByLabel(/expir|mm.*yy/i).first().fill('12/34');
      await freemiusTab.getByLabel(/cvc|cvv|security/i).first().fill('123');
      return;
    }
    // Stripe Elements iframe — each field in its own iframe (cardNumber,
    // cardExpiry, cardCvc). The iframe name is formalized in Stripe.js, but Freemius
    // wraps them its own way — we filter by placeholder.
    const numberFrame = freemiusTab
      .frameLocator('iframe')
      .locator('input[name="cardnumber"], input[placeholder*="1234"], input[autocomplete="cc-number"]')
      .first();
    await numberFrame.fill('4242 4242 4242 4242');
    const expFrame = freemiusTab
      .frameLocator('iframe')
      .locator('input[name="exp-date"], input[autocomplete="cc-exp"], input[placeholder*="MM"]')
      .first();
    await expFrame.fill('12 / 34');
    const cvcFrame = freemiusTab
      .frameLocator('iframe')
      .locator('input[name="cvc"], input[autocomplete="cc-csc"], input[placeholder*="CVC"]')
      .first();
    await cvcFrame.fill('123');
  };
  await fillCard();

  // Submit: on Freemius hosted checkout the button is usually "Pay $X" / "Start my
  // subscription" / "Subscribe". We match by a broad regex to survive
  // copy variations.
  await freemiusTab.getByRole('button', { name: /pay|subscribe|start.*subscription|buy/i }).first().click();

  // We return to the demo tab: visibilitychange → visible wakes UserWatcher
  // and triggers an immediate check() (see sdk/src/ui/UserWatcher.ts handleVisibility).
  // Without this, polling runs once every 30s (hidden) and the test times out.
  await page.bringToFront();

  // We wait for purchase_completed: webhook from Freemius → online updates
  // has_active_subscription → the next UserWatcher tick (5s visible) catches
  // the active subscription and emits the event. Generous timeout — the webhook may
  // lag on dev-stage.
  const log = page.locator('#log');
  await expect(log).toContainText('purchase_completed', { timeout: 120_000 });

  // Server-confirmed path: priceId/sessionId are null here (unlike the
  // hash-marker flow, where they come from the URL). See PaywallUI.startUserWatcher
  // — onActive emits purchase_completed with priceId:null.
  await expect(log).toContainText('purchase_completed {"priceId":null,"sessionId":null}');
});
