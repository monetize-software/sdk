import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { BillingClient } from '../core/BillingClient';
import type { AuthSession } from '../core/auth';
import { findLiveOffer, readBrowserOfferStart } from '../core/offer';
import type { LayoutBlock, PaywallBootstrap } from '../core/types';
import { PaywallError } from '../core/types';
import { Modal } from './Modal';
import { AuthGate } from './AuthGate';
import { OfferTopBanner, pickActiveOffer } from './renderer/blocks/OfferBanner';
import { SupportGate } from './SupportGate';
import { Renderer } from './renderer/Renderer';
import { I18nProvider, useI18n } from './i18n';

export type PaywallView =
  | 'layout'
  | 'support'
  | 'auth'
  | 'awaiting_payment'
  | 'popup_blocked';

/**
 * Public snapshot of PaywallUI state for the host. Derived from the internal
 * LoadState + GateState + open/purchased flags. Each real change is one onState
 * call; deduplicated (`useSyncExternalStore`-friendly).
 */
export interface PaywallStateSnapshot {
  /** The modal is rendered and visible. False — closed (or never opened yet).
   *  Can be false while `processing=true` — direct-checkout (paywall.checkout)
   *  does bootstrap + createCheckout headless before deciding whether to mount
   *  the modal. */
  open: boolean;
  /** What's shown in the modal. null when `open=false`. */
  view:
    | 'loading'
    | 'error'
    | 'layout'
    | 'auth'
    | 'support'
    | 'awaiting_payment'
    | 'popup_blocked'
    | 'purchased'
    | null;
  /** Filled only when `view === 'error'`. */
  error: PaywallError | null;
  /** The SDK is doing background work for `paywall.checkout(priceId)` —
   *  bootstrap, visibility/trial gates, createCheckout — before the UI modal is
   *  actually needed. During this phase the host can disable its button and
   *  show a spinner right on it, so the user doesn't feel that "the click did
   *  nothing". Reset to false right after mountAndShow (the modal took over the
   *  UI), or after a headless reject (already-paid, createCheckout error
   *  without a modal). For the `paywall.open()` flow it's always false: there
   *  the modal appears instantly with its own LoadingView and a separate
   *  "processing" isn't needed. */
  processing: boolean;
}

export interface PaywallRootProps {
  client: BillingClient;
  open: boolean;
  onClose: () => void;
  onEvent: (event: string, payload?: unknown) => void;
  /** Which view to show when open=true. Defaults to 'layout'.
   *  - 'support' / 'auth' — standalone opens of paywall.openSupport / openSignin.
   *  - 'awaiting_payment' / 'popup_blocked' — direct-checkout (paywall.checkout):
   *    PaywallUI does createCheckout headless, then mounts the modal straight to
   *    the final view (without a loading flash). Requires
   *    `initialCheckoutPriceId` + `initialCheckoutUrl`. */
  initialView?: PaywallView;
  /** AuthPanel mode when `initialView='auth'` — 'signin' (default) or 'signup'.
   *  Set by PaywallUI from openSignup()/openSignin(). */
  initialAuthMode?: 'signin' | 'signup';
  /** Target price for direct-checkout. Used in two modes:
   *  - `initialView='auth'` + priceId → preauth-flow direct-checkout: the modal
   *    starts with the auth-gate, and after signIn auto-resumes into
   *    createCheckout (with the offer-id from cached offers).
   *  - `initialView='awaiting_payment'|'popup_blocked'` → checkout is already
   *    created headless in PaywallUI, and the modal shows the final screen.
   *  Ignored for the other `initialView` values. */
  initialCheckoutPriceId?: string | null;
  /** URL of the provider's hosted checkout. Passed together with
   *  `initialCheckoutPriceId` when initialView='awaiting_payment' or
   *  'popup_blocked' — used for retry/reopen buttons without re-entering
   *  createCheckout. */
  initialCheckoutUrl?: string | null;
  /** Server-confirmed purchase — show the success view with a Continue button.
   *  Controlled from the outside (PaywallUI sets true from watcher.onActive),
   *  reset on open()/close(). Overrides any other view. */
  purchased?: boolean;
  /** Renewal/upgrade flow. true — skip all has_active_subscription pre-checks
   *  (bootstrap-time + post-auth), and on checkout pass
   *  `ignoreActivePurchase: true` to the backend so /start-checkout doesn't
   *  return a 409 for an already-subscribed user. See OpenOptions.renew. */
  renew?: boolean;
  /** Public state-machine notify. PaywallUI passes a callback here that caches
   *  the snapshot and emits its own `onStateChange`. If not passed —
   *  state-tracking is disabled (no overhead for hosts that don't need it). */
  onState?: (snapshot: PaywallStateSnapshot) => void;
  /** Inline mode (admin panel editor's live-preview): passed to Modal so the
   *  overlay is absolute-inside-host instead of fixed-viewport, and doesn't
   *  lock body-scroll. Defaults to false. */
  inline?: boolean;
  /** Explicit language override for I18nProvider. Used by the admin panel
   *  editor's live-preview — there the browser-locale is always EN, but we need
   *  to show it as for a user from the chosen country. See
   *  I18nProviderProps.forceLocale. */
  locale?: string | null;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: PaywallBootstrap }
  | { status: 'error'; error: PaywallError };

