// Полный сквозной Freemius Sandbox flow на paywall id=5 → polling user-state →
// `purchase_completed`. КЛЮЧЕВОЕ ОТЛИЧИЕ от Stripe/Paddle: Freemius hosted
// checkout НЕ редиректит на success_url (см. online/utils/freemius/server.ts:106-113),
// поэтому SDK узнаёт об оплате не через hash-маркеры, а через UserWatcher
// polling (стартует на `checkout_started`, тикает каждые 5s в visible вкладке —
// см. sdk/src/ui/UserWatcher.ts). После сабмита формы возвращаемся в demo-таб,
// чтобы visibility-change разбудил watcher и check() пошёл сразу.
//
// Хрупче, чем Stripe/Paddle: вёрстка checkout.freemius.com может поплыть, плюс
// успех зависит от того, что webhook от Freemius долетит до dev-online и
// обновит подписку юзера до того, как тест выйдет в timeout. Запускаем вручную
// через `pnpm test:e2e:checkout:freemius` перед релизом.
//
// Препросы те же, что у demo-bootstrap.freemius.spec.ts (paywall id=5, dev-online).
//
// Селекторы Freemius Sandbox формы — best-effort. Если тест начнёт падать на
// заполнении формы — записать новый снимок DOM через `--debug` и поправить
// селекторы; не пытаться адаптировать через retries.

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
    // @ts-expect-error — __paywall экспонируется в demo/main.ts
    window.__paywall.billing.setIdentity({ email: e, userId: e });
  }, email);

  // Подписываемся на checkout_started и purchase_completed ДО клика. Watcher
  // стартует синхронно на checkout_started, поэтому подписка должна стоять
  // заранее, иначе первый тик polling может улететь до того, как мы навесим
  // listener.
  await page.evaluate(() => {
    const w = window as unknown as {
      __checkoutStarted?: Promise<unknown>;
      __purchaseCompleted?: Promise<unknown>;
    };
    w.__checkoutStarted = new Promise((resolve) => {
      // @ts-expect-error — __paywall с типизированными событиями
      window.__paywall.on('checkout_started', resolve);
    });
    w.__purchaseCompleted = new Promise((resolve) => {
      // @ts-expect-error — __paywall с типизированными событиями
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

  // Email пред-заполнен через user_email + readonly_user=true в query
  // (см. utils/freemius/server.ts) — досылаем только если форма всё-таки
  // попросила. Имя — обязательное в большинстве конфигов Freemius checkout.
  const nameInput = freemiusTab.getByLabel(/name|full name|customer name/i).first();
  if (await nameInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await nameInput.fill('Test User');
  }

  const emailInput = freemiusTab.getByLabel(/email/i).first();
  if (await emailInput.isEditable().catch(() => false)) {
    await emailInput.fill(email);
  }

  // Карточные поля у Freemius обычно в Stripe Elements iframe'ах. Пытаемся
  // и в основном документе (некоторые конфиги отдают свои инпуты), и через
  // frameLocator по характерным placeholder/label.
  const fillCard = async () => {
    const directNumber = freemiusTab.getByLabel(/card number/i).first();
    if (await directNumber.isVisible().catch(() => false)) {
      await directNumber.fill('4242 4242 4242 4242');
      await freemiusTab.getByLabel(/expir|mm.*yy/i).first().fill('12/34');
      await freemiusTab.getByLabel(/cvc|cvv|security/i).first().fill('123');
      return;
    }
    // Stripe Elements iframe — каждое поле в своём iframe (cardNumber,
    // cardExpiry, cardCvc). Имя iframe формализовано в Stripe.js, но Freemius
    // оборачивает их по-своему — фильтруем по placeholder.
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

  // Submit: у Freemius hosted checkout кнопка обычно «Pay $X» / «Start my
  // subscription» / «Subscribe». Берём по широкому regex, чтобы переживать
  // варианты копирайта.
  await freemiusTab.getByRole('button', { name: /pay|subscribe|start.*subscription|buy/i }).first().click();

  // Возвращаемся в demo-таб: visibilitychange → visible пробуждает UserWatcher
  // и тригерит немедленный check() (см. sdk/src/ui/UserWatcher.ts handleVisibility).
  // Без этого поллинг идёт раз в 30s (hidden), и тест выйдет в timeout.
  await page.bringToFront();

  // Ждём purchase_completed: webhook от Freemius → online обновляет
  // has_active_subscription → следующий tick UserWatcher (5s visible) ловит
  // активную подписку и эмитит событие. Generous timeout — webhook может
  // лагнуть на dev-stage.
  const log = page.locator('#log');
  await expect(log).toContainText('purchase_completed', { timeout: 120_000 });

  // Server-confirmed путь: priceId/sessionId здесь null (отличие от
  // hash-marker flow, где они приходят из URL). См. PaywallUI.startUserWatcher
  // — onActive эмитит purchase_completed с priceId:null.
  await expect(log).toContainText('purchase_completed {"priceId":null,"sessionId":null}');
});
