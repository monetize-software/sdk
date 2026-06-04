import { test, expect } from '@playwright/test';

// E2E against the demo app (demo/index.html, mounted at /demo/). The backend is
// mocked in mockFetch.ts, so the tests are offline and deterministic.
//
// The goal is a runtime check of the bindings in a real React+jsdom stack: the
// Provider actually mounts PaywallUI, the hooks react to events, the components
// resolve to the correct JSX. The TypeScript contract checks the shape;
// playwright checks that the shape actually reaches the click.

test.beforeEach(async ({ page }) => {
  await page.goto('/demo/');
});

test('Provider + usePaywallState: модалка реагирует на open()', async ({ page }) => {
  // Initial state — closed
  await expect(page.getByTestId('state')).toContainText('"open": false');

  await page.getByTestId('open').click();
  await expect(page.getByTestId('state')).toContainText('"open": true');
});

test('PaywallSupportButton открывает support-view', async ({ page }) => {
  await page.getByTestId('open-support').click();
  await expect(page.getByTestId('state')).toContainText('"view": "support"');
});

test('usePaywallEvent логирует жизненный цикл', async ({ page }) => {
  const log = page.getByTestId('events-log');
  await expect(log).toHaveText(/пока пусто/);

  await page.getByTestId('open').click();
  await expect(log).toContainText('open');

  await page.getByTestId('close').click();
  await expect(log).toContainText('close');
});

test('usePaywallPrices показывает mock-цены после bootstrap', async ({ page }) => {
  const prices = page.getByTestId('prices');
  await expect(prices).toContainText('Monthly');
  await expect(prices).toContainText('Yearly');
});

test('PaywallGate переходит из loading в blocked / granted', async ({ page }) => {
  // The mock fetch does not return a user with has_active_subscription → access.blocked.
  // The gate should show the blocked fallback and the Upgrade button.
  await expect(page.getByTestId('access-status')).toHaveText('blocked');
  await expect(page.getByTestId('gate-upgrade')).toBeVisible();

  // Clicking Upgrade in the fallback opens the modal via the render-prop open().
  await page.getByTestId('gate-upgrade').click();
  await expect(page.getByTestId('state')).toContainText('"open": true');
});
