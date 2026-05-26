// Demo helper: восстановление сессии после 401 от backend'а. Показывает
// демонстрационный паттерн для host'ов SDK — реальный extension'у скорее
// всего захочется обернуть это в свой UX / state-machine.
//
// Идея: запоминаем в chrome.storage признак "юзер когда-либо логинился реальной
// identity" (email/OAuth, не анонимно). Когда gateway отвечает 401:
//   - если признак есть → openSignin() — показать форму, host знает что у юзера
//     есть аккаунт, и просто помогает ему перелогиниться;
//   - если нет, и пейвол разрешает анон-логин (`allow_anonymous=true` в
//     bootstrap) → signInAnonymously() — headless silent восстановление;
//   - если нет и `allow_anonymous=false` → openSignin(), потому что анон-флоу
//     гарантированно вернёт 403 от бэка, бессмысленно делать silent-попытку.
//
// Признак НЕ очищается на signOut/expiry — это persistent сигнал, иначе при
// каждом разлогине теряли бы знание "у юзера есть реальный аккаунт".

import { PaywallError, QuotaExceededError } from '@sdk/core/types';
import type { PaywallUI } from '@monetize.software/sdk-extension';

const HAD_REAL_AUTH_KEY = '__demo_had_real_auth';

/** Подписаться на authChange и записать persistent-флаг, когда юзер вошёл
 *  не как анонимный. Вызывать один раз после создания PaywallUI.
 *
 *  Срабатывает на любое authChange event (включая INITIAL_SESSION после
 *  reload) — флаг идемпотентен, перезаписать `true` ещё раз ничего не
 *  ломает. Семантически нужен только real signin, но дешевле не
 *  фильтровать, чем плодить дополнительные event'ы здесь. */
export function trackRealAuth(paywall: PaywallUI): void {
  paywall.on('authChange', ({ session: s }) => {
    if (s && !s.user?.is_anonymous) {
      void chrome.storage.local.set({ [HAD_REAL_AUTH_KEY]: true });
    }
  });
}

/** Открыть нужный flow в зависимости от того, был ли у юзера реальный логин
 *  ранее, и разрешает ли пейвол анон-вход. Вызывается из handleGatewayError
 *  или напрямую host'ом. */
export async function recoverFromUnauthorized(paywall: PaywallUI): Promise<void> {
  const stored = (await chrome.storage.local.get(HAD_REAL_AUTH_KEY)) as {
    [k: string]: boolean | undefined;
  };

  // Был реальный логин — показываем форму, без анон-восстановления.
  if (stored[HAD_REAL_AUTH_KEY]) {
    paywall.openSignin();
    return;
  }

  // Анон-fallback только если пейвол его разрешает. allow_anonymous=false →
  // бэк гарантированно вернёт 403, лучше сразу показать форму. Если bootstrap
  // ещё не загружен (race на самом старте) — оптимистично пробуем анон;
  // в худшем случае получим 403 и UI покажет «Forbidden / Try again».
  const allowAnon = paywall.billing.getCachedBootstrap()?.settings.allow_anonymous;
  if (allowAnon === false) {
    paywall.openSignin();
    return;
  }

  // Headless silent anon-signin — без модалки. Promise проглатываем: при
  // ошибке authChange всё равно не выстрелит, и pending-retry не сработает
  // (Bearer останется пустым). UX покажет ту же ошибку Forbidden.
  paywall.signInAnonymously().catch(() => {});
}

// ===== Auto-retry после auth =====
//
// Когда gateway.call падает с 401, мы открываем signin-форму (или делаем
// headless anon-signin), ждём authChange c not-null session и автоматически
// повторяем исходный вызов.
// Это даёт UX «нажал кнопку → залогинился во всплывшем окне → результат
// пришёл», без необходимости юзеру нажимать кнопку второй раз.
//
// Реализация simple-purposed: одна общая очередь pendingRetries, один
// authChange listener на инстанс PaywallUI. Несколько параллельных
// 401-fail'ов retry'ятся одновременно после успешного login'а. Защита от
// бесконечной recursion — retry один раз (если второй 401 — пробрасываем).

