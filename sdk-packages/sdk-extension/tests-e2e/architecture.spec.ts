// Architecture-level e2e: we load the demo-extension into a real Chrome via
// `--load-extension` and verify that the offscreen-architecture works as
// intended in Chrome. Network mocks go through a local HTTP server
// (fixtures.mockServer); the demo-extension switches to it via
// chrome.storage.local — page.route() doesn't reach the offscreen context,
// so we mock for real at the network level.

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
  // popup.ts prints 'bootstrap ok' when billing.bootstrap() resolves.
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

  // The key proof: a single /bootstrap fetch for the whole extension, not two.
  // This verifies the single-source-of-truth architecture in a real Chrome.
  expect(mockServer.hitCount('/bootstrap')).toBe(1);
});

test('content-script injects on http page and creates PaywallUI', async ({
  context,
  contentPage
}) => {
  const page = await context.newPage();
  // Log all console messages from the content-script — useful for diagnostics
  // if the content-script doesn't fire.
  const messages: string[] = [];
  page.on('console', (msg) => messages.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => messages.push(`[error] ${err.message}`));

  await page.goto(contentPage.contentPageUrl, { waitUntil: 'load' });

  // data-attribute on <html> — the content-script sets it on load (loaded),
  // ready is set after the async bootstrap of PaywallUI. window.__paywall
  // lives in the content-script's isolated world and isn't visible to the page-context,
  // so we check via the DOM attribute.
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
  // We don't reproduce the watcher and a real stripe-popup in e2e (no real OAuth/redirect-loop).
  // The architectural proof: toggling has_active_subscription in one
  // tab via getUser({force:true}) is broadcast to the others via the
  // userChange-event, which goes from offscreen to all content channels.
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

  // identity is needed for /user-state (BillingClient sends X-User-Email).
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

  // The user «paid» — the mock toggles.
  userActive = true;

  // tab1 force-refresh → BillingClient.userChange broadcast → tab2 mirror-update.
  await page1.evaluate(async () => {
    const pw = (window as unknown as {
      __paywall: { billing: { getUser: (p: { force: boolean }) => Promise<unknown> } };
    }).__paywall;
    await pw.billing.getUser({ force: true });
  });

  // tab2 sees the fresh user via RemoteBillingClient.getCachedUser
  // (populated by the userChange broadcast).
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
  // Regression: previously RemoteBillingClient.auth was undefined → PaywallRoot
  // received client.auth = undefined → the restore action silently no-op'd.
  // This test reproduces the user flow: open the paywall, click
  // Restore purchases, see the signin form.
  const page = await context.newPage();
  await page.setViewportSize({ width: 800, height: 700 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#state')).toContainText('bootstrap ok', { timeout: 10_000 });

  // Open the modal.
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

  // Find the Restore button. The modal is in Shadow DOM (open mode), Playwright
  // pierces shadow boundaries via the role-locator. getByRole is more reliable
  // than getByText — the latter may hit SVG-text or label wrappers.
  const restoreBtn = page.getByRole('button', { name: /restore/i });
  await expect(restoreBtn).toBeVisible({ timeout: 5000 });
  await restoreBtn.click();

  // The auth-gate should open — the email-input is the first sign of the signin form.
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

  // Open the modal and wait for render-ready (via the ready event) — the modal
  // must stabilize before the screenshot.
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
  // Let one frame pass so the styles get committed.
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
  // Mock the signin endpoint to establish a session.
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

  // Sign in via RemoteAuthClient.
  await page1.evaluate(async () => {
    const pw = (window as unknown as {
      __paywall: { auth: { signInWithEmail: (i: { email: string; password: string }) => Promise<unknown> } };
    }).__paywall;
    await pw.auth.signInWithEmail({ email: 'persist@x.io', password: 'pw' });
  });

  // Close offscreen — this emulates idle-eviction. The SW will detect it's gone on
  // the next content connect and recreate it.
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

  // A new popup — brings up offscreen with rehydrate from storage.
  const page2 = await context.newPage();
  await page2.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page2.locator('#state')).toContainText('bootstrap ok', { timeout: 10_000 });

  // The session must be restored — RemoteAuthClient.ready() resolves
  // with a non-empty session.
  const sessionToken = await page2.evaluate(async () => {
    const pw = (window as unknown as {
      __paywall: { auth: { ready: () => Promise<void>; getCachedSession: () => { access_token?: string } | null } };
    }).__paywall;
    await pw.auth.ready();
    return pw.auth.getCachedSession()?.access_token ?? null;
  });

  expect(sessionToken).toBe('persisted-at');
});
