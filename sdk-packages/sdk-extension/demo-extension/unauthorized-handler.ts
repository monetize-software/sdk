// Demo helper: restoring the session after a 401 from the backend. It shows a
// demonstration pattern for SDK hosts — a real extension will most likely want
// to wrap this in its own UX / state machine.
//
// The idea: we remember in chrome.storage a flag "the user has ever signed in
// with a real identity" (email/OAuth, not anonymous). When the gateway responds
// with 401:
//   - if the flag is set → openSignin() — show the form; the host knows the user
//     has an account and just helps them sign back in;
//   - if not, and the paywall allows anonymous login (`allow_anonymous=true` in
//     bootstrap) → signInAnonymously() — headless silent restore;
//   - if not, and `allow_anonymous=false` → openSignin(), because the anon flow
//     would be guaranteed to return 403 from the backend, so a silent attempt is pointless.
//
// The flag is NOT cleared on signOut/expiry — it's a persistent signal,
// otherwise on every sign-out we'd lose the knowledge "the user has a real account".

import { PaywallError, QuotaExceededError } from '@sdk/core/types';
import type { PaywallUI } from '@monetize.software/sdk-extension';

const HAD_REAL_AUTH_KEY = '__demo_had_real_auth';

/** Subscribe to authChange and write the persistent flag when the user signs in
 *  as non-anonymous. Call once after creating PaywallUI.
 *
 *  Fires on any authChange event (including INITIAL_SESSION after reload) — the
 *  flag is idempotent, so overwriting `true` again breaks nothing. Semantically
 *  only a real signin matters, but it's cheaper not to filter than to multiply
 *  extra events here. */
export function trackRealAuth(paywall: PaywallUI): void {
  paywall.on('authChange', ({ session: s }) => {
    if (s && !s.user?.is_anonymous) {
      void chrome.storage.local.set({ [HAD_REAL_AUTH_KEY]: true });
    }
  });
}

/** Open the appropriate flow depending on whether the user had a real login
 *  earlier and whether the paywall allows anonymous sign-in. Called from
 *  handleGatewayError or directly by the host. */
export async function recoverFromUnauthorized(paywall: PaywallUI): Promise<void> {
  const stored = (await chrome.storage.local.get(HAD_REAL_AUTH_KEY)) as {
    [k: string]: boolean | undefined;
  };

  // There was a real login — show the form, without anon restore.
  if (stored[HAD_REAL_AUTH_KEY]) {
    paywall.openSignin();
    return;
  }

  // Anon fallback only if the paywall allows it. allow_anonymous=false → the
  // backend is guaranteed to return 403, so better to show the form right away.
  // If bootstrap hasn't loaded yet (a race at the very start) — optimistically
  // try anon; worst case we get a 403 and the UI shows "Forbidden / Try again".
  const allowAnon = paywall.billing.getCachedBootstrap()?.settings.allow_anonymous;
  if (allowAnon === false) {
    paywall.openSignin();
    return;
  }

  // Headless silent anon-signin — no modal. We swallow the promise: on error
  // authChange won't fire anyway, and the pending-retry won't trigger (the
  // Bearer stays empty). The UX will show the same Forbidden error.
  paywall.signInAnonymously().catch(() => {});
}

// ===== Auto-retry after auth =====
//
// When gateway.call fails with a 401, we open the signin form (or do a headless
// anon-signin), wait for an authChange with a not-null session and automatically
// retry the original call.
// This gives the UX "pressed a button → signed in in a popup → the result
// arrived", without the user having to press the button a second time.
//
// A simple-purpose implementation: one shared pendingRetries queue, one
// authChange listener per PaywallUI instance. Several parallel 401 failures are
// retried at once after a successful login. Protection against infinite
// recursion — retry once (if a second 401 — rethrow).

const pendingRetries: Array<() => void> = [];
const authListenerInstalled = new WeakSet<PaywallUI>();
const AUTH_WAIT_TIMEOUT_MS = 5 * 60_000;

function ensureAuthListener(paywall: PaywallUI): void {
  if (authListenerInstalled.has(paywall)) return;
  authListenerInstalled.add(paywall);
  paywall.on('authChange', ({ event, session: s }) => {
    // Retry only on a real sign-in (SIGNED_IN). INITIAL_SESSION after a mount
    // with an already-signed-in session is NOT the result of the current
    // 401-recovery flow, so there's no point retrying (if the user is already
    // signed in, the 401 isn't due to missing authentication but some other
    // error — let it return to the caller). TOKEN_REFRESHED doesn't trigger it
    // either: a refresh doesn't change identity, and the 401 wasn't from an
    // expired token (the SDK would have refreshed itself) but from something else.
    if (event !== 'SIGNED_IN' || !s) return;
    const queued = pendingRetries.splice(0);
    for (const run of queued) run();
  });
}

/** Run a gateway call with auto-retry after 401-recovery. If fn() fails with
 *  PaywallError(status=401), the helper:
 *    1. calls recoverFromUnauthorized — opens the signin form or does a headless anon-signin;
 *    2. waits for the next authChange with a not-null session;
 *    3. retries fn() once.
 *
 *  A second 401 is rethrown without recursion. If the user doesn't sign in
 *  within AUTH_WAIT_TIMEOUT_MS — we reject with `auth_timeout`. */
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
      // The user closed the paywall / auth-gate without logging in → we reject
      // the retry, otherwise the calling button hangs in loading for 5 minutes
      // (until timeout). In the success flow authChange arrives before close —
      // there cleanup detaches the close listener before it fires.
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

/** Universal error parsing for ApiGatewayClient.call(). Quota has already opened
 *  the paywall via onQuotaExceeded — we only return the kind for the UI message.
 *  A 401 triggers recoverFromUnauthorized; the UI should show "Restoring session".
 *  Everything else — an error message for card-level display. */
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
