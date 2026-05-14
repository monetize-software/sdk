// Demo content-script. PaywallUI + плавающий widget в углу страницы.
//
// Widget показывает текущий account/subscription state и реактивно обновляется
// на authChange/userChange. Главное демо-значение: signin в popup'е (или другой
// вкладке) мгновенно отражается на этой странице — потому что offscreen broadcast'ит
// auth/user обновления всем подключённым content-script'ам.
//
// Виджет в собственном Shadow DOM, чтобы стили страницы (CSP, !important от
// host'а) не ломали layout.

import { PaywallUI, PROTOCOL_VERSION } from '@monetize.software/sdk-extension';
import { ApiGatewayClient } from '@sdk/core/ApiGatewayClient';
import { type Balance, type PaywallUser } from '@sdk/core/types';
import type { AuthClient, AuthSession } from '@sdk/core/auth';
import { trackRealAuth, handleGatewayError, callWithRetry } from './unauthorized-handler';

const PROVIDER_ID = '1'; // DeepSeek api-провайдер.

console.info('[demo-extension] content-script loaded, sdk-extension v' + PROTOCOL_VERSION);

// data-attribute на <html> — единственный надёжный способ для page-context
// (e2e-тестов) увидеть, что content-script прогрузился. window.__paywall
// доступен только в content-script isolated world, page его не видит.
document.documentElement.setAttribute('data-paywall-loaded', '1');

interface WidgetState {
  session: AuthSession | null;
  user: PaywallUser | null;
  balances: Balance[] | null;
  expanded: boolean;
  flash: string | null;
  /** 'main' — карточка с account + кнопками; 'ask' — DeepSeek чат; 'image' —
   *  Replicate генерация; 'upscale' — Replicate Clarity Upscaler с file input.
   *  Переключается через nav-кнопки в карточке. */
  view: 'main' | 'ask' | 'image' | 'upscale';
  askPrompt: string;
  askBusy: boolean;
  askResponse: string | null;
  askError: string | null;
  imagePrompt: string;
  imageBusy: boolean;
  imageUrl: string | null;
  imageError: string | null;
  upscaleInputDataUrl: string | null;
  upscaleInputName: string | null;
  upscaleBusy: boolean;
  upscaleOutputUrl: string | null;
  upscaleError: string | null;
}

async function bootstrapPaywall(): Promise<void> {
  const { __demo_paywall_id, __demo_api_origin } = (await chrome.storage.local.get([
    '__demo_paywall_id',
    '__demo_api_origin'
  ])) as { __demo_paywall_id?: string; __demo_api_origin?: string };

  const paywall = new PaywallUI({
    paywallId: __demo_paywall_id ?? '3',
    apiOrigin: __demo_api_origin ?? 'http://152.42.143.9:3000',
    shadowMode: 'open',
    auth: true
  });

  // Page-context exposure ТОЛЬКО для e2e-сборки (`vite build --mode e2e`).
  // В обычном `build:demo` (= шаблон для клиентов) этой строки в bundle нет —
  // клиент копипастит content.ts и не получает PaywallUI в page-context'е
  // случайно: любой script на странице иначе мог бы дёрнуть paywall.open() /
  // .track() и злоупотреблять чужим extension'ом. Cast: demo-extension
  // excluded из tsconfig, `vite/client` types сюда не подтянуты — берём env
  // вручную, vite заменит на литерал при bundling'е и if-блок dead-code'нится.
  const mode = (import.meta as { env?: { MODE?: string } }).env?.MODE;
  if (mode === 'e2e') {
    (window as unknown as { __paywall?: PaywallUI }).__paywall = paywall;
  }
  document.documentElement.setAttribute('data-paywall-ready', '1');

  // Записываем persistent-флаг "юзер логинился реальной identity" — нужен для
  // решения 401-recovery flow'а (см. handleGatewayError ниже).
  trackRealAuth(paywall);

  mountWidget(paywall);

  // Bootstrap в фоне — заполнит cachedUser, виджет ре-рендерится через onUserChange.
  void paywall.billing.bootstrap();
}