type GateState =
  | { kind: 'layout' }
  // pendingCheckout=undefined, origin='layout' — the gate is opened via "Restore
  // purchases" (without a subsequent checkout); after signIn we collapse into
  // layout. With pendingCheckout — the gate is opened by the preauth-flow from
  // cta_button and after signIn auto-resumes createCheckout. origin='standalone'
  // — paywall.openAuth(): the modal is open only for login, and after signIn /
  // Back we close the modal and don't show the layout at all. direct=true —
  // pendingCheckout came from paywall.checkout(priceId): on error/already-paid
  // we close the modal instead of setGate('layout'), because the layout with
  // plans must never flash in this flow.
  | {
      kind: 'auth_gate';
      pendingCheckout?: { priceId: string; direct?: boolean };
      origin?: 'layout' | 'standalone';
      /** The opening context — controls the gate's heading
       *  ("Restore Purchases" vs "Welcome back!"). Default — 'preauth'. */
      intent?: 'restore' | 'preauth' | 'standalone';
    }
  // origin='layout' — came from the current_session block, Back returns to layout.
  // origin='standalone' — the modal is open only for support (paywall.openSupport()),
  // Back closes the modal.
  | { kind: 'support'; origin: 'layout' | 'standalone' }
  // window.open returned a handle — the checkout opened in a new tab. The
  // paywall stays as an indicator: "pay in that tab". We keep priceId so the
  // retry button can recreate the checkout (Stripe/Paddle URLs expire). We keep
  // url so the fallback link "Didn't open? Click here" reopens the same URL
  // without another trip to createCheckout — needed for the case where
  // window.open returned a handle but the tab is actually blocked (aggressive
  // mobile blockers).
  | { kind: 'awaiting_payment'; priceId: string; url: string }
  // window.open returned null — the popup is blocked (happens after an async
  // post-auth resume, when the transient activation has expired). We do NOT
  // redirect the current tab: the paywall must stay. The URL is already issued —
  // the "Open checkout" button will call window.open under a fresh gesture,
  // without a second trip to createCheckout.
  | { kind: 'popup_blocked'; priceId: string; url: string }
  // The user is already signed in and has_active_subscription — we show the
  // success-view. Triggered either after auth-resume (we poll getUser right
  // after signIn), or when /start-checkout returned 409 hasActivePurchase.
  // restored=true changes the PurchaseSuccessView text to "Subscription restored".
  | { kind: 'purchase_success'; restored: boolean }
  // After signIn we wait for getUser({force:true}) until we know whether there's
  // already an active subscription. Without this intermediate state the user
  // sees the auth_gate's "gray screen" for a few seconds with the form already
  // hidden.
  | { kind: 'verifying' };

type AuthPanelBlock = Extract<LayoutBlock, { type: 'auth_panel' }>;

function computePaywallSnapshot(
  open: boolean,
  state: LoadState,
  gate: GateState,
  purchased: boolean | undefined
): PaywallStateSnapshot {
  // `processing` is controlled by PaywallUI (direct-checkout headless prep) and
  // merged into the snapshot before pushing to applyState. Here we always set
  // it false — once the modal is actually mounted, the host has nothing to
  // "wait" for beyond the gate views.
  if (!open) return { open: false, view: null, error: null, processing: false };
  if (purchased)
    return { open: true, view: 'purchased', error: null, processing: false };
  if (state.status === 'idle' || state.status === 'loading') {
    return { open: true, view: 'loading', error: null, processing: false };
  }
  if (state.status === 'error') {
    return { open: true, view: 'error', error: state.error, processing: false };
  }
  if (gate.kind === 'support')
    return { open: true, view: 'support', error: null, processing: false };
  if (gate.kind === 'auth_gate')
    return { open: true, view: 'auth', error: null, processing: false };
  if (gate.kind === 'awaiting_payment') {
    return { open: true, view: 'awaiting_payment', error: null, processing: false };
  }
  if (gate.kind === 'popup_blocked') {
    return { open: true, view: 'popup_blocked', error: null, processing: false };
  }
  if (gate.kind === 'purchase_success') {
    return { open: true, view: 'purchased', error: null, processing: false };
  }
  if (gate.kind === 'verifying') {
    return { open: true, view: 'loading', error: null, processing: false };
  }
  return { open: true, view: 'layout', error: null, processing: false };
}

function sameSnapshot(a: PaywallStateSnapshot, b: PaywallStateSnapshot): boolean {
  return (
    a.open === b.open &&
    a.view === b.view &&
    a.error === b.error &&
    a.processing === b.processing
  );
}

