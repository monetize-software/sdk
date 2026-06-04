// A realistic-looking demo. It mimics a "Snapshot AI" product — a fictional
// AI tool with premium features. The goal is to click through the paywall, login
// and account state under conditions close to a real extension.
//
// Architecture: vanilla TS + a full re-render of #app on every state change.
// PaywallUI is responsible for the paywall/auth modals; the popup reads
// paywall.billing and paywall.auth as the single source of truth.

import { PaywallUI } from '@monetize.software/sdk-extension';
import { ApiGatewayClient } from '@sdk/core/ApiGatewayClient';
import type { AuthClient, AuthSession } from '@sdk/core/auth';
import { type Balance, type PaywallPurchaseDetailed, type PaywallUser } from '@sdk/core/types';
import { trackRealAuth, handleGatewayError, callWithRetry } from './unauthorized-handler';

const PROVIDER_ID = '1'; // DeepSeek api provider. The host configures it via the platform.

interface PredictionShape {
  id?: string;
  status?: string;
  output?: string | string[];
  error?: string | null;
}

interface CancelModalState {
  purchase: PaywallPurchaseDetailed;
  reason: string;
  reasonOther: string;
  busy: boolean;
  error: string | null;
}

interface AskState {
  prompt: string;
  busy: boolean;
  response: string | null;
  error: string | null;
}

interface ImageState {
  prompt: string;
  busy: boolean;
  url: string | null;
  error: string | null;
}

interface UpscaleState {
  /** data: URL of the image uploaded by the user. Replicate accepts data: or
   *  http(s)://. For the demo we keep everything as data: — no separate storage. */
  inputDataUrl: string | null;
  inputName: string | null;
  busy: boolean;
  outputUrl: string | null;
  error: string | null;
}

interface DemoState {
  bootstrapStatus: 'loading' | 'ok' | 'error';
  bootstrapError: string | null;
  session: AuthSession | null;
  user: PaywallUser | null;
  toast: { kind: 'success' | 'info' | 'warn'; text: string } | null;
  purchases: PaywallPurchaseDetailed[] | null;
  purchasesLoading: boolean;
  cancelModal: CancelModalState | null;
  balances: Balance[] | null;
  ask: AskState;
  image: ImageState;
  upscale: UpscaleState;
  /** The user's ISO country code (by IP). Taken from bootstrap.settings.visibility.country.
   *  null — bootstrap hasn't loaded yet, or the server couldn't determine the country. */
  country: string | null;
  countryTier: 1 | 2 | 3 | null;
}

const CANCEL_REASONS: Array<{ id: string; label: string }> = [
  { id: 'too_expensive', label: 'Too expensive' },
  { id: 'not_using', label: 'Not using it enough' },
  { id: 'missing_features', label: 'Missing features I need' },
  { id: 'found_alternative', label: 'Found a better alternative' },
  { id: 'technical_issues', label: 'Technical issues' },
  { id: 'other', label: 'Other' }
];

interface PremiumFeature {
  id: string;
  icon: string;
  title: string;
  sub: string;
}

const FEATURES: PremiumFeature[] = [
  { id: 'enhance', icon: '✨', title: 'Enhance image', sub: 'AI upscale 4x' },
  { id: 'remove-bg', icon: '🪄', title: 'Remove background', sub: 'One-click cutout' },
  { id: 'caption', icon: '💬', title: 'Auto caption', sub: 'GPT-4 generated' },
  { id: 'export-pdf', icon: '📄', title: 'Export to PDF', sub: 'High-quality output' }
];

