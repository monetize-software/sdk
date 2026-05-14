import { defineConfig, devices } from '@playwright/test';

// Проекты:
//   - `extension`         — MV3 playground, fixtures.ts поднимает persistent-context с --load-extension.
//   - `demo-stripe`       — bootstrap-смоук на тест-пейволе со Stripe (id=3).
//   - `demo-paddle`       — bootstrap-смоук на тест-пейволе с Paddle (id=4).
//   - `demo-freemius`     — bootstrap-смоук на тест-пейволе с Freemius (id=5).
//   - `checkout-stripe`   — полный Stripe test-mode flow на пейволе id=3, карта 4242.
//   - `checkout-paddle`   — полный Paddle Sandbox flow на пейволе id=4.
//   - `checkout-freemius` — полный Freemius Sandbox flow на пейволе id=5 (через polling, без redirect).
// Запуск:
//   pnpm test:e2e                    → extension
//   pnpm test:e2e:demo:stripe        → smoke Stripe (CI)
//   pnpm test:e2e:demo:paddle        → smoke Paddle (CI)
//   pnpm test:e2e:demo:freemius      → smoke Freemius (CI)
//   pnpm test:e2e:checkout:stripe    → полный Stripe checkout (руками перед релизом)
//   pnpm test:e2e:checkout:paddle    → полный Paddle checkout (руками перед релизом)
//   pnpm test:e2e:checkout:freemius  → полный Freemius checkout (руками перед релизом)
//   pnpm test:e2e:all                → всё
//
// `webServer` поднимает `pnpm dev` на :5070 и форсит VITE_API_TARGET на dev-online
// (http://152.42.143.9:3000 — там крутится дев-билд из ветки `dev`, цепляется
// к тестовой БД, где живут paywall id=3 (Stripe), id=4 (Paddle), id=5 (Freemius)). Локальный
// `pnpm dev` без e2e продолжает ходить на local.paywall.app:5050 (см. vite.config.ts).
// SKIP_WEB_SERVER=1 отключает автозапуск, если dev уже крутится.
const STAGING_ONLINE = process.env.VITE_API_TARGET ?? 'http://152.42.143.9:3000';

export default defineConfig({
  testDir: './tests-e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 }
  },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'extension',
      testMatch: 'extension.spec.ts'
    },
    {
      name: 'demo-stripe',
      testMatch: 'demo-bootstrap.stripe.spec.ts',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'demo-paddle',
      testMatch: 'demo-bootstrap.paddle.spec.ts',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'demo-freemius',
      testMatch: 'demo-bootstrap.freemius.spec.ts',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'checkout-stripe',
      testMatch: 'demo-checkout.stripe.spec.ts',
      timeout: 180_000,
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'checkout-paddle',
      testMatch: 'demo-checkout.paddle.spec.ts',
      timeout: 180_000,
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'checkout-freemius',
      testMatch: 'demo-checkout.freemius.spec.ts',
      timeout: 180_000,
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: process.env.SKIP_WEB_SERVER
    ? undefined
    : {
        command: 'pnpm dev',
        url: 'http://localhost:5070/demo/',
        reuseExistingServer: true,
        timeout: 60_000,
        env: { VITE_API_TARGET: STAGING_ONLINE }
      }
});