export function PaywallRoot({
  client,
  open,
  onClose,
  onEvent,
  initialView,
  initialAuthMode,
  initialCheckoutPriceId,
  initialCheckoutUrl,
  purchased,
  renew,
  onState,
  inline,
  locale
}: PaywallRootProps) {
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  // We keep session in state so blocks (auth_panel) re-render on login/logout.
  // Without this AuthPanel would read the snapshot once and wouldn't collapse
  // after a successful signin.
  const [authSession, setAuthSession] = useState<AuthSession | null>(
    () => client.auth?.getCachedSession() ?? null
  );
  const [gate, setGate] = useState<GateState>(() => {
    if (initialView === 'support') return { kind: 'support', origin: 'standalone' };
    if (initialView === 'auth') {
      // initialCheckoutPriceId is set → preauth direct-checkout: after signin
      // the auth-resume effect assembles createCheckout for this price and
      // switches to awaiting_payment/popup_blocked. On back/error we must not
      // fall into layout (the host draws the plans itself) — closes-on-back via
      // origin='standalone' fits semantically.
      if (initialCheckoutPriceId) {
        return {
          kind: 'auth_gate',
          pendingCheckout: { priceId: initialCheckoutPriceId, direct: true },
          origin: 'standalone',
          intent: 'preauth'
        };
      }
      return { kind: 'auth_gate', origin: 'standalone' };
    }
    if (initialView === 'awaiting_payment' && initialCheckoutPriceId && initialCheckoutUrl) {
      return {
        kind: 'awaiting_payment',
        priceId: initialCheckoutPriceId,
        url: initialCheckoutUrl
      };
    }
    if (initialView === 'popup_blocked' && initialCheckoutPriceId && initialCheckoutUrl) {
      return {
        kind: 'popup_blocked',
        priceId: initialCheckoutPriceId,
        url: initialCheckoutUrl
      };
    }
    return { kind: 'layout' };
  });
  // A stable flag "the current modal session is direct-checkout". Taken from
  // initialView at the mount/reset stage and held until close: on
  // error/already-paid we don't fall into the layout with plans, but close the
  // modal and emit an event.
  const isDirectCheckout =
    initialView === 'awaiting_payment' ||
    initialView === 'popup_blocked' ||
    (initialView === 'auth' && !!initialCheckoutPriceId);
  // Protection against double auto-resume: the useEffect below depends on
  // authSession, and the onAuthChange subscription may deliver the same session
  // again (refresh) — without the flag we'd call createCheckout twice.
  const resumingRef = useRef(false);

  // State-machine bridge: we emit a snapshot when any of (open, state, gate,
  // purchased) changes. sameSnapshot suppresses no-ops — e.g. a loading→error
  // transition changes state.status, but if we're already in the error view
  // (otherwise impossible), the emit won't repeat.
  const lastSnapshotRef = useRef<PaywallStateSnapshot | null>(null);
  useEffect(() => {
    if (!onState) return;
    const next = computePaywallSnapshot(open, state, gate, purchased);
    const prev = lastSnapshotRef.current;
    if (prev && sameSnapshot(prev, next)) return;
    lastSnapshotRef.current = next;
    onState(next);
  }, [open, state, gate, purchased, onState]);

  useEffect(() => {
    if (!client.auth) return;
    return client.auth.onAuthChange((_event, s) => setAuthSession(s));
  }, [client.auth]);

  // Live bootstrap update: BillingClient.setBootstrap (preview-mode in the admin
  // panel editor) or cross-tab storage.watch emit onBootstrapChange. We
  // re-render the modal only if it's already in the ready phase — otherwise the
  // bootstrap-effect below picks up the fresh cached one on open() itself.
  // Guard: tests pass a stub client without onBootstrapChange — skip silently.
  useEffect(() => {
    if (typeof client.onBootstrapChange !== 'function') return;
    return client.onBootstrapChange((data) => {
      setState((prev) =>
        prev.status === 'ready' ? { status: 'ready', data } : prev
      );
    });
  }, [client]);

  useEffect(() => {
    if (!open) return;
    if (state.status === 'ready' || state.status === 'loading') return;

    let cancelled = false;
    setState({ status: 'loading' });
    client
      .bootstrap()
      .then((data) => {
        if (cancelled) return;
        setState({ status: 'ready', data });
        onEvent('ready', data);
        // The user is already subscribed — the host called open() blindly
        // (without a getAccess pre-check), or simply from an "Open paywall"
        // popup. We don't show the plans — we switch to the restored
        // success-view. We emit purchase_completed so the host gets a consistent
        // signal, as from any other path (UserWatcher, 409 in checkout,
        // auth-resume). renew=true skips this check — the host explicitly shows
        // "Renew"/"Upgrade" and the plans should be visible.
        //
        // standalone flows (openSupport/openAuth/openSignup) skip this block:
        // the host explicitly opened the support/auth form, and overwriting the
        // gate with restored success would violate the intent. Direct-checkout
        // (paywall.checkout) is also skipped: PaywallUI already did a pre-check
        // via fresh getUser before mounting and emitted purchase_completed{restored}
        // headless if needed. If the modal is mounted anyway (awaiting_payment
        // with the URL already in hand, or a preauth auth-gate), then the user
        // is really in the middle of paying — re-emitting "restored" and
        // disrupting the UI isn't warranted.
        const skipActiveSubOverride =
          initialView === 'support' || initialView === 'auth' || isDirectCheckout;
        if (data.user?.has_active_subscription && !renew && !skipActiveSubOverride) {
          onEvent('purchase_completed', {
            priceId: initialCheckoutPriceId ?? null,
            sessionId: null,
            restored: true
          });
          setGate({ kind: 'purchase_success', restored: true });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const err =
          error instanceof PaywallError
            ? error
            : new PaywallError('unknown', 'Failed to load paywall', { cause: error });
        setState({ status: 'error', error: err });
        onEvent('error', err);
      });
    return () => {
      cancelled = true;
    };
  }, [open, client]);

  // Closing/reopening the modal resets the gate. PaywallUI invokes standalone
  // flows (openSupport / openAuth) on an already-mounted component via
  // handle.update({initialView: 'support'|'auth'}) — the useState initializer
  // runs only on the first mount, so without this effect the gate would stay
  // 'layout' (with plans) on subsequent standalone opens.
  //
  // useLayoutEffect (not useEffect): after close the gate goes to 'layout', and
  // on the next openAuth/openSupport a regular useEffect would run AFTER paint,
  // so the user would see the plans instead of the auth form for one frame
  // (especially noticeable in the extension popup, where RemoteAuth+RemoteBilling
  // add transport RTTs and the main thread yields more often between renders).
  // useLayoutEffect syncs the gate BEFORE paint — no flicker.
  useLayoutEffect(() => {
    if (!open) {
      setGate({ kind: 'layout' });
      resumingRef.current = false;
      return;
    }
    if (initialView === 'support') {
      setGate({ kind: 'support', origin: 'standalone' });
    } else if (initialView === 'auth') {
      if (initialCheckoutPriceId) {
        setGate({
          kind: 'auth_gate',
          pendingCheckout: { priceId: initialCheckoutPriceId, direct: true },
          origin: 'standalone',
          intent: 'preauth'
        });
      } else {
        setGate({ kind: 'auth_gate', origin: 'standalone' });
      }
    } else if (
      initialView === 'awaiting_payment' &&
      initialCheckoutPriceId &&
      initialCheckoutUrl
    ) {
      setGate({
        kind: 'awaiting_payment',
        priceId: initialCheckoutPriceId,
        url: initialCheckoutUrl
      });
    } else if (
      initialView === 'popup_blocked' &&
      initialCheckoutPriceId &&
      initialCheckoutUrl
    ) {
      setGate({
        kind: 'popup_blocked',
        priceId: initialCheckoutPriceId,
        url: initialCheckoutUrl
      });
    }
  }, [open, initialView, initialCheckoutPriceId, initialCheckoutUrl]);

  const runCheckout = async (priceId: string) => {
    try {
      // Resolve the active offer from cached offers. Without this, duration
      // offers (whose countdown ticks in clientStorage) won't apply at checkout
      // — the server can't validate them and needs an explicit offerId. We pass
      // end_date offers too — the backend re-checks applicability and discards
      // foreign ones. findLiveOffer (not raw findApplicableOffer) — so we do NOT
      // send the offerId of an expired duration offer: there's no server-side
      // timer for them, and the backend would accept the id and grant a discount
      // that's no longer visible in the UI.
      const cachedOffers = client.getCachedOffers?.() ?? null;
      const applicableOffer = cachedOffers
        ? findLiveOffer(cachedOffers, priceId, { readStart: readBrowserOfferStart })
        : null;
      const result = await client.createCheckout({
        priceId,
        offerId: applicableOffer?.id,
        ignoreActivePurchase: renew === true
      });
      onEvent('checkout_started', { priceId, url: result.url, acquiring: result.acquiring });
      if (typeof window === 'undefined' || !result.url) return;
      // Without `noopener,noreferrer` in the features: these flags make
      // window.open ALWAYS return null (even when the popup actually opened),
      // and we couldn't tell "success" from "blocked". We sever manually via
      // popup.opener=null after success — on the checkout domain (Stripe/Paddle)
      // opener access is cross-origin-restricted anyway, but an explicit null is
      // safer.
      const popup = window.open(result.url, '_blank');
      if (popup) {
        try {
          popup.opener = null;
        } catch {
          /* cross-origin already — ok */
        }
        setGate({ kind: 'awaiting_payment', priceId, url: result.url });
      } else {
        // The popup is blocked — usually due to a stale transient activation
        // (auto-resume after async signin). We do NOT take the user away via
        // location.assign: the paywall must stay open. We show inline retry; a
        // click on the button is a fresh gesture and the popup will open.
        setGate({ kind: 'popup_blocked', priceId, url: result.url });
      }
    } catch (error) {
      // A 409 hasActivePurchase from the backend isn't a checkout error, it's
      // "the user already has an active subscription". We refresh the cache
      // (the host's userChange should see has_active_subscription=true) and emit
      // purchase_completed with restored=true. For the layout flow we switch to
      // the success-view; for direct-checkout (paywall.checkout) — a headless
      // reject: we close the modal and the host decides how to tell the user.
      if (error instanceof PaywallError && error.code === 'already_purchased') {
        try {
          await client.getUser({ force: true });
        } catch {
          /* offline / 401 — getUser will report to the host itself; here it doesn't block the success-view */
        }
        onEvent('purchase_completed', { priceId, sessionId: null, restored: true });
        if (isDirectCheckout) {
          onClose();
        } else {
          setGate({ kind: 'purchase_success', restored: true });
        }
        return;
      }
      const err =
        error instanceof PaywallError
          ? error
          : new PaywallError('checkout_failed', 'Checkout failed', { cause: error });
      onEvent('error', err);
      // Layout flow: return the user to layout — otherwise we'd get stuck in
      // auth_gate (if we came via the preauth flow) with an already-signed-in
      // session. Direct-checkout: the layout with plans must never flash — we
      // close the modal, and the host gets an error event and decides how to
      // react.
      if (isDirectCheckout) {
        onClose();
      } else {
        setGate({ kind: 'layout' });
      }
    }
  };

  const reopenCheckout = (priceId: string, url: string) => {
    if (typeof window === 'undefined') return;
    const popup = window.open(url, '_blank');
    if (popup) {
      try {
        popup.opener = null;
      } catch {
        /* ignore */
      }
      setGate({ kind: 'awaiting_payment', priceId, url });
    }
    // If it's still null — we leave popup_blocked, the user will click again.
  };

  // Auto-resume: a session appeared in the open gate → we continue the flow.
  // Pending preauth-checkout — we do NOT collapse the gate into layout before
  // runCheckout: otherwise the user sees the plans flicker between submitting
  // the auth form and opening the checkout tab. runCheckout itself moves the
  // gate to awaiting_payment / popup_blocked / layout (on error). Restore-flow
  // without pendingCheckout — we just return to layout. resumingRef protects
  // against a repeat run if authChange fires several times within one gate
  // cycle (refresh).
  useEffect(() => {
    if (gate.kind !== 'auth_gate') return;
    // An anonymous session doesn't count as login: the user came to auth_gate
    // to really sign in. Otherwise openAuth() with an existing anon token would
    // instantly close the modal via auto-resume, and the user wouldn't see the
    // form.
    if (!authSession || authSession.user.is_anonymous) return;
    if (resumingRef.current) return;
    resumingRef.current = true;
    const pending = gate.pendingCheckout;
    const origin = gate.origin;
    // We switch to verifying right away — otherwise the modal hangs in
    // auth_gate with an already-signed-in user (~3s while getUser goes to the
    // backend), and the user sees an "empty gray screen" instead of progress.
    // The loader more honestly shows that the SDK is doing something.
    setGate({ kind: 'verifying' });
    void (async () => {
      // Before continuing the flow (runCheckout / return to layout / close the
      // modal), we check — maybe the user already has an active subscription.
      // Scenarios: the Restore button (they already paid from another account);
      // preauth signIn (the user remembered they have a subscription);
      // standalone openAuth; direct-checkout with a preauth gate.
      // Without this check the user would see the plans, click Buy → 409 from
      // the backend → fallback to already_purchased. Better not to make them go
      // through that step. renew=true skips the check — the host is explicitly
      // doing a renewal flow.
      if (!renew) {
        try {
          const user = await client.getUser({ force: true });
          if (user.has_active_subscription) {
            onEvent('purchase_completed', {
              priceId: pending?.priceId ?? null,
              sessionId: null,
              restored: true
            });
            // Direct-checkout preauth-resume: we don't show the plans, nor the
            // restored view (headless reject) — we close the modal. The host
            // gets purchase_completed{restored:true} and decides how to tell
            // the user.
            if (pending?.direct) {
              onClose();
            } else {
              setGate({ kind: 'purchase_success', restored: true });
            }
            return;
          }
        } catch {
          /* getUser failed — we continue the normal flow, the user will see the plans */
        }
      }
      if (!pending) {
        // openAuth standalone: after signIn we close the modal and don't show
        // the layout. Restore-flow (origin='layout' or undefined): we return to
        // layout.
        if (origin === 'standalone') {
          onClose();
        } else {
          setGate({ kind: 'layout' });
        }
        return;
      }
      await runCheckout(pending.priceId);
    })().finally(() => {
      resumingRef.current = false;
    });
  }, [authSession, gate]);

  const handleAction = async (action: string, payload?: unknown) => {
    if (action === 'close') {
      onClose();
      return;
    }
    if (action === 'price_selected') {
      // Pass it through as-is — the block already assembled { priceId, price }.
      onEvent('price_selected', payload);
      return;
    }
    if (action === 'restore') {
      // CurrentSession block: a guest clicked "Restore purchases". We open the
      // gate with intent='restore' — the heading and submit become "Restore
      // Purchases". Without an AuthClient we do nothing (managed-auth not
      // connected). An anonymous session doesn't count as login (see the
      // CurrentSession block): it exists only for the api-gateway token, the
      // user has no email and needs a real signin to link a past purchase.
      // Without this check the Restore button would silently no-op as soon as
      // the user got an anon token (which in extensions is almost always).
      if (!client.auth) return;
      const session = client.auth.getCachedSession();
      if (session && !session.user.is_anonymous) return;
      setGate({ kind: 'auth_gate', intent: 'restore' });
      return;
    }
    if (action === 'support') {
      // CurrentSession block: open the support form. Visible to both guests and
      // signed-in users. From layout — Back returns to the plans.
      setGate({ kind: 'support', origin: 'layout' });
      return;
    }
    if (action === 'checkout' && state.status === 'ready') {
      const priceId = (payload as { priceId?: string } | undefined)?.priceId;
      if (!priceId) {
        onEvent('error', new PaywallError('no_price', 'No price selected'));
        return;
      }
      const mode = state.data.settings.checkout_mode ?? 'guest';
      // An anonymous session doesn't satisfy the preauth requirement: a
      // checkout under an anon token would create a subscription on an
      // account without an email that the user can't restore later. Anon counts
      // as "not logged in", a real signin is required.
      const cachedSession = client.auth?.getCachedSession() ?? null;
      const hasRealSession = !!cachedSession && !cachedSession.user.is_anonymous;
      const needsAuth = mode === 'preauth' && !!client.auth && !hasRealSession;
      if (needsAuth) {
        setGate({ kind: 'auth_gate', pendingCheckout: { priceId } });
        return;
      }
      await runCheckout(priceId);
    }
  };

  const brand = state.status === 'ready' ? state.data.settings.brand_color : null;
  // allow_close=undefined is treated as true (the default before bootstrap —
  // the paywall must be closable during loading/error, otherwise the user gets
  // trapped). After ready, settings.allow_close=false forbids
  // ESC/overlay/X-button.
  const allowClose =
    state.status === 'ready' ? state.data.settings.allow_close !== false : true;

  // Offer top-tab: only on the main layout view (prices/features). On the
  // auth/support screens the banner makes no sense — the user is already
  // outside the "buy now" flow, and the urgency timer only distracts. Mirrors
  // the legacy PaywallModal, where the offer-banner was tied to route='paywall'.
  const isLayoutView =
    gate.kind === 'layout' && state.status === 'ready';
  const activeOffer = isLayoutView ? pickActiveOffer(state.data.offers) : null;
  const topBanner = activeOffer ? <OfferTopBanner offer={activeOffer} /> : null;

  const gateBlock: AuthPanelBlock = {
    type: 'auth_panel',
    // We don't set the heading — AuthGate decides by intent (restore →
    // "Restore Purchases", the rest → the default "Welcome back!").
    allow_signup: true,
    allow_password_reset: true,
    // We don't hide it when a session is present — the auto-resume useEffect
    // runs faster than we'd want to show "Signed in as ..." as an intermediate
    // screen.
    hide_when_authenticated: false,
    providers: state.status === 'ready' ? state.data.settings.auth_providers : undefined
  };

  // The support-view takes priority over bootstrap-state: a standalone open
  // (paywall.openSupport()) must work even if bootstrap is still loading or
  // failed — the form itself doesn't depend on settings/prices. From layout
  // mode Back returns to the plans, from standalone — it closes the modal.
  const supportView =
    gate.kind === 'support' ? (
      <SupportGate
        client={client}
        authSession={authSession}
        origin={gate.origin}
        onBack={() => {
          if (gate.origin === 'standalone') onClose();
          else setGate({ kind: 'layout' });
        }}
      />
    ) : null;

  // In gate-views AuthGate/SupportGate draw their own curved Back button in the
  // top-right corner. The Modal's X button is there too — the two buttons would
  // overlap. ESC/overlay-click stay working (if allowClose=true). Standalone
  // openAuth() — AuthGate doesn't draw Back (the modal is open only for signin,
  // there's no layout to return to); then the X button is needed, otherwise the
  // user has nowhere to go but ESC.
  const hideCloseButton =
    (gate.kind === 'auth_gate' && gate.origin !== 'standalone') ||
    gate.kind === 'support';

  const bootstrapForI18n = state.status === 'ready' ? state.data : null;

  return (
    <I18nProvider bootstrap={bootstrapForI18n} forceLocale={locale}>
    <Modal
      open={open}
      onClose={onClose}
      brandColor={brand}
      topBanner={topBanner}
      allowClose={allowClose}
      hideCloseButton={hideCloseButton}
      inline={inline}
      labelledBy="pw-title"
    >
      {/* `Scroll` wraps the self-contained status views (success / loading /
          error / awaiting-payment / popup-blocked) in a flex-1 scroll zone, so
          tall content (small viewports, extension popups capped at ~600px, the
          awaiting-payment screen with its help blocks) scrolls instead of being
          clipped by the dialog's overflow-hidden. min-h-0 lets the flex child
          shrink below its content height so overflow-y-auto actually engages.
          The Renderer / AuthGate / SupportGate views are NOT wrapped — they
          manage their own flex-1 scroll area + pinned footer, and a second
          scroll wrapper would break that footer pinning. */}
      {purchased ? (
        <Scroll>
          <PurchaseSuccessView onContinue={onClose} />
        </Scroll>
      ) : gate.kind === 'purchase_success' ? (
        <Scroll>
          <PurchaseSuccessView restored={gate.restored} onContinue={onClose} />
        </Scroll>
      ) : supportView ? (
        supportView
      ) : state.status === 'loading' || state.status === 'idle' || gate.kind === 'verifying' ? (
        <Scroll>
          <LoadingView verifying={gate.kind === 'verifying'} />
        </Scroll>
      ) : state.status === 'error' ? (
        <Scroll>
          <ErrorView message={state.error.message} />
        </Scroll>
      ) : gate.kind === 'auth_gate' && client.auth ? (
        <AuthGate
          block={gateBlock}
          bootstrap={state.data}
          auth={client.auth}
          authSession={authSession}
          // standalone (paywall.openAuth()) — the modal is open only for
          // signin, the Back button duplicates ESC/X. Hide it. For
          // preauth/restore flow Back leads back to layout — keep it.
          showBack={gate.origin !== 'standalone'}
          intent={gate.intent ?? (gate.origin === 'standalone' ? 'standalone' : 'preauth')}
          initialMode={gate.origin === 'standalone' ? initialAuthMode : undefined}
          onBack={() => {
            if (gate.origin === 'standalone') onClose();
            else setGate({ kind: 'layout' });
          }}
        />
      ) : gate.kind === 'awaiting_payment' ? (
        <Scroll>
          <AwaitingPaymentView
            client={client}
            onBack={() => setGate({ kind: 'layout' })}
            onReopen={() => {
              if (typeof window === 'undefined') return;
              const popup = window.open(gate.url, '_blank');
              if (popup) {
                try {
                  popup.opener = null;
                } catch {
                  /* ignore */
                }
              }
            }}
            onRetry={() => runCheckout(gate.priceId)}
          />
        </Scroll>
      ) : gate.kind === 'popup_blocked' ? (
        <Scroll>
          <PopupBlockedView onReopen={() => reopenCheckout(gate.priceId, gate.url)} />
        </Scroll>
      ) : (
        <Renderer
          layout={state.data.layout!}
          bootstrap={state.data}
          onAction={handleAction}
          auth={client.auth}
          authSession={authSession}
        />
      )}
    </Modal>
    </I18nProvider>
  );
}

// Scroll zone for the self-contained status views. Mirrors the Renderer's
// scrollable region (`flex-1 min-h-0 overflow-y-auto`) so content taller than
// the dialog's capped height (small viewports, ~600px extension popups) becomes
// scrollable instead of clipped by the dialog's overflow-hidden. flex-col so a
// child view's own flex layout (centering, gaps) keeps working.
function Scroll({ children }: { children: ComponentChildren }) {
  return <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>;
}

function LoadingView({ verifying }: { verifying: boolean }) {
  const { t } = useI18n();
  return (
    <div class="flex flex-col items-center justify-center gap-3 py-12">
      <span class="inline-block h-7 w-7 animate-spin rounded-full border-[2.5px] border-gray-200 border-t-[var(--pw-accent)]" />
      <span class="text-xs font-medium tracking-wide text-gray-500">
        {verifying
          ? t('modal.verifying_subscription', 'Checking your subscription…')
          : t('modal.loading', 'Loading…')}
      </span>
    </div>
  );
}

function ErrorView({ message }: { message: string }) {
  const { t } = useI18n();
  return (
    <div class="flex flex-col items-center gap-2 py-8 text-center">
      <div class="flex h-11 w-11 items-center justify-center rounded-full bg-red-50">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M10 6v5M10 14h.01" stroke="#dc2626" stroke-width="2" stroke-linecap="round" />
          <circle cx="10" cy="10" r="8" stroke="#dc2626" stroke-width="1.75" />
        </svg>
      </div>
      <p class="text-sm font-semibold tracking-tight text-gray-900">
        {t('modal.error_generic', 'Something went wrong')}
      </p>
      <p class="text-xs leading-relaxed text-gray-500">{message}</p>
    </div>
  );
}

function PopupBlockedView({ onReopen }: { onReopen: () => void }) {
  const { t } = useI18n();
  return (
    <div class="flex flex-col items-center gap-3 py-8 text-center">
      {/* External-link / open-in-new-window: a window with an arrow going
       *  up-and-right — the standard "open in a new tab" icon. Previously there
       *  was a check-in-box, which read as "checked/done" and didn't convey the
       *  meaning "you need to allow the popup". */}
      <div
        class="flex h-14 w-14 items-center justify-center rounded-full"
        style={{ background: 'color-mix(in srgb, var(--pw-accent) 12%, white)', color: 'var(--pw-accent)' }}
        aria-hidden="true"
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
          <path
            d="M14 4h6v6"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M20 4l-9 9"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>
      <p
        id="pw-title"
        class="mt-1 text-lg font-semibold tracking-tight text-gray-900"
      >
        {t('payment.popup_blocked_title', 'Allow popups to continue')}
      </p>
      <p class="max-w-[20rem] text-sm leading-relaxed text-gray-500">
        {t('payment.popup_blocked_message', 'Your browser blocked the checkout tab. Click below to open it.')}
      </p>
      <button
        type="button"
        onClick={onReopen}
        class="mt-3 rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition-all hover:-translate-y-px hover:brightness-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
        style={{
          background:
            'linear-gradient(180deg, color-mix(in srgb, var(--pw-accent) 92%, white), var(--pw-accent))',
          boxShadow:
            '0 1px 2px rgba(15,23,42,0.08), 0 8px 20px -6px color-mix(in srgb, var(--pw-accent) 50%, transparent)'
        }}
      >
        {t('payment.open_checkout_button', 'Open checkout')}
      </button>
    </div>
  );
}

// Waiting screen after window.open(checkoutUrl). UserWatcher in PaywallUI
// already polls user-state every 5s (visible tab) — this screen is just a UI
// wrapper.
//
// "I've paid" — for the impatient: we force getUser({force:true}) so the cache
// updates right away, and post a 'paywall_purchase' message into the window —
// that's what UserWatcher.handleMessage waits for and it immediately triggers
// its check(). If the subscription isn't active yet (the webhook hasn't
// arrived), we show an inline timeout for 5s.
//
// "Open checkout again" — a fallback for the case "window.open returned a handle
// but the tab is blocked" (aggressive mobile blockers). It uses the existing
// URL without a trip to createCheckout, without disrupting the awaiting_payment
// state.
//
// "Tab closed? Try again" — the edge case: a Stripe/Paddle/etc. URL may expire,
// so we recreate the checkout. A less prominent button.
function AwaitingPaymentView({
  client,
  onBack,
  onReopen,
  onRetry
}: {
  client: BillingClient;
  onBack: () => void;
  onReopen: () => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const [checking, setChecking] = useState(false);
  const [stillPending, setStillPending] = useState(false);
  const stillPendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (stillPendingTimerRef.current !== null) {
        clearTimeout(stillPendingTimerRef.current);
      }
    };
  }, []);

  const handleVerify = async () => {
    if (checking) return;
    setChecking(true);
    setStillPending(false);
    try {
      const user = await client.getUser({ force: true });
      if (user.has_active_subscription) {
        // Wakes UserWatcher — it immediately runs check(), sees the fresh
        // active user from cache and emits purchase_completed (PaywallUI
        // switches to PurchaseSuccessView). We don't emit purchase_completed
        // directly from here — the single source of truth stays in
        // watcher.onActive.
        if (typeof window !== 'undefined') {
          window.postMessage({ type: 'paywall_purchase' }, '*');
        }
        return;
      }
      // The webhook hasn't arrived yet — we show a hint and collapse it after
      // 5s so the user can press again. The setTimeout is cancelled on unmount.
      setStillPending(true);
      if (stillPendingTimerRef.current !== null) {
        clearTimeout(stillPendingTimerRef.current);
      }
      stillPendingTimerRef.current = setTimeout(() => {
        setStillPending(false);
        stillPendingTimerRef.current = null;
      }, 5000);
    } catch {
      setStillPending(true);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div class="flex flex-col gap-3 px-6 pb-6 pt-4 sm:px-8 sm:pb-8 sm:pt-5">
      <button
        type="button"
        onClick={onBack}
        class="-ml-1 self-start rounded-md px-1.5 py-0.5 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
      >
        {t('nav.back', '← Back')}
      </button>
      <div class="flex flex-col items-center gap-3 py-6 text-center">
        {/* Icon: a spinner inside a ping-halo. An h-14 container — so it
         *  matches the success-view in size and reads as a "primary status
         *  indicator" rather than a small inline spinner. */}
        <div class="relative flex h-14 w-14 items-center justify-center">
          <span
            class="absolute inset-0 animate-ping rounded-full opacity-40"
            style={{ background: 'color-mix(in srgb, var(--pw-accent) 30%, transparent)' }}
            aria-hidden="true"
          />
          <span class="relative inline-block h-8 w-8 animate-spin rounded-full border-[2.5px] border-gray-200 border-t-[var(--pw-accent)]" />
        </div>
        <p
          id="pw-title"
          class="mt-1 text-lg font-semibold tracking-tight text-gray-900"
        >
          {t('payment.awaiting_title', 'Complete payment in the new tab')}
        </p>
        <p class="max-w-[22rem] text-sm leading-relaxed text-gray-500">
          {t(
            'payment.awaiting_subtitle',
            "We'll detect your payment automatically — or click below once you're done."
          )}
        </p>
        <button
          type="button"
          onClick={handleVerify}
          disabled={checking}
          class="mt-3 rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition-all hover:-translate-y-px hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:brightness-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
          style={{
            background:
              'linear-gradient(180deg, color-mix(in srgb, var(--pw-accent) 92%, white), var(--pw-accent))',
            boxShadow:
              '0 1px 2px rgba(15,23,42,0.08), 0 8px 20px -6px color-mix(in srgb, var(--pw-accent) 50%, transparent)'
          }}
        >
          {checking ? t('payment.checking', 'Checking…') : t('payment.ive_paid', "I've paid")}
        </button>
        {stillPending ? (
          <p class="text-xs leading-relaxed text-gray-500">
            {t('payment.still_processing', 'Payment is still being processed. Please try again in a moment.')}
          </p>
        ) : null}
      </div>
      <div class="rounded-2xl border border-gray-200 bg-gray-50/60 p-3.5">
        <p class="text-xs leading-relaxed text-gray-600">
          {t('payment.popup_help_text', "Checkout window didn't open or got blocked? Click here to open it again.")}
        </p>
        <button
          type="button"
          onClick={onReopen}
          class="mt-2.5 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
        >
          {t('payment.open_checkout_again', 'Open checkout again')}
        </button>
      </div>
      <button
        type="button"
        onClick={onRetry}
        class="self-center rounded-md px-2 py-1 text-xs text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
      >
        {t('payment.tab_closed_retry', 'Tab closed? Try again')}
      </button>
    </div>
  );
}