const pendingRetries: Array<() => void> = [];
const authListenerInstalled = new WeakSet<PaywallUI>();
const AUTH_WAIT_TIMEOUT_MS = 5 * 60_000;

function ensureAuthListener(paywall: PaywallUI): void {
  if (authListenerInstalled.has(paywall)) return;
  authListenerInstalled.add(paywall);
  paywall.on('authChange', ({ event, session: s }) => {
    // Retry'им только на реальный вход (SIGNED_IN). INITIAL_SESSION после
    // mount'а с уже залогиненной session — это НЕ результат текущего
    // 401-recovery flow'а, retry'ить незачем (если юзер уже залогинен, то
    // 401 не из-за отсутствия аутентификации, а другая ошибка — пусть
    // вернётся caller'у). TOKEN_REFRESHED тоже не triggert: refresh не
    // меняет identity, 401 был не от истекшего токена (тогда бы SDK
    // refresh'нул сам), а от чего-то другого.
    if (event !== 'SIGNED_IN' || !s) return;
    const queued = pendingRetries.splice(0);
    for (const run of queued) run();
  });
}

/** Запустить gateway-call с auto-retry после 401-recovery. Если fn() падает
 *  с PaywallError(status=401), helper:
 *    1. дёргает recoverFromUnauthorized — открывает signin-форму или делает headless anon-signin;
 *    2. ждёт ближайший authChange с not-null session;
 *    3. ретраит fn() один раз.
 *
 *  Второй 401 пробрасывается без рекурсии. Если юзер не залогинился за
 *  AUTH_WAIT_TIMEOUT_MS — отклоняем `auth_timeout`. */
export async function callWithRetry<T>(
  paywall: PaywallUI,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof PaywallError) || e.status !== 401) throw e;

    ensureAuthListener(paywall);
    void recoverFromUnauthorized(paywall);

    await new Promise<void>((resolve, reject) => {
      let run!: () => void;
      const cleanup = (): void => {
        clearTimeout(timer);
        offClose();
        const idx = pendingRetries.indexOf(run);
        if (idx >= 0) pendingRetries.splice(idx, 1);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new PaywallError('auth_timeout', 'User did not authenticate in time'));
      }, AUTH_WAIT_TIMEOUT_MS);
      // Юзер закрыл паывол / auth-gate без логина → отклоняем retry, иначе
      // calling-button висит в loading 5 минут (до timeout). authChange
      // придёт раньше close в success-flow — там cleanup отвяжет close-listener
      // до того, как он сработает.
      const offClose = paywall.on('close', () => {
        cleanup();
        reject(new PaywallError('auth_dismissed', 'User closed auth modal without signing in'));
      });
      run = () => {
        cleanup();
        resolve();
      };
      pendingRetries.push(run);
    });

    return fn();
  }
}

export type GatewayErrorResult =
  | { kind: 'quota' }
  | { kind: 'unauthorized' }
  | { kind: 'error'; message: string };

/** Универсальный разбор ошибок из ApiGatewayClient.call(). Quota уже открыл
 *  paywall через onQuotaExceeded — мы только возвращаем kind для UI-сообщения.
 *  401 запускает recoverFromUnauthorized; UI должен показать «Restoring session».
 *  Всё остальное — error message для card-level отображения. */
export async function handleGatewayError(
  e: unknown,
  paywall: PaywallUI
): Promise<GatewayErrorResult> {
  if (e instanceof QuotaExceededError) {
    return { kind: 'quota' };
  }
  if (e instanceof PaywallError && e.status === 401) {
    await recoverFromUnauthorized(paywall);
    return { kind: 'unauthorized' };
  }
  return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
}
