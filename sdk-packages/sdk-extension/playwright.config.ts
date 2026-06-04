import { defineConfig } from '@playwright/test';

// E2E against a real Chrome with a loaded MV3 extension. Before running,
// `pnpm build:demo` builds demo-extension/dist, and the tests load it via
// --load-extension.
//
// Network policy: tests do NOT hit appbox.space (CI errors), we use route
// interception to mock bootstrap/auth/events. Architectural checks (offscreen
// exists, single-source-of-truth) don't depend on the backend.
export default defineConfig({
  testDir: './tests-e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  projects: [
    {
      name: 'extension-architecture',
      testMatch: 'architecture.spec.ts'
    }
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
