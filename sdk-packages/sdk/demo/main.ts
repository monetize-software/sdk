import { PaywallUI } from '../src';
import type { PaywallOffer, PaywallPrice, PaywallSettings } from '../src/core/types';

// Режимы демо:
//   ?mock — захардкоженные ответы, без сети
//   (default) — реальный бэк через Vite proxy (/api/* → VITE_API_TARGET)
const params = new URLSearchParams(location.search);
const USE_MOCK = params.has('mock');
// Дефолт `3` — тестовый пейвол со Stripe (acquiring.mode=test) в тест-БД.
// Подменяется через ?id=<paywall_id>. e2e открывают:
//   ?id=3 — Stripe тест-пейвол
//   ?id=4 — Paddle тест-пейвол
//   ?id=5 — Freemius тест-пейвол
// Реальные продакшн-пейволы в demo не трогаем, чтобы не создать настоящий платёж.
const PAYWALL_ID = params.get('id') ?? '3';

const mockSettings: PaywallSettings = {
  id: 'demo',
  name: 'Upgrade to Pro',
  brand_color: '#7c3aed'
};

const mockPrices: PaywallPrice[] = [
  {
    id: 'monthly',
    currency: 'USD',
    amount: 9.99,
    interval: 'month',
    interval_count: 1,
    trial_days: 7,
    label: 'Monthly',
    description: 'Billed every month'
  },
  {
    id: 'yearly',
    currency: 'USD',
    amount: 79,
    interval: 'year',
    interval_count: 1,
    trial_days: null,
    label: 'Yearly',
    description: 'Save 34%'
  },
  {
    id: 'lifetime',
    currency: 'USD',
    amount: 199,
    interval: 'lifetime',
    interval_count: null,
    trial_days: null,
    label: 'Lifetime'
  }
];

const mockOffers: PaywallOffer[] = [];

const mockFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : (input as Request).url ?? (input as URL).toString();
  await new Promise((r) => setTimeout(r, 300));

  if (url.endsWith('/settings')) {
    return new Response(JSON.stringify(mockSettings), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
  if (url.endsWith('/prices')) {
    return new Response(JSON.stringify(mockPrices), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
  if (url.endsWith('/offers')) {
    return new Response(JSON.stringify(mockOffers), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
  if (url.endsWith('/start-checkout')) {
    return new Response(
      JSON.stringify({ url: 'https://example.com/mock-checkout', sessionId: 'mock_session' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  return new Response('not found', { status: 404 });
};

const log = document.getElementById('log')!;
const append = (event: string, payload?: unknown) => {
  const line = `${event}${payload !== undefined ? ' ' + JSON.stringify(payload, safeReplacer) : ''}`;
  log.textContent = `${line}\n${log.textContent}`;
};

function safeReplacer(_key: string, value: unknown) {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

append(USE_MOCK ? 'mode: mock' : `mode: real backend (paywall ${PAYWALL_ID})`);

const paywall = new PaywallUI({
  paywallId: PAYWALL_ID,
  // mock-режим — фейковый origin (никаких сетевых запросов, всё mockFetch).
  // real-режим — location.origin, Vite проксирует /api/* на VITE_API_TARGET
  // (по умолчанию local online, e2e Playwright форсит dev-staging).
  apiOrigin: USE_MOCK ? 'https://demo.local' : location.origin,
  // В mock-режиме identity жёстко задаём (auth-эндпоинты не замоканы);
  // в real-backend режиме включаем managed-auth — для preauth-пейволов
  // SDK сам рисует gate-форму, identity синхронизируется из AuthClient.
  ...(USE_MOCK ? { identity: { email: 'demo@example.com', userId: 'demo-user' } } : { auth: true }),
  // Demo — single-origin, host-страница своя. Open-режим даёт Playwright/DevTools
  // доступ к содержимому модалки; в проде остаётся дефолтный `closed`.
  shadowMode: 'open',
  fetch: USE_MOCK ? mockFetch : undefined
});

// Экспонируем для e2e тестов и ручной консольной отладки.
(window as unknown as { __paywall?: unknown }).__paywall = paywall;

for (const event of [
  'open',
  'close',
  'ready',
  'error',
  'price_selected',
  'checkout_started',
  'purchase_completed',
  'purchase_failed'
] as const) {
  paywall.on(event, (payload) => append(event, payload));
}

document.getElementById('open')!.addEventListener('click', () => paywall.open());
document.getElementById('open-support')!.addEventListener('click', () => paywall.openSupport());
document.getElementById('close')!.addEventListener('click', () => paywall.close());

const hostileStyle = document.getElementById('hostile-css') as HTMLStyleElement | null;
const hostileBtn = document.getElementById('hostile');
const applyHostile = (on: boolean) => {
  if (!hostileStyle) return;
  hostileStyle.media = on ? 'all' : 'not all';
  document.documentElement.toggleAttribute('data-hostile', on);
  const existing = document.querySelector('.z-attack');
  if (on && !existing) {
    const attack = document.createElement('div');
    attack.className = 'z-attack';
    document.body.appendChild(attack);
  } else if (!on && existing) {
    existing.remove();
  }
};
hostileBtn?.addEventListener('click', () => {
  applyHostile(!document.documentElement.hasAttribute('data-hostile'));
});
if (new URLSearchParams(location.search).has('hostile')) applyHostile(true);