void bootstrapPaywall();

// === Floating widget ===

function mountWidget(paywall: PaywallUI): void {
  // top-level контейнер — обычный div в host-документе. attachShadow
  // делает изолированный subtree, в который рисуем UI.
  const host = document.createElement('div');
  host.id = '__monetize-demo-widget';
  host.style.cssText = 'all: initial; position: fixed; bottom: 16px; right: 16px; z-index: 2147483646;';
  // Только когда DOM готов — иначе на document_idle injection'е <body>
  // может ещё не быть (редко, но бывает на slow-renderable страницах).
  if (document.body) document.body.appendChild(host);
  else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(host), { once: true });

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = WIDGET_CSS;
  shadow.appendChild(style);

  const root = document.createElement('div');
  root.className = 'wrap';
  shadow.appendChild(root);

  const state: WidgetState = {
    session: paywall.auth?.getCachedSession() ?? null,
    user: paywall.billing.getCachedUser(),
    balances: paywall.billing.getCachedBalances(),
    expanded: false,
    flash: null,
    view: 'main',
    askPrompt: '',
    askBusy: false,
    askResponse: null,
    askError: null,
    imagePrompt: '',
    imageBusy: false,
    imageUrl: null,
    imageError: null,
    upscaleInputDataUrl: null,
    upscaleInputName: null,
    upscaleBusy: false,
    upscaleOutputUrl: null,
    upscaleError: null
  };

  // Bearer'ов общий gateway: внутри ApiGatewayClient вызывает
  // `auth.getAccessToken()` → RemoteAuthClient → transport → offscreen.
  // 402 = квота — открываем paywall автоматически.
  const gateway = new ApiGatewayClient({
    paywallId: paywall.billing.paywallId,
    apiOrigin: paywall.billing.apiOrigin ?? undefined,
    auth: paywall.auth as unknown as AuthClient,
    onChargeSuccess: () => {
      void paywall.billing.getBalances({ force: true }).catch(() => {});
    },
    onQuotaExceeded: () => paywall.open()
  });

  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  function setFlash(text: string): void {
    state.flash = text;
    render();
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      state.flash = null;
      render();
    }, 2500);
  }

  // Первый callback per subscriber — это initial snapshot из cached mirror'а
  // (см. `RemoteBillingClient.onUserChange` microtask emit), а не реальный
  // переход. Если в нём уже premium — это «восстановили state», а не «только
  // что активировал»; флеш «Premium activated» нужен ТОЛЬКО на реальном
  // false→true переходе уже после initial sync.
  let userInitialDelivered = false;
  paywall.onUserChange((u) => {
    const wasPremium = !!state.user?.has_active_subscription;
    state.user = u;
    if (!userInitialDelivered) {
      userInitialDelivered = true;
      render();
      return;
    }
    if (!wasPremium && u.has_active_subscription) setFlash('Premium activated ✓');
    else render();
  });
  paywall.on('authChange', ({ event, session: s }) => {
    state.session = s;
    if (event === 'SIGNED_IN') {
      // Реальный вход — баланс может отличаться от того, что закешировано
      // под предыдущей identity (или вообще не было кеша). Force-refetch.
      void paywall.billing.getBalances({ force: true }).catch(() => {});
      setFlash(`Signed in: ${s?.user?.email ?? ''}`);
    } else if (event === 'SIGNED_OUT') {
      state.balances = null;
      setFlash('Signed out');
    } else {
      // INITIAL_SESSION (restore из storage при reload), TOKEN_REFRESHED,
      // USER_UPDATED, PASSWORD_RECOVERY — для UI это просто re-render с новой
      // session. Балансы НЕ дёргаем: либо это сессия восстановилась (cached
      // через offscreen-persist всё ещё валиден), либо те же user.id+квоты.
      render();
    }
  });
  paywall.billing.onBalanceChange((b) => {
    state.balances = [...b];
    render();
  });

  function isPremium(): boolean {
    return !!state.user?.has_active_subscription;
  }

  function emailInitial(email: string): string {
    return email.trim()[0]?.toUpperCase() ?? '?';
  }

  async function runAsk(): Promise<void> {
    const prompt = state.askPrompt.trim();
    if (!prompt || state.askBusy) return;
    state.askBusy = true;
    state.askResponse = null;
    state.askError = null;
    render();
    try {
      const res = await callWithRetry(paywall, () =>
        gateway.call({
          providerId: '1',
          path: '',
          method: 'POST',
          body: {
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 256
          }
        })
      );
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      state.askResponse = data.choices?.[0]?.message?.content?.trim() ?? '(empty)';
    } catch (e) {
      const res = await handleGatewayError(e, paywall);
      if (res.kind === 'quota') state.askError = 'Quota exceeded — opened paywall';
      else if (res.kind === 'unauthorized') state.askError = 'Session expired — restoring…';
      else state.askError = res.message;
    } finally {
      state.askBusy = false;
      render();
    }
  }

  async function runImage(): Promise<void> {
    const prompt = state.imagePrompt.trim();
    if (!prompt || state.imageBusy) return;
    state.imageBusy = true;
    state.imageUrl = null;
    state.imageError = null;
    render();
    try {
      // Replicate Imagen-4-fast: создаём prediction, ждём результата через
      // `Prefer: wait=60`. Replicate за это время либо завершит и вернёт
      // output (URL картинки), либо отдаст prediction в processing-state'е.
      // Для processing — poll'им через тот же gateway по prediction.id.
      const res = await callWithRetry(paywall, () =>
        gateway.call({
          providerId: '2',
          path: 'v1/models/google/imagen-4-fast/predictions',
          method: 'POST',
          headers: { Prefer: 'wait=60' },
          body: { input: { prompt } }
        })
      );
      const pred = (await res.json()) as {
        id?: string;
        status?: string;
        output?: string | string[];
        error?: string | null;
      };
      const url = await waitForPrediction(pred);
      state.imageUrl = url;
    } catch (e) {
      const res = await handleGatewayError(e, paywall);
      if (res.kind === 'quota') state.imageError = 'Quota exceeded — opened paywall';
      else if (res.kind === 'unauthorized') state.imageError = 'Session expired — restoring…';
      else state.imageError = res.message;
    } finally {
      state.imageBusy = false;
      render();
    }
  }

  function onUpscaleFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      state.upscaleInputDataUrl = String(reader.result ?? '');
      state.upscaleInputName = file.name;
      state.upscaleOutputUrl = null;
      state.upscaleError = null;
      render();
    };
    reader.onerror = () => {
      state.upscaleError = 'Failed to read file';
      render();
    };
    reader.readAsDataURL(file);
  }

  async function runUpscale(): Promise<void> {
    if (!state.upscaleInputDataUrl || state.upscaleBusy) return;
    state.upscaleBusy = true;
    state.upscaleOutputUrl = null;
    state.upscaleError = null;
    render();
    try {
      const res = await callWithRetry(paywall, () =>
        gateway.call({
          providerId: '3',
          path: 'v1/models/philz1337x/clarity-upscaler/predictions',
          method: 'POST',
          headers: { Prefer: 'wait=60' },
          body: { input: { image: state.upscaleInputDataUrl, scale_factor: 2 } }
        })
      );
      const initial = (await res.json()) as Parameters<typeof waitForPrediction>[0];
      const url = await waitForPrediction(initial);
      state.upscaleOutputUrl = url;
    } catch (e) {
      const res = await handleGatewayError(e, paywall);
      if (res.kind === 'quota') state.upscaleError = 'Quota exceeded — opened paywall';
      else if (res.kind === 'unauthorized') state.upscaleError = 'Session expired — restoring…';
      else state.upscaleError = res.message;
    } finally {
      state.upscaleBusy = false;
      render();
    }
  }

  /** Replicate prediction polling. Если уже готов на момент возврата POST'а
   *  (Prefer:wait=60 успел) — резолвим сразу. Иначе ходим за prediction
   *  каждые 2с (через тот же gateway, чтобы Bearer + paywall_id). */
  async function waitForPrediction(initial: {
    id?: string;
    status?: string;
    output?: string | string[];
    error?: string | null;
  }): Promise<string> {
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
      if (Date.now() - start > TIMEOUT_MS) {
        throw new Error('Prediction timeout (>2 min)');
      }
      await new Promise((r) => setTimeout(r, 2000));
      const res = await gateway.call({
        providerId: '2',
        path: `v1/predictions/${pred.id}`,
        method: 'GET'
      });
      pred = (await res.json()) as typeof pred;
    }
  }

  function render(): void {
    const session = state.session;
    const premium = isPremium();
    const email = session?.user?.email ?? '';

    if (!state.expanded) {
      root.innerHTML = '';
      const pill = document.createElement('button');
      pill.className = 'pill';
      pill.setAttribute('aria-label', 'Open Snapshot AI account');
      pill.innerHTML = `
        <span class="avatar ${session ? '' : 'guest'}">${session ? emailInitial(email) : '?'}</span>
        <span class="pill-text">
          <span class="pill-line1">${session ? escape(email) : 'Snapshot AI'}</span>
          <span class="pill-line2 ${premium ? 'is-premium' : ''}">${premium ? '★ Premium' : session ? 'Free plan' : 'Sign in'}</span>
        </span>
      `;
      pill.addEventListener('click', () => {
        state.expanded = true;
        render();
      });
      root.appendChild(pill);
      if (state.flash) {
        const f = document.createElement('div');
        f.className = 'flash';
        f.textContent = state.flash;
        root.appendChild(f);
      }
      return;
    }

    // Expanded state.
    root.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'card';
    const head = `
      <div class="card-head">
        <div class="brand">
          <span class="brand-dot"></span>
          <span class="brand-name">Snapshot AI</span>
        </div>
        <button class="x" aria-label="Close" data-action="close">×</button>
      </div>
      <div class="tabs">
        <button class="tab ${state.view === 'main' ? 'on' : ''}" data-action="view-main">Account</button>
        <button class="tab ${state.view === 'ask' ? 'on' : ''}" data-action="view-ask">Ask</button>
        <button class="tab ${state.view === 'image' ? 'on' : ''}" data-action="view-image">Image</button>
        <button class="tab ${state.view === 'upscale' ? 'on' : ''}" data-action="view-upscale">Upscale</button>
      </div>
    `;
    let body: string;
    if (state.view === 'main') {
      body = `
        <div class="acct">
          <span class="avatar lg ${session ? '' : 'guest'}">${session ? emailInitial(email) : '?'}</span>
          <div class="acct-text">
            <div class="acct-line1">${session ? escape(email) : 'Not signed in'}</div>
            <div class="acct-line2 ${premium ? 'is-premium' : ''}">${
              premium ? '★ Premium subscription' : session ? 'Free plan' : 'Sync across devices'
            }</div>
          </div>
        </div>
        <div class="row">
          ${
            !session
              ? `<button class="btn primary" data-action="sign-in">Sign in</button>
                 <button class="btn ghost" data-action="open">See plans</button>`
              : premium
                ? `<button class="btn ghost" data-action="renew">Manage / Renew</button>
                   <button class="btn ghost" data-action="sign-out">Sign out</button>`
                : `<button class="btn primary" data-action="open">Upgrade</button>
                   <button class="btn ghost" data-action="sign-out">Sign out</button>`
          }
        </div>
        <div class="hint">${
          premium
            ? 'All premium features unlocked on this device.'
            : session
              ? 'Open paywall to upgrade.'
              : 'Sign in to restore an existing subscription.'
        }</div>
        ${
          session && state.balances && state.balances.length > 0
            ? `<div class="balances">
                ${state.balances
                  .map(
                    (b) =>
                      `<div class="bal"><span class="bal-c">${b.count}</span><span class="bal-t">${escape(b.type)}</span></div>`
                  )
                  .join('')}
              </div>`
            : ''
        }
      `;
    } else if (state.view === 'ask') {
      body = `
        <textarea class="ai-input" data-action="ask-prompt" rows="3" placeholder="Ask DeepSeek anything…" ${
          state.askBusy ? 'disabled' : ''
        }>${escape(state.askPrompt)}</textarea>
        <div class="row">
          <button class="btn primary" data-action="ask-send" ${
            state.askBusy ? 'disabled' : ''
          }>${state.askBusy ? 'Sending…' : 'Send (provider 1)'}</button>
        </div>
        ${state.askResponse ? `<div class="ai-response">${escape(state.askResponse)}</div>` : ''}
        ${state.askError ? `<div class="ai-error">${escape(state.askError)}</div>` : ''}
        <div class="hint">api-gateway/1 · DeepSeek · 402 → paywall</div>
      `;
    } else if (state.view === 'image') {
      body = `
        <textarea class="ai-input" data-action="image-prompt" rows="2" placeholder="Describe an image…" ${
          state.imageBusy ? 'disabled' : ''
        }>${escape(state.imagePrompt)}</textarea>
        <div class="row">
          <button class="btn primary" data-action="image-send" ${
            state.imageBusy ? 'disabled' : ''
          }>${state.imageBusy ? 'Generating…' : 'Generate (provider 2)'}</button>
        </div>
        ${state.imageUrl ? `<a class="ai-image-wrap" href="${state.imageUrl}" target="_blank" rel="noopener"><img class="ai-image" src="${state.imageUrl}" alt="Generated"></a>` : ''}
        ${state.imageError ? `<div class="ai-error">${escape(state.imageError)}</div>` : ''}
        <div class="hint">api-gateway/2 · Replicate Imagen-4 · может занять 10-60с</div>
      `;
    } else {
      body = `
        <input type="file" accept="image/*" class="ai-file" data-action="upscale-file" ${
          state.upscaleBusy ? 'disabled' : ''
        } />
        ${state.upscaleInputName ? `<div class="hint">${escape(state.upscaleInputName)}</div>` : ''}
        ${state.upscaleInputDataUrl && !state.upscaleOutputUrl
          ? `<div class="ai-image-wrap"><img class="ai-image" src="${state.upscaleInputDataUrl}" alt="Input"></div>`
          : ''}
        <div class="row">
          <button class="btn primary" data-action="upscale-send" ${
            state.upscaleBusy || !state.upscaleInputDataUrl ? 'disabled' : ''
          }>${state.upscaleBusy ? 'Upscaling…' : 'Upscale 2× (provider 3)'}</button>
        </div>
        ${state.upscaleOutputUrl ? `<a class="ai-image-wrap" href="${state.upscaleOutputUrl}" target="_blank" rel="noopener"><img class="ai-image" src="${state.upscaleOutputUrl}" alt="Upscaled"></a>` : ''}
        ${state.upscaleError ? `<div class="ai-error">${escape(state.upscaleError)}</div>` : ''}
        <div class="hint">api-gateway/3 · Clarity Upscaler · может занять 30-90с</div>
      `;
    }
    card.innerHTML = head + body;
    root.appendChild(card);

    if (state.flash) {
      const f = document.createElement('div');
      f.className = 'flash';
      f.textContent = state.flash;
      root.appendChild(f);
    }

    card.querySelectorAll<HTMLElement>('[data-action]').forEach((node) => {
      const action = node.getAttribute('data-action');
      // Input/textarea — пишем напрямую в state без render'а (не теряем
      // caret position на каждом keystroke).
      if (action === 'ask-prompt') {
        // НЕ ре-рендерим на каждый keystroke — иначе caret position теряется
        // в textarea (innerHTML re-mount). Сохраняем в state, кнопка проверит
        // prompt при click'е.
        node.addEventListener('input', (e) => {
          state.askPrompt = (e.currentTarget as HTMLTextAreaElement).value;
        });
        node.addEventListener('keydown', (e) => {
          const ke = e as KeyboardEvent;
          if (ke.key === 'Enter' && (ke.metaKey || ke.ctrlKey)) {
            e.preventDefault();
            void runAsk();
          }
        });
        return;
      }
      if (action === 'image-prompt') {
        node.addEventListener('input', (e) => {
          state.imagePrompt = (e.currentTarget as HTMLTextAreaElement).value;
        });
        node.addEventListener('keydown', (e) => {
          const ke = e as KeyboardEvent;
          if (ke.key === 'Enter' && (ke.metaKey || ke.ctrlKey)) {
            e.preventDefault();
            void runImage();
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
      node.addEventListener('click', () => {
        if (action === 'close') {
          state.expanded = false;
          render();
        } else if (action === 'sign-in') {
          paywall.openAuth();
        } else if (action === 'sign-out') {
          void paywall.auth?.signOut();
        } else if (action === 'open') {
          paywall.open();
        } else if (action === 'renew') {
          paywall.open({ renew: true });
        } else if (action === 'view-main') {
          state.view = 'main';
          render();
        } else if (action === 'view-ask') {
          state.view = 'ask';
          render();
        } else if (action === 'view-image') {
          state.view = 'image';
          render();
        } else if (action === 'view-upscale') {
          state.view = 'upscale';
          render();
        } else if (action === 'ask-send') {
          void runAsk();
        } else if (action === 'image-send') {
          void runImage();
        } else if (action === 'upscale-send') {
          void runUpscale();
        }
      });
    });
  }

  render();
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]!));
}