function PurchaseSuccessView({
  onContinue,
  restored = false
}: {
  onContinue: () => void;
  /** true — the user already had an active subscription at the moment of the
   *  checkout attempt (or it turned out after signIn that a subscription
   *  exists). Changes the heading to "Subscription restored" — without this the
   *  user thinks they just paid. */
  restored?: boolean;
}) {
  const { t } = useI18n();
  // Typography/CTA — mirrors the canonical `reset_sent` success-view
  // (AuthPanel): h-14 icon, text-3xl bold heading, text-base gray-600
  // subheading, full-width pw-cta-shimmer button. Previously this view used
  // text-lg/text-sm headings and a small inline button — it stood out from the
  // rest of the paywall.
  return (
    <div class="flex flex-col items-center gap-4 px-6 py-6 text-center sm:px-8">
      <div
        class="flex h-14 w-14 items-center justify-center rounded-full"
        style={{
          background: 'linear-gradient(135deg, #4ade80, #16a34a)',
          color: '#fff',
          boxShadow: '0 0 0 8px rgba(74,222,128,0.12), 0 8px 20px -6px rgba(22,163,74,0.45)'
        }}
        aria-hidden="true"
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <path
            d="M5 13l4 4L19 7"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>
      <p id="pw-title" class="mt-1 text-3xl font-bold tracking-tight text-gray-900">
        {restored
          ? t('modal.purchase_restored_title', 'Welcome back')
          : t('modal.purchase_success_title', 'Payment received')}
      </p>
      <p class="text-base leading-relaxed text-gray-600">
        {restored
          ? t('modal.purchase_restored_subtitle', "You're all set — enjoy!")
          : t('modal.purchase_success_subtitle', "You're all set — enjoy!")}
      </p>
      <button
        type="button"
        onClick={onContinue}
        class="pw-cta-shimmer relative mt-2 flex min-h-12 w-full items-center justify-center overflow-hidden rounded-3xl px-5 py-2 text-center text-base font-semibold leading-tight text-white transition-transform duration-150 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
        style={{
          background:
            'linear-gradient(135deg, color-mix(in srgb, var(--pw-accent) 55%, white) 0%, var(--pw-accent) 55%, color-mix(in srgb, var(--pw-accent) 90%, black) 100%)',
          boxShadow:
            '0 0 20px 0 color-mix(in srgb, var(--pw-accent) 25%, transparent), inset 0 0 8px 0 color-mix(in srgb, white 25%, transparent)'
        }}
      >
        <span class="relative z-10">{t('modal.continue', 'Continue')}</span>
      </button>
    </div>
  );
}
