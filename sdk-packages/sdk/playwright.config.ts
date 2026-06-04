import { defineConfig, devices } from '@playwright/test';

// Projects:
//   - `extension`         — MV3 playground, fixtures.ts spins up a persistent-context with --load-extension.
//   - `demo-stripe`       — bootstrap smoke on the Stripe test paywall (id=3).
//   - `demo-paddle`       — bootstrap smoke on the Paddle test paywall (id=4).
//   - `demo-freemius`     — bootstrap smoke on the Freemius test paywall (id=5).
//   - `checkout-stripe`   — full Stripe test-mode flow on paywall id=3, card 4242.
//   - `checkout-paddle`   — full Paddle Sandbox flow on paywall id=4.
//   - `checkout-freemius` — full Freemius Sandbox flow on paywall id=5 (via polling, without redirect).
// Running:
//   pnpm test:e2e                    → extension
//   pnpm test:e2e:demo:stripe        → smoke Stripe (CI)
//   pnpm test:e2e:demo:paddle        → smoke Paddle (CI)
//   pnpm test:e2e:demo:freemius      → smoke Freemius (CI)
//   pnpm test:e2e:checkout:stripe    → full Stripe checkout (manually before release)
//   pnpm test:e2e:checkout:paddle    → full Paddle checkout (manually before release)
//   pnpm test:e2e:checkout:freemius  → full Freemius checkout (manually before release)
//   pnpm test:e2e:all                → everything
//
// `webServer` spins up `pnpm dev` on :5070 and forces VITE_API_TARGET to dev-online
// (http://152.42.143.9:3000 — a dev build from the `dev` branch runs there, connecting
// to the test DB where paywall id=3 (Stripe), id=4 (Paddle), id=5 (Freemius) live). A local
// `pnpm dev` without e2e keeps hitting local.paywall.app:5050 (see vite.config.ts).
// SKIP_WEB_SERVER=1 disables the autostart if dev is already running.
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
