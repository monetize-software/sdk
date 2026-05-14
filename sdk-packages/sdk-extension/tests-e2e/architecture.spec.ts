// Architecture-level e2e: загружаем demo-extension в реальном Chrome через
// `--load-extension` и проверяем что offscreen-architecture работает как
// задумано в Chrome. Network mock'и идут через локальный HTTP-сервер
// (fixtures.mockServer); demo-extension переключается на него через
// chrome.storage.local — page.route() не достаёт offscreen контекст,
// поэтому мокаем по-настоящему на сетевом уровне.

import { test, expect } from './fixtures';

async function waitForOffscreen(
  context: import('@playwright/test').BrowserContext,
  timeoutMs = 5000
): Promise<number> {
  const [sw] = context.serviceWorkers();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await sw.evaluate(async () => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
      });
      return contexts.length;
    });
    if (count > 0) return count;
    await new Promise((r) => setTimeout(r, 100));
  }
  return 0;
}

test('service worker boots, registers onConnect listener', async ({ context, extensionId }) => {
  expect(extensionId).toBeTruthy();
  expect(extensionId).toMatch(/^[a-z]{32}$/);

  const swList = context.serviceWorkers();
  expect(swList.length).toBeGreaterThanOrEqual(1);
});

test('popup connects to SW → SW spawns offscreen document', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  const count = await waitForOffscreen(context);
  expect(count).toBe(1);
});

test('offscreen document is single across multiple popups', async ({ context, extensionId }) => {
  const page1 = await context.newPage();
  await page1.goto(`chrome-extension://${extensionId}/popup.html`);
  await waitForOffscreen(context);

  const page2 = await context.newPage();
  await page2.goto(`chrome-extension://${extensionId}/popup.html`);
  await page2.waitForTimeout(500);

  const [sw] = context.serviceWorkers();
  const offscreenCount = await sw.evaluate(async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
    });
    return contexts.length;
  });

  expect(offscreenCount).toBe(1);
});

test('popup bootstrap succeeds against mock backend', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  // popup.ts выводит 'bootstrap ok' когда billing.bootstrap() резолвнулся.
  await expect(page.locator('#state')).toContainText('bootstrap ok', { timeout: 10_000 });
});

test('two popups share single bootstrap fetch — single source of truth', async ({
  context,
  extensionId,
  mockServer
}) => {
  mockServer.reset();

  const page1 = await context.newPage();
  await page1.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page1.locator('#state')).toContainText('bootstrap ok', { timeout: 10_000 });

  const page2 = await context.newPage();
  await page2.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page2.locator('#state')).toContainText('bootstrap ok', { timeout: 10_000 });

  // Главное доказательство: один фетч /bootstrap на всё расширение, а не два.
  // Это проверяет single-source-of-truth архитектуру в реальном Chrome.
  expect(mockServer.hitCount('/bootstrap')).toBe(1);
});

test('content-script injects on http page and creates PaywallUI', async ({
  context,
  contentPage
}) => {
  const page = await context.newPage();
  // Логируем все console-сообщения content-script'а — пригодится для диагностики
  // если content-script не отстреляет.
  const messages: string[] = [];
  page.on('console', (msg) => messages.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => messages.push(`[error] ${err.message}`));

  await page.goto(contentPage.contentPageUrl, { waitUntil: 'load' });

  // data-attribute на <html> — content-script ставит при загрузке (loaded),
  // ready ставится после async-bootstrap'а PaywallUI. window.__paywall
  // живёт в isolated world content-script'а и page-context'у не виден,
  // поэтому проверяем через DOM атрибут.
  try {
    await page.waitForFunction(
      () => document.documentElement.hasAttribute('data-paywall-loaded'),
      { timeout: 10_000 }
    );
  } catch (e) {
    throw new Error(
      `data-paywall-loaded attribute not set within timeout. Console messages:\n${messages.join('\n')}`
    );
  }

  await page.waitForFunction(
    () => document.documentElement.hasAttribute('data-paywall-ready'),
    { timeout: 10_000 }
  );
});