const WIDGET_CSS = `
  :host { all: initial; }
  .wrap {
    font-family: -apple-system, ui-sans-serif, system-ui, 'Segoe UI', sans-serif;
    color: #0f172a;
    font-size: 13px;
    line-height: 1.4;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
  }
  * { box-sizing: border-box; }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px 6px 6px;
    background: #fff;
    border: 1px solid rgba(15, 23, 42, 0.1);
    border-radius: 999px;
    box-shadow: 0 4px 14px -4px rgba(15, 23, 42, 0.18), 0 1px 2px rgba(15, 23, 42, 0.04);
    cursor: pointer;
    font: inherit;
    color: inherit;
    transition: all 160ms ease;
  }
  .pill:hover { transform: translateY(-1px); box-shadow: 0 8px 20px -4px rgba(15, 23, 42, 0.22), 0 2px 4px rgba(15, 23, 42, 0.06); }

  .avatar {
    width: 26px; height: 26px;
    border-radius: 50%;
    background: linear-gradient(135deg, #a855f7, #6366f1);
    color: #fff;
    display: inline-flex; align-items: center; justify-content: center;
    font-weight: 600; font-size: 11px;
    flex-shrink: 0;
  }
  .avatar.guest { background: #e2e8f0; color: #94a3b8; }
  .avatar.lg { width: 36px; height: 36px; font-size: 14px; }

  .pill-text { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.2; }
  .pill-line1 { font-weight: 600; font-size: 12px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill-line2 { font-size: 10px; color: #64748b; margin-top: 1px; }
  .pill-line2.is-premium { color: #6d28d9; font-weight: 600; }

  .card {
    width: 280px;
    padding: 14px;
    background: #fff;
    border: 1px solid rgba(15, 23, 42, 0.1);
    border-radius: 14px;
    box-shadow: 0 12px 32px -8px rgba(15, 23, 42, 0.22), 0 2px 4px rgba(15, 23, 42, 0.06);
    animation: slide-up 180ms ease-out;
  }
  @keyframes slide-up {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }

  .card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .tabs {
    display: flex; gap: 4px; padding: 2px;
    background: rgba(15, 23, 42, 0.04);
    border-radius: 8px;
    margin-bottom: 12px;
  }
  .tab {
    flex: 1;
    padding: 6px 8px;
    border: 0;
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    color: #64748b;
    border-radius: 6px;
    transition: all 120ms ease;
  }
  .tab:hover { color: #0f172a; }
  .tab.on {
    background: #fff;
    color: #0f172a;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
  }

  .ai-input {
    width: 100%;
    font: inherit;
    font-size: 12px;
    padding: 8px 10px;
    border: 1px solid rgba(15, 23, 42, 0.12);
    border-radius: 8px;
    resize: vertical;
    background: #fff;
    box-sizing: border-box;
    margin-bottom: 8px;
  }
  .ai-input:focus { outline: none; border-color: #7c3aed; box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.15); }
  .ai-response {
    margin-top: 10px;
    padding: 10px 12px;
    background: rgba(124, 58, 237, 0.08);
    border-radius: 8px;
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    max-height: 160px;
    overflow-y: auto;
  }
  .ai-error {
    margin-top: 10px;
    padding: 8px 10px;
    background: rgba(220, 38, 38, 0.08);
    color: #b91c1c;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 500;
  }
  .ai-image-wrap {
    display: block;
    margin-top: 10px;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid rgba(15, 23, 42, 0.08);
  }
  .ai-image {
    display: block;
    width: 100%;
    height: auto;
    max-height: 240px;
    object-fit: contain;
    background: #f8fafc;
  }
  .ai-file {
    display: block;
    width: 100%;
    font-size: 11px;
    color: #64748b;
    margin-bottom: 8px;
  }

  .balances {
    display: flex; gap: 6px; flex-wrap: wrap;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid rgba(15, 23, 42, 0.06);
  }
  .bal {
    flex: 1; min-width: 70px;
    padding: 6px 8px;
    background: rgba(124, 58, 237, 0.08);
    border-radius: 8px;
    text-align: center;
  }
  .bal-c {
    display: block;
    font-size: 14px;
    font-weight: 700;
    color: #6d28d9;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .bal-t {
    display: block;
    margin-top: 2px;
    font-size: 9px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .brand { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px; }
  .brand-dot { width: 8px; height: 8px; border-radius: 50%; background: linear-gradient(135deg, #a855f7, #6366f1); }
  .brand-name { letter-spacing: -0.01em; }
  .x {
    width: 22px; height: 22px;
    border: 0; background: transparent; cursor: pointer;
    color: #94a3b8;
    font-size: 18px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 6px;
    line-height: 1;
  }
  .x:hover { background: #f1f5f9; color: #475569; }

  .acct { display: flex; align-items: center; gap: 10px; padding: 8px 0 12px; }
  .acct-text { flex: 1; min-width: 0; }
  .acct-line1 { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acct-line2 { font-size: 11px; color: #64748b; margin-top: 2px; }
  .acct-line2.is-premium { color: #6d28d9; font-weight: 600; }

  .row { display: flex; gap: 6px; margin-top: 4px; }
  .btn {
    flex: 1;
    padding: 8px 10px;
    border-radius: 8px;
    border: 0;
    font: inherit;
    font-weight: 600;
    font-size: 12px;
    cursor: pointer;
    transition: all 120ms ease;
  }
  .btn.primary {
    background: #7c3aed;
    color: #fff;
  }
  .btn.primary:hover { background: #6d28d9; }
  .btn.ghost {
    background: transparent;
    color: #0f172a;
    border: 1px solid rgba(15, 23, 42, 0.12);
  }
  .btn.ghost:hover { background: #f8fafc; }

  .hint {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid rgba(15, 23, 42, 0.06);
    font-size: 11px;
    color: #64748b;
    line-height: 1.4;
  }

  .flash {
    align-self: flex-end;
    padding: 6px 10px;
    background: #0f172a;
    color: #fff;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 500;
    box-shadow: 0 4px 12px -2px rgba(15, 23, 42, 0.3);
    animation: flash-in 160ms ease-out;
  }
  @keyframes flash-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: none; }
  }
`;
