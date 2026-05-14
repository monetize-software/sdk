import { defineConfig } from '@playwright/test';

// E2E against the React demo app in demo/. Vite dev server is started by
// playwright; tests drive a real browser to verify Provider lifecycle, hooks
// and declarative components against a live PaywallUI instance.
//
// Backend is mocked at the network layer (page.route) — these specs verify the
// bindings, not the SDK transport.
export default defineConfig({
  testDir: './tests-e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5080/demo/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