test('cross-tab user-state: refresh in tab1 broadcasts to tab2', async ({
  context,
  extensionId,
  mockServer
}) => {
  // Watcher и реальный stripe-popup в e2e не воспроизводим (нет real OAuth/redirect-loop'а).
  // Архитектурное доказательство — переключение has_active_subscription в одном
  // таб'е через getUser({force:true}) broadcast'ится в остальные через
  // userChange-event, которое идёт от offscreen'а во все content-канал'ы.
  let userActive = false;
  mockServer.on('/user-state', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        has_active_subscription: userActive,
        purchases: userActive
          ? [{ id: 'p1', status: 'active', current_period_end: null, cancel_at_period_end: false }]
          : [],
        trial: null
      })
    );
  });

  const page1 = await context.newPage();
  await page1.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page1.locator('#state')).toContainText('bootstrap ok', { timeout: 10_000 });

  const page2 = await context.newPage();
  await page2.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page2.locator('#state')).toContainText('bootstrap ok', { timeout: 10_000 });

  // identity нужно для /user-state (BillingClient шлёт X-User-Email).
  await page1.evaluate(() => {
    const pw = (window as unknown as {
      __paywall: { billing: { setIdentity: (i: { email: string }) => Promise<void> } };
    }).__paywall;
    return pw.billing.setIdentity({ email: 'test@x.io' });
  });

  // Initial user fetch — has_active=false.
  await page1.evaluate(async () => {
    const pw = (window as unknown as {
      __paywall: { billing: { getUser: (p: { force: boolean }) => Promise<unknown> } };
    }).__paywall;
    await pw.billing.getUser({ force: true });
  });

  // Юзер «заплатил» — mock переключается.
  userActive = true;

  // tab1 force-refresh → BillingClient.userChange broadcast → tab2 mirror-update.
  await page1.evaluate(async () => {
    const pw = (window as unknown as {
      __paywall: { billing: { getUser: (p: { force: boolean }) => Promise<unknown> } };
    }).__paywall;
    await pw.billing.getUser({ force: true });
  });

  // tab2 видит свежий user через RemoteBillingClient.getCachedUser
  // (заполняется broadcast'ом userChange).
  await expect
    .poll(
      async () =>
        await page2.evaluate(() => {
          const pw = (window as unknown as {
            __paywall: {
              billing: {
                getCachedUser: () => { has_active_subscription?: boolean } | null;
              };
            };
          }).__paywall;
          return pw.billing.getCachedUser()?.has_active_subscription ?? false;
        }),
      { timeout: 5_000, intervals: [200] }
    )
    .toBe(true);
});

test('interaction: clicking Restore opens auth gate (signin form appears)', async ({
  context,
  extensionId
}) => {
  // Regression: раньше RemoteBillingClient.auth был undefined → PaywallRoot
  // получал client.auth = undefined → restore action в no-op'ил молча.
  // Этот тест воспроизводит юзерский flow: открыть пейвол, кликнуть
  // Restore purchases, увидеть signin-форму.
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 700 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#state')).toContainText('bootstrap ok', { timeout: 10_000 });

  // Открыть модалку.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const pw = (window as unknown as {
          __paywall: { on: (e: string, cb: () => void) => () => void; open: () => void };
        }).__paywall;
        pw.on('ready', () => resolve());
        pw.open();
      })
  );

  // Найти Restore-кнопку. Modal в Shadow DOM (open mode), Playwright
  // pierces shadow boundaries через role-locator. По getByRole надёжнее
  // чем getByText — последний может задеть SVG-text или label-обёртки.
  const restoreBtn = page.getByRole('button', { name: /restore/i });
  await expect(restoreBtn).toBeVisible({ timeout: 5000 });
  await restoreBtn.click();

  // Auth-gate должен открыться — email-input первый признак signin-формы.
  await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
});

test('visual: popup with paywall modal matches reference screenshot', async ({
  context,
  extensionId
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 700 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#state')).toContainText('bootstrap ok', { timeout: 10_000 });

  // Открываем модалку и ждём render-ready (через ready event) — модалка
  // должна стабилизироваться до screenshot'а.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const pw = (window as unknown as {
          __paywall: { on: (e: string, cb: () => void) => () => void; open: () => void };
        }).__paywall;
        pw.on('ready', () => resolve());
        pw.open();
      })
  );
  // Дать одному frame'у пройти, чтобы стили закоммитились.
  await page.waitForTimeout(200);

  await expect(page).toHaveScreenshot('popup-paywall-modal.png', {
    fullPage: false,
    maxDiffPixelRatio: 0.02
  });
});

test('persistence: auth session in storage survives offscreen close/reopen', async ({
  context,
  extensionId,
  mockServer
}) => {
  // Mock signin endpoint чтобы установить session.
  mockServer.on('/auth/email/signin', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        access_token: 'persisted-at',
        refresh_token: 'persisted-rt',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'bearer',
        user: { id: 'u-persisted', email: 'persist@x.io' }
      })
    );
  });

  const page1 = await context.newPage();
  await page1.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page1.locator('#state')).toContainText('bootstrap ok', { timeout: 10_000 });

  // Логинимся через RemoteAuthClient.
  await page1.evaluate(async () => {
    const pw = (window as unknown as {
      __paywall: { auth: { signInWithEmail: (i: { email: string; password: string }) => Promise<unknown> } };
    }).__paywall;
    await pw.auth.signInWithEmail({ email: 'persist@x.io', password: 'pw' });
  });

  // Закрываем offscreen — эмулирует idle-eviction. SW обнаружит пропажу при
  // следующем content connect и пересоздаст.
  const [sw] = context.serviceWorkers();
  await sw.evaluate(async () => {
    if (chrome.offscreen.closeDocument) {
      try {
        await chrome.offscreen.closeDocument();
      } catch {
        /* ignore */
      }
    }
  });

  // Новый popup — поднимет offscreen с rehydrate из storage.
  const page2 = await context.newPage();
  await page2.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page2.locator('#state')).toContainText('bootstrap ok', { timeout: 10_000 });

  // Session должна быть восстановлена — RemoteAuthClient.ready() резолвится
  // с непустой session.
  const sessionToken = await page2.evaluate(async () => {
    const pw = (window as unknown as {
      __paywall: { auth: { ready: () => Promise<void>; getCachedSession: () => { access_token?: string } | null } };
    }).__paywall;
    await pw.auth.ready();
    return pw.auth.getCachedSession()?.access_token ?? null;
  });

  expect(sessionToken).toBe('persisted-at');
});