async function init(): Promise<void> {
  const app = document.getElementById('app')!;

  // apiOrigin/paywallId are read from chrome.storage.local — this lets e2e
  // switch the demo to a local mock server (see fixtures.ts).
  const { __demo_paywall_id, __demo_api_origin } = (await chrome.storage.local.get([
    '__demo_paywall_id',
    '__demo_api_origin'
  ])) as { __demo_paywall_id?: string; __demo_api_origin?: string };

  const paywallId = __demo_paywall_id ?? '3';
  const apiOrigin = __demo_api_origin ?? 'https://onlineapp.stream';

  const paywall = new PaywallUI({
    paywallId,
    apiOrigin,
    shadowMode: 'open',
    auth: true
  });
  // See the comment in content.ts — `__paywall` is exposed in the page-context
  // only under `--mode e2e`, so the client template stays clean.
  const mode = (import.meta as { env?: { MODE?: string } }).env?.MODE;
  if (mode === 'e2e') {
    (window as unknown as { __paywall?: PaywallUI }).__paywall = paywall;
  }

  const cachedBootstrap = paywall.billing.getCachedBootstrap();
  const state: DemoState = {
    bootstrapStatus: 'loading',
    bootstrapError: null,
    session: paywall.auth?.getCachedSession() ?? null,
    user: paywall.billing.getCachedUser(),
    toast: null,
    purchases: null,
    purchasesLoading: false,
    cancelModal: null,
    balances: paywall.billing.getCachedBalances(),
    ask: { prompt: '', busy: false, response: null, error: null },
    image: { prompt: '', busy: false, url: null, error: null },
    upscale: { inputDataUrl: null, inputName: null, busy: false, outputUrl: null, error: null },
    country: cachedBootstrap?.settings.visibility?.country ?? null,
    countryTier: cachedBootstrap?.settings.visibility?.tier ?? null
  };

  // ApiGatewayClient uses RemoteAuthClient as its auth source: internally it
  // calls `auth.getAccessToken()`, which goes through transport into offscreen.
  // This way the Bearer comes from the single AuthClient (offscreen), with no duplicates.
  const gateway = new ApiGatewayClient({
    paywallId,
    apiOrigin,
    auth: paywall.auth as unknown as AuthClient,
    onChargeSuccess: () => {
      // After each successful request the balance on the backend is debited —
      // nudge getBalances({force:true}) so the UI shows the updated count.
      // The backend doesn't return the fresh balance in the response, otherwise
      // we could decrement locally.
      void paywall.billing.getBalances({ force: true }).catch(() => {});
    },
    onQuotaExceeded: () => {
      // 402 from the gateway = quota ran out → the host shows the paywall.
      paywall.open();
    }
  });

  function setState(patch: Partial<DemoState>): void {
    Object.assign(state, patch);
    render();
  }

  // Toasts auto-dismiss after 3 sec so the UI isn't left with a stale message
  // (the user clicked a feature, saw the toast, switched to something else — the
  // old toast is no longer relevant).
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function flashToast(kind: 'success' | 'info' | 'warn', text: string): void {
    if (toastTimer !== null) clearTimeout(toastTimer);
    setState({ toast: { kind, text } });
    toastTimer = setTimeout(() => setState({ toast: null }), 3000);
  }

  // Loading rich purchases. Triggered by: a session appearing OR the user
  // closing a successful checkout (purchase_completed). On signOut we reset it —
  // the list is tied to the user.
  async function refreshPurchases(): Promise<void> {
    if (!state.session) {
      setState({ purchases: [], purchasesLoading: false });
      return;
    }
    setState({ purchasesLoading: true });
    try {
      const list = await paywall.billing.listPurchases();
      setState({ purchases: list, purchasesLoading: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState({ purchases: [], purchasesLoading: false });
      flashToast('warn', `Failed to load purchases: ${msg}`);
    }
  }

  paywall.onUserChange((u) => setState({ user: u }));
  paywall.billing.onBalanceChange((b) => setState({ balances: [...b] }));
  // authChange fires with many events (see AuthChangeEvent in
  // @sdk/core/auth). For the popup UI only identity transitions matter:
  //  - SIGNED_IN: a new user (or restore after signOut). We fetch
  //    purchases + balances.
  //  - SIGNED_OUT: clear balances/purchases.
  //  - INITIAL_SESSION: when the popup mounts with an already-signed-in session —
  //    we also load purchases. With `session=null` (guest), purchases are
  //    essentially empty already, so it's a no-op.
  //  - TOKEN_REFRESHED / USER_UPDATED / PASSWORD_RECOVERY: same user.id,
  //    no point fetching /user|/balances|/purchases — the cache is valid.
  paywall.on('authChange', ({ event, session: s }) => {
    setState({ session: s });
    if (event === 'SIGNED_OUT') {
      setState({ balances: null, purchases: [] });
      return;
    }
    if (event !== 'SIGNED_IN' && event !== 'INITIAL_SESSION') return;
    void refreshPurchases();
    // Balances are tied to the Bearer user (see the /balances route). Without
    // force, the SDK serves from a stale cache instantly and revalidates in the
    // background. For an INITIAL_SESSION reload, the offscreen cache is fresh
    // and there's no network request (see BillingClient.getBalances stale-while-revalidate).
    if (s) void paywall.billing.getBalances().catch(() => {});
    else setState({ balances: null });
  });
  // Persistent flag "user signed in with a real identity" — used in
  // handleGatewayError to decide the 401-recovery: show the email form or
  // quietly come up via signInAnonymously.
  trackRealAuth(paywall);

  paywall.on('purchase_completed', (p) => {
    flashToast('success', p.restored ? 'Subscription restored ✓' : 'Purchase complete ✓');
    void refreshPurchases();
  });
  paywall.on('error', (e) => {
    flashToast('warn', `Error: ${e.message}`);
  });

  void paywall.billing.bootstrap().then(
    (b) => {
      setState({
        bootstrapStatus: 'ok',
        country: b.settings.visibility?.country ?? null,
        countryTier: b.settings.visibility?.tier ?? null
      });
      // We do NOT fetch purchases/balances — the authChange listener above
      // already does it (it fires either synchronously with the cached session,
      // or when RemoteAuthClient hydrates from offscreen a few ms later).
      // There used to be a safety refetch with force:true here, but it caused
      // duplicate network requests on popup mount.
    },
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      setState({ bootstrapStatus: 'error', bootstrapError: msg });
    }
  );

  // Pick up a country change on a bootstrap revalidate (for example, the user
  // changed their IP via VPN — the next revalidate updates visibility).
  paywall.billing.onBootstrapChange(() => {
    const b = paywall.billing.getCachedBootstrap();
    setState({
      country: b?.settings.visibility?.country ?? null,
      countryTier: b?.settings.visibility?.tier ?? null
    });
  });

  function isPremium(): boolean {
    return !!state.user?.has_active_subscription;
  }

  function emailInitial(email: string): string {
    return email.trim()[0]?.toUpperCase() ?? '?';
  }

  // === Handlers ===

  function onSignIn(): void {
    paywall.openAuth();
  }

  async function onSignOut(): Promise<void> {
    if (!paywall.auth) return;
    try {
      await paywall.auth.signOut();
      flashToast('info', 'Signed out');
    } catch (e) {
      flashToast('warn', `Sign out failed: ${(e as Error).message}`);
    }
  }

  function onUseFeature(feat: PremiumFeature): void {
    if (isPremium()) {
      flashToast('success', `${feat.title} — done`);
      return;
    }
    // Not signed in or without a subscription — open the paywall. If the user
    // already has an active subscription (the host forgot getAccess()), the SDK
    // will show the restored view instead of the plans on its own.
    paywall.open();
  }

  function onUpgrade(): void {
    paywall.open();
  }

  function onRenew(): void {
    // Renew flow — skips the has_active_subscription pre-check; the backend
    // creates a checkout with ignoreActivePurchase: true.
    paywall.open({ renew: true });
  }

  async function onAskSend(): Promise<void> {
    const prompt = state.ask.prompt.trim();
    if (!prompt) return;
    if (state.ask.busy) return;
    setState({ ask: { ...state.ask, busy: true, response: null, error: null } });
    try {
      // OpenAI-compatible body — the DeepSeek contract matches. The URL, model
      // and other provider-specific fields are baked into the provider's
      // settings on the backend; we send only the per-request part (messages, max_tokens).
      const res = await callWithRetry(paywall, () =>
        gateway.call({
          providerId: PROVIDER_ID,
          method: 'POST',
          body: {
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 256
          }
        })
      );
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const reply = data.choices?.[0]?.message?.content?.trim() ?? '(empty response)';
      setState({ ask: { ...state.ask, busy: false, response: reply } });
    } catch (e) {
      // handleGatewayError itself opens the paywall on quota / the auth form
      // on 401 — we only show the user the correct message in the card.
      const r = await handleGatewayError(e, paywall);
      const error =
        r.kind === 'quota'
          ? 'Quota exceeded — opened paywall'
          : r.kind === 'unauthorized'
            ? 'Session expired — restoring…'
            : r.message;
      setState({ ask: { ...state.ask, busy: false, error } });
    }
  }

  async function onImageSend(): Promise<void> {
    const prompt = state.image.prompt.trim();
    if (!prompt) return;
    if (state.image.busy) return;
    setState({ image: { ...state.image, busy: true, url: null, error: null } });
    try {
      // Replicate Imagen-4 fast: create a prediction, wait for the result with
      // Prefer:wait=60. If it doesn't finish within 60s — poll through the same
      // gateway every 2s until status=succeeded/failed.
      const res = await callWithRetry(paywall, () =>
        gateway.call({
          providerId: '2',
          method: 'POST',
          headers: { Prefer: 'wait=60' },
          body: { input: { prompt } }
        })
      );
      const initial = (await res.json()) as PredictionShape;
      const url = await waitForPrediction(initial);
      setState({ image: { ...state.image, busy: false, url } });
    } catch (e) {
      const r = await handleGatewayError(e, paywall);
      const error =
        r.kind === 'quota'
          ? 'Quota exceeded — opened paywall'
          : r.kind === 'unauthorized'
            ? 'Session expired — restoring…'
            : r.message;
      setState({ image: { ...state.image, busy: false, error } });
    }
  }

  function onUpscaleFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      setState({
        upscale: {
          ...state.upscale,
          inputDataUrl: dataUrl,
          inputName: file.name,
          outputUrl: null,
          error: null
        }
      });
    };
    reader.onerror = () => {
      setState({
        upscale: { ...state.upscale, error: 'Failed to read file' }
      });
    };
    reader.readAsDataURL(file);
  }

  async function onUpscaleSend(): Promise<void> {
    const u = state.upscale;
    if (!u.inputDataUrl) return;
    if (u.busy) return;
    setState({ upscale: { ...u, busy: true, outputUrl: null, error: null } });
    try {
      const res = await callWithRetry(paywall, () =>
        gateway.call({
          providerId: '3',
          method: 'POST',
          headers: { Prefer: 'wait=60' },
          body: { input: { image: u.inputDataUrl, scale_factor: 2 } }
        })
      );
      const initial = (await res.json()) as PredictionShape;
      const url = await waitForPrediction(initial);
      setState({ upscale: { ...state.upscale, busy: false, outputUrl: url } });
    } catch (e) {
      const r = await handleGatewayError(e, paywall);
      const error =
        r.kind === 'quota'
          ? 'Quota exceeded — opened paywall'
          : r.kind === 'unauthorized'
            ? 'Session expired — restoring…'
            : r.message;
      setState({ upscale: { ...state.upscale, busy: false, error } });
    }
  }

  async function waitForPrediction(initial: PredictionShape): Promise<string> {
    let pred = initial;
    const start = Date.now();
    const TIMEOUT_MS = 2 * 60_000;
    while (true) {
      if (pred.status === 'succeeded') {
        const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
        if (!out) throw new Error('Empty output from Replicate');
        return out;
      }
      if (pred.status === 'failed' || pred.status === 'canceled') {
        throw new Error(pred.error || `Prediction ${pred.status}`);
      }
      if (!pred.id) throw new Error('Missing prediction id');
      if (Date.now() - start > TIMEOUT_MS) throw new Error('Timeout (>2 min)');
      await new Promise((r) => setTimeout(r, 2000));
      // providerId=4 — the shared poll provider for Replicate. On the backend it
      // has the base `https://api.replicate.com/v1/predictions` baked in, with
      // query_type='free' (we don't charge for re-reading status). The only
      // dynamic part here is the prediction id — it's appended to the baked-in URL.
      const r = await gateway.call({
        providerId: '4',
        path: pred.id,
        method: 'GET'
      });
      pred = (await r.json()) as PredictionShape;
    }
  }

  function onOpenCancel(p: PaywallPurchaseDetailed): void {
    setState({
      cancelModal: { purchase: p, reason: '', reasonOther: '', busy: false, error: null }
    });
  }

  function onCloseCancel(): void {
    if (state.cancelModal?.busy) return;
    setState({ cancelModal: null });
  }

  async function onConfirmCancel(): Promise<void> {
    const m = state.cancelModal;
    if (!m) return;
    if (!m.reason) {
      setState({ cancelModal: { ...m, error: 'Please select a reason' } });
      return;
    }
    if (m.reason === 'other' && !m.reasonOther.trim()) {
      setState({
        cancelModal: { ...m, error: 'Please describe the reason' }
      });
      return;
    }
    setState({ cancelModal: { ...m, busy: true, error: null } });
    try {
      const reason = m.reason === 'other' ? m.reasonOther.trim() : m.reason;
      const resp = await paywall.billing.cancelSubscription({
        subscriptionId: m.purchase.id,
        reason
      });
      flashToast('success', 'Subscription cancelled');
      // The backend returns `responseSubscription` synchronously (the Stripe API
      // answer), but the DB row is updated by the acquiring webhook — seconds to
      // minutes later. listPurchases() right after the cancel would still return
      // the OLD row and revert the UI back to active. So we merge the response
      // locally and do the refresh deferred by ~10s (by then the webhook has caught up).
      const list = (state.purchases ?? []).map((p): PaywallPurchaseDetailed =>
        p.id === m.purchase.id
          ? {
              ...p,
              status: resp.subscription.status ?? p.status,
              canceled_at: resp.subscription.canceled_at ?? null,
              cancel_at: resp.subscription.cancel_at ?? p.current_period_end ?? p.cancel_at ?? null,
              cancel_at_period_end: resp.subscription.cancel_at_period_end ?? true
            }
          : p
      );
      setState({ cancelModal: null, purchases: list });
      // Best-effort revalidation after the expected webhook window — if the
      // final values landed in the DB, the UI updates; if the webhook was
      // delayed, the optimistic state still remains in the UI.
      setTimeout(() => void refreshPurchases(), 10_000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState({
        cancelModal: { ...m, busy: false, error: msg }
      });
      flashToast('warn', `Cancel failed: ${msg}`);
    }
  }

  // === Render ===

  function render(): void {
    const premium = isPremium();
    const session = state.session;
    const user = state.user;

    app.innerHTML = '';
    app.append(
      header(premium),
      el('main', { class: 'main' },
        accountCard(session, user, premium),
        session ? balancesCard() : null,
        askCard(),
        imageCard(),
        upscaleCard(),
        session ? subscriptionsCard() : null,
        featuresCard(premium),
        ctaRow(session, premium),
        state.toast
          ? el('div', { class: `toast ${state.toast.kind}` }, state.toast.text)
          : null
      ),
      footer(),
      state.cancelModal ? cancelModal(state.cancelModal) : null
    );

    bindHandlers();
  }

  function askCard(): HTMLElement {
    const a = state.ask;
    const ta = el('textarea', {
      class: 'ask-input',
      placeholder: 'Ask DeepSeek anything…',
      'data-action': 'ask-prompt',
      rows: '2'
    }) as HTMLTextAreaElement;
    ta.value = a.prompt;
    if (a.busy) ta.setAttribute('disabled', 'true');

    return el('div', { class: 'card' },
      el('h3', null, 'Ask DeepSeek (gateway/1)'),
      el('div', { class: 'ask-row' },
        ta,
        el('button', {
          class: 'btn btn-primary ask-send',
          'data-action': 'ask-send',
          ...(a.busy ? { disabled: 'true' } : {})
        }, a.busy ? '…' : 'Send')
      ),
      a.response
        ? el('div', { class: 'ask-response' }, a.response)
        : null,
      a.error
        ? el('div', { class: 'ask-error' }, a.error)
        : null,
      el('div', { class: 'ask-meta' },
        `provider=${PROVIDER_ID} · через offscreen Bearer · 402 → paywall`
      )
    );
  }

  function balancesCard(): HTMLElement {
    const list = state.balances ?? [];
    let body: HTMLElement;
    if (list.length === 0) {
      body = el('div', { class: 'subs-empty' },
        state.balances === null ? 'Loading…' : 'No tokenized balances configured for this paywall.'
      );
    } else {
      body = el('div', { class: 'balances-grid' },
        ...list.map((b) =>
          el('div', { class: 'balance-pill' },
            el('div', { class: 'balance-count' }, String(b.count)),
            el('div', { class: 'balance-type' }, b.type)
          )
        )
      );
    }
    return el('div', { class: 'card' },
      el('h3', null, 'Balances'),
      body
    );
  }

  function upscaleCard(): HTMLElement {
    const u = state.upscale;
    const fileInput = el('input', {
      type: 'file',
      accept: 'image/*',
      class: 'ask-file',
      'data-action': 'upscale-file',
      ...(u.busy ? { disabled: 'true' } : {})
    }) as HTMLInputElement;

    return el('div', { class: 'card' },
      el('h3', null, 'Upscale image (gateway/3 · Clarity Upscaler)'),
      el('div', { class: 'upscale-row' },
        fileInput,
        el('button', {
          class: 'btn btn-primary',
          'data-action': 'upscale-send',
          ...(u.busy || !u.inputDataUrl ? { disabled: 'true' } : {})
        }, u.busy ? '…' : 'Upscale 2x')
      ),
      u.inputName
        ? el('div', { class: 'ask-meta' }, `selected: ${u.inputName}`)
        : null,
      u.inputDataUrl && !u.outputUrl
        ? el('div', { class: 'upscale-preview' },
            el('img', { class: 'ai-image', src: u.inputDataUrl, alt: 'Input' })
          )
        : null,
      u.outputUrl
        ? el('div', { class: 'upscale-result' },
            el('div', { class: 'ask-meta' }, 'Result:'),
            el('a', { class: 'ai-image-wrap', href: u.outputUrl, target: '_blank', rel: 'noopener' },
              el('img', { class: 'ai-image', src: u.outputUrl, alt: 'Upscaled' })
            )
          )
        : null,
      u.error
        ? el('div', { class: 'ask-error' }, u.error)
        : null,
      el('div', { class: 'ask-meta' },
        'provider=3 · scale_factor=2 · может занять 30-90с'
      )
    );
  }

  function imageCard(): HTMLElement {
    const i = state.image;
    const ta = el('textarea', {
      class: 'ask-input',
      placeholder: 'Describe an image — e.g. "a cat astronaut in space"',
      'data-action': 'image-prompt',
      rows: '2'
    }) as HTMLTextAreaElement;
    ta.value = i.prompt;
    if (i.busy) ta.setAttribute('disabled', 'true');

    return el('div', { class: 'card' },
      el('h3', null, 'Generate image (gateway/2 · Replicate Imagen-4)'),
      el('div', { class: 'ask-row' },
        ta,
        el('button', {
          class: 'btn btn-primary ask-send',
          'data-action': 'image-send',
          ...(i.busy ? { disabled: 'true' } : {})
        }, i.busy ? '…' : 'Generate')
      ),
      i.url
        ? el('a', { class: 'ai-image-wrap', href: i.url, target: '_blank', rel: 'noopener' },
            el('img', { class: 'ai-image', src: i.url, alt: 'Generated' })
          )
        : null,
      i.error
        ? el('div', { class: 'ask-error' }, i.error)
        : null,
      el('div', { class: 'ask-meta' },
        'provider=2 · prediction async (≈10-60с) · 402 → paywall'
      )
    );
  }

  function subscriptionsCard(): HTMLElement {
    const list = state.purchases ?? [];
    let body: HTMLElement;
    if (state.purchasesLoading && list.length === 0) {
      body = el('div', { class: 'subs-empty' }, 'Loading subscriptions…');
    } else if (list.length === 0) {
      body = el('div', { class: 'subs-empty' }, 'No subscriptions yet.');
    } else {
      body = el('div', { class: 'subs-list' },
        ...list.map(subscriptionRow)
      );
    }
    return el('div', { class: 'card' },
      el('h3', null, 'Subscriptions'),
      body
    );
  }

  function subscriptionRow(p: PaywallPurchaseDetailed): HTMLElement {
    const status = (p.status ?? '').toLowerCase();
    const isLifetime = p.interval === 'lifetime';
    const isCancelable =
      !isLifetime && !p.cancel_at && !p.canceled_at && !p.cancel_at_period_end;

    const chipClass = chipForStatus(status, p.cancel_at_period_end, p.cancel_at);
    const statusText = labelForStatus(status, p.cancel_at_period_end, p.cancel_at);

    let nextLine: string;
    if (status === 'active' && p.cancel_at_period_end && p.current_period_end) {
      nextLine = `Cancels on ${formatDate(p.current_period_end)}`;
    } else if (p.cancel_at) {
      nextLine = `Access until ${formatDate(p.cancel_at)}`;
    } else if (status === 'trialing' && p.current_period_end) {
      nextLine = `Trial ends ${formatDate(p.current_period_end)}`;
    } else if (status === 'canceled' || status === 'cancelled') {
      nextLine = `Cancelled ${formatDate(p.canceled_at)}`;
    } else if (p.current_period_end) {
      nextLine = `Renews ${formatDate(p.current_period_end)}`;
    } else {
      nextLine = 'Active';
    }

    const discountedAmount =
      p.unit_amount * (1 - (p.discount ?? 0) / 100);

    return el('div', { class: 'sub-row' },
      el('div', { class: 'sub-main' },
        el('div', { class: 'sub-head' },
          el('span', { class: `chip ${chipClass}` }, statusText),
          el('span', { class: 'sub-id', title: p.id }, p.id.slice(0, 12) + '…')
        ),
        el('div', { class: 'sub-price' },
          p.discount
            ? el('span', { class: 'price-old' }, formatCurrency(p.unit_amount, p.currency))
            : null,
          el('span', { class: 'price-new' }, formatCurrency(discountedAmount, p.currency)),
          el('span', { class: 'price-int' }, '/ ' + formatInterval(p.interval)),
          p.discount
            ? el('span', { class: 'chip success' }, `-${p.discount}%`)
            : null
        ),
        el('div', { class: 'sub-meta' }, nextLine)
      ),
      isCancelable
        ? el('button', {
            class: 'btn btn-danger sub-cancel',
            'data-action': 'cancel-sub',
            'data-sub-id': p.id
          }, 'Cancel')
        : null
    );
  }

  function cancelModal(m: CancelModalState): HTMLElement {
    const reasonOptions = [
      el('option', { value: '' }, 'Select a reason…'),
      ...CANCEL_REASONS.map((r) =>
        el('option', { value: r.id }, r.label)
      )
    ];
    return el('div', { class: 'modal-overlay', 'data-action': 'cancel-close' },
      el('div', { class: 'modal' },
        el('div', { class: 'modal-head' },
          el('h2', null, 'Cancel subscription'),
          el('button', { class: 'modal-x', 'data-action': 'cancel-close', type: 'button' }, '×')
        ),
        el('div', { class: 'modal-body' },
          el('p', { class: 'modal-text' },
            'Cancellation takes effect at the end of the current period. ' +
            (m.purchase.current_period_end
              ? 'Access remains until ' + formatDate(m.purchase.current_period_end) + '.'
              : '')
          ),
          el('label', { class: 'modal-label' }, 'Reason'),
          (() => {
            const sel = el('select', { class: 'modal-select', 'data-action': 'cancel-reason' },
              ...reasonOptions
            ) as HTMLSelectElement;
            sel.value = m.reason;
            return sel;
          })(),
          m.reason === 'other'
            ? (() => {
                const inp = el('input', {
                  class: 'modal-input',
                  type: 'text',
                  placeholder: 'Tell us more…',
                  'data-action': 'cancel-reason-other'
                }) as HTMLInputElement;
                inp.value = m.reasonOther;
                return inp;
              })()
            : null,
          m.error ? el('div', { class: 'modal-err' }, m.error) : null
        ),
        el('div', { class: 'modal-foot' },
          el('button', {
            class: 'btn btn-ghost',
            'data-action': 'cancel-close',
            type: 'button',
            ...(m.busy ? { disabled: 'true' } : {})
          }, 'Don\'t cancel'),
          el('button', {
            class: 'btn btn-danger',
            'data-action': 'cancel-confirm',
            type: 'button',
            ...(m.busy ? { disabled: 'true' } : {})
          }, m.busy ? 'Cancelling…' : 'Cancel subscription')
        )
      )
    );
  }

  function formatCurrency(amountMinor: number, currency: string): string {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: (currency || 'USD').toUpperCase(),
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(amountMinor / 100);
    } catch {
      return `${(amountMinor / 100).toFixed(2)} ${currency}`;
    }
  }

  function formatInterval(interval: string | null): string {
    if (!interval) return 'one-time';
    if (interval === 'lifetime') return 'lifetime';
    return interval;
  }

  function formatDate(iso: string | null): string {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  function labelForStatus(
    status: string,
    cancelAtPeriodEnd: boolean,
    cancelAt: string | null
  ): string {
    switch (status) {
      case 'active':
        return cancelAtPeriodEnd ? 'Cancels at period end' : 'Active';
      case 'trialing':
        return cancelAt ? 'Trial (will cancel)' : 'Trial';
      case 'canceled':
      case 'cancelled':
        return 'Cancelled';
      case 'past_due':
        return 'Past due';
      case 'paid':
        return 'Paid';
      default:
        return status || '—';
    }
  }

  function chipForStatus(
    status: string,
    cancelAtPeriodEnd: boolean,
    cancelAt: string | null
  ): string {
    switch (status) {
      case 'active':
        return cancelAtPeriodEnd ? 'warning' : 'success';
      case 'trialing':
        return cancelAt ? 'warning' : 'info';
      case 'paid':
        return 'success';
      case 'past_due':
        return 'warning';
      case 'canceled':
      case 'cancelled':
        return 'muted';
      default:
        return 'muted';
    }
  }

  function header(premium: boolean): HTMLElement {
    const countryLabel =
      state.country
        ? state.countryTier
          ? `${state.country} · T${state.countryTier}`
          : state.country
        : null;
    return el('div', { class: 'header' },
      el('div', { class: 'brand' },
        el('div', { class: 'brand-logo' }, 'SA'),
        el('div', null,
          el('div', { class: 'brand-name' }, 'Snapshot AI'),
          el('div', { class: 'brand-tag' }, 'Demo extension')
        )
      ),
      el('div', { class: 'header-actions' },
        countryLabel
          ? el('span', {
              class: 'pill free',
              title: 'Country detected by IP (via paywall visibility)'
            }, countryLabel)
          : null,
        el('span', { class: `pill ${premium ? 'premium' : 'free'}` }, premium ? '★ Premium' : 'Free plan')
      )
    );
  }

  function accountCard(
    session: AuthSession | null,
    user: PaywallUser | null,
    premium: boolean
  ): HTMLElement {
    const signedIn = !!session;
    const email = session?.user?.email ?? '';

    let line1: string;
    let line2: string;
    if (!signedIn) {
      line1 = 'Not signed in';
      line2 = 'Sign in to sync your subscription across devices';
    } else if (premium) {
      line1 = email;
      const purchases = user?.purchases?.length ?? 0;
      line2 = `Premium · ${purchases} purchase${purchases === 1 ? '' : 's'} on file`;
    } else {
      line1 = email;
      line2 = 'Free plan · Upgrade to unlock all features';
    }

    return el('div', { class: 'card' },
      el('h3', null, 'Account'),
      el('div', { class: 'acct' },
        el('div', { class: `avatar ${signedIn ? '' : 'guest'}` },
          signedIn ? emailInitial(email) : '?'
        ),
        el('div', { class: 'acct-info' },
          el('div', { class: 'acct-line1' }, line1),
          el('div', { class: 'acct-line2' }, line2)
        ),
        accountActions(signedIn)
      )
    );
  }

  function accountActions(signedIn: boolean): HTMLElement {
    if (!signedIn) {
      return el('div', { class: 'acct-actions' },
        el('button', { class: 'btn btn-primary', 'data-action': 'sign-in' }, 'Sign in')
      );
    }
    return el('div', { class: 'acct-actions' },
      el('button', { class: 'btn btn-danger', 'data-action': 'sign-out' }, 'Sign out')
    );
  }

  function featuresCard(premium: boolean): HTMLElement {
    return el('div', { class: 'card' },
      el('h3', null, premium ? 'Premium features' : 'Try premium'),
      el('div', { class: 'features-grid' },
        ...FEATURES.map((f) => featButton(f, premium))
      )
    );
  }

  function featButton(f: PremiumFeature, premium: boolean): HTMLElement {
    return el('button', {
      class: 'feat',
      'data-action': 'use-feature',
      'data-feature-id': f.id
    },
      el('div', { class: 'feat-icon' }, f.icon),
      el('div', { class: 'feat-body' },
        el('div', { class: 'feat-title' }, f.title),
        el('div', { class: 'feat-sub' }, f.sub)
      ),
      premium ? null : el('div', { class: 'feat-lock' }, '🔒')
    );
  }

  function ctaRow(session: AuthSession | null, premium: boolean): HTMLElement | null {
    if (premium) {
      // The user has an active subscription — we offer only Renew (for example,
      // a plan upgrade). Open would lead to the restored screen, which is useless.
      return el('div', { class: 'cta-row' },
        el('button', { class: 'btn btn-ghost', 'data-action': 'renew' }, 'Manage / Renew')
      );
    }
    return el('div', { class: 'cta-row' },
      el('button', { class: 'btn btn-primary', 'data-action': 'upgrade' },
        session ? 'Upgrade to Premium' : 'See plans'
      ),
      el('button', { class: 'btn btn-ghost', 'data-action': 'renew' }, 'Renew (force)')
    );
  }

  function footer(): HTMLElement {
    const dotClass =
      state.bootstrapStatus === 'ok'
        ? 'dot ok'
        : state.bootstrapStatus === 'error'
          ? 'dot err'
          : 'dot';
    const status =
      state.bootstrapStatus === 'ok'
        ? 'bootstrap ok'
        : state.bootstrapStatus === 'error'
          ? `bootstrap failed: ${state.bootstrapError ?? 'unknown'}`
          : 'bootstrapping…';
    return el('div', { class: 'footer' },
      el('span', null,
        el('span', { class: dotClass }, ''),
        status
      ),
      el('span', null, `pw=${paywallId} · ${apiOrigin.replace(/^https?:\/\//, '')}`)
    );
  }

  function bindHandlers(): void {
    app.querySelectorAll<HTMLElement>('[data-action]').forEach((node) => {
      const action = node.getAttribute('data-action');
      // change events for select/input — the cancel-reason validation modal fields
      if (action === 'cancel-reason') {
        node.addEventListener('change', (e) => {
          if (!state.cancelModal) return;
          const v = (e.currentTarget as HTMLSelectElement).value;
          setState({ cancelModal: { ...state.cancelModal, reason: v, error: null } });
        });
        return;
      }
      if (action === 'cancel-reason-other') {
        node.addEventListener('input', (e) => {
          if (!state.cancelModal) return;
          const v = (e.currentTarget as HTMLInputElement).value;
          // Update without a render — we don't want to re-render the modal on
          // every letter, otherwise the input loses focus. Store it straight in state.
          state.cancelModal.reasonOther = v;
        });
        return;
      }
      if (action === 'ask-prompt') {
        // Write to state synchronously without a render — otherwise the textarea
        // loses its caret position on every keystroke.
        node.addEventListener('input', (e) => {
          state.ask.prompt = (e.currentTarget as HTMLTextAreaElement).value;
        });
        node.addEventListener('keydown', (e) => {
          // Cmd/Ctrl+Enter = send. Familiar from AI chats.
          const ke = e as KeyboardEvent;
          if (ke.key === 'Enter' && (ke.metaKey || ke.ctrlKey)) {
            e.preventDefault();
            void onAskSend();
          }
        });
        return;
      }
      if (action === 'image-prompt') {
        node.addEventListener('input', (e) => {
          state.image.prompt = (e.currentTarget as HTMLTextAreaElement).value;
        });
        node.addEventListener('keydown', (e) => {
          const ke = e as KeyboardEvent;
          if (ke.key === 'Enter' && (ke.metaKey || ke.ctrlKey)) {
            e.preventDefault();
            void onImageSend();
          }
        });
        return;
      }
      if (action === 'upscale-file') {
        node.addEventListener('change', (e) => {
          const f = (e.currentTarget as HTMLInputElement).files?.[0];
          if (f) onUpscaleFile(f);
        });
        return;
      }
      node.addEventListener('click', (e) => {
        // For the modal overlay — close only on a click on the overlay itself,
        // not on a click bubbling up from the inner content.
        if (action === 'cancel-close' && e.currentTarget !== e.target && node.classList.contains('modal-overlay')) {
          return;
        }
        e.preventDefault();
        if (action === 'sign-in') onSignIn();
        else if (action === 'sign-out') void onSignOut();
        else if (action === 'use-feature') {
          const id = node.getAttribute('data-feature-id');
          const f = FEATURES.find((x) => x.id === id);
          if (f) onUseFeature(f);
        }
        else if (action === 'upgrade') onUpgrade();
        else if (action === 'renew') onRenew();
        else if (action === 'cancel-sub') {
          const id = node.getAttribute('data-sub-id');
          const sub = (state.purchases ?? []).find((p) => p.id === id);
          if (sub) onOpenCancel(sub);
        }
        else if (action === 'cancel-close') onCloseCancel();
        else if (action === 'cancel-confirm') void onConfirmCancel();
        else if (action === 'ask-send') void onAskSend();
        else if (action === 'image-send') void onImageSend();
        else if (action === 'upscale-send') void onUpscaleSend();
      });
    });
  }

  render();
}

// === Lightweight createElement helper ===
// Without preact / jsx so popup.html stays more compact. Accepts props (including
// aria/data-* attributes) and a variable number of children. null/undefined
// children are simply skipped — handy for conditional rendering.
type AttrMap = Record<string, string> | null;
type Child = string | Node | null | undefined;

function el(tag: string, attrs: AttrMap, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      node.setAttribute(k, v);
    }
  }
  for (const child of children) {
    if (child == null) continue;
    if (typeof child === 'string') {
      node.appendChild(document.createTextNode(child));
    } else {
      node.appendChild(child);
    }
  }
  return node;
}

void init();
