import { defineConfig } from '@playwright/test';

// E2E под реальный Chrome с загруженным MV3-extension'ом. Перед запуском
// `pnpm build:demo` собирает demo-extension/dist, тесты грузят его через
// --load-extension.
//
// Network policy: тесты НЕ ходят на appbox.space (CI'ные ошибки), используем
// route interception для мока bootstrap/auth/events. Архитектурные проверки
// (offscreen существует, single-source-of-truth) не зависят от backend.
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
