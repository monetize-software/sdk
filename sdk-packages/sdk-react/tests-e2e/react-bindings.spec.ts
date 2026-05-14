import { test, expect } from '@playwright/test';

// E2E против demo-приложения (demo/index.html, mountится в /demo/). Бэк
// замокан в mockFetch.ts, поэтому тесты офлайн и детерминированные.
//
// Цель — runtime-проверка биндингов в реальном React+jsdom-стеке: Provider
// действительно монтирует PaywallUI, хуки реагируют на события, компоненты
// разрешаются в правильный JSX. TypeScript-контракт проверяет shape;
// playwright — что shape вообще доходит до клика.

test.beforeEach(async ({ page }) => {
  await page.goto('/demo/');
});

test('Provider + usePaywallState: модалка реагирует на open()', async ({ page }) => {
  // Initial state — закрыта
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
  // Mock fetch не отдаёт user с has_active_subscription → access.blocked.
  // Гейт должен показать blocked fallback и кнопку Upgrade.
  await expect(page.getByTestId('access-status')).toHaveText('blocked');
  await expect(page.getByTestId('gate-upgrade')).toBeVisible();

  // Клик по Upgrade в фоллбеке открывает модалку через render-prop'овый open().
  await page.getByTestId('gate-upgrade').click();
  await expect(page.getByTestId('state')).toContainText('"open": true');
});
