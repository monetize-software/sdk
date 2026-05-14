import { PaywallUI } from '../../../src';
import type { PaywallBootstrap } from '../../../src/core/types';

// Детерминированный моки бэка — e2e тесты не зависят от сети.
const bootstrap: PaywallBootstrap = {
  settings: {
    id: 'ext_test',
    name: 'Upgrade to Pro',
    brand_color: '#7c3aed'
  },
  prices: [
    {
      id: 'monthly',
      currency: 'USD',
      amount: 9.99,
      interval: 'month',
      interval_count: 1,
      trial_days: 7,
      label: null,
      description: null,
      local: null
    },
    {
      id: 'yearly',
      currency: 'USD',
      amount: 79,
      interval: 'year',
      interval_count: 1,
      trial_days: null,
      label: null,
      description: null,
      local: null
    }
  ],
  offers: [],
  layout: {
    type: 'modal',
    blocks: [
      { type: 'heading', text: 'Upgrade to Pro', level: 1 },
      { type: 'price_grid', priceIds: ['monthly', 'yearly'] },
      { type: 'cta_button', label: 'Continue', action: 'checkout' }
    ]
  }
};

const mockFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : (input as Request).url ?? (input as URL).toString();
  if (url.endsWith('/bootstrap')) {
    return new Response(JSON.stringify(bootstrap), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
  if (url.endsWith('/start-checkout')) {
    return new Response(
      JSON.stringify({ url: 'https://example.com/mock-checkout', sessionId: 'mock' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }
  return new Response('not found', { status: 404 });
};

const paywall = new PaywallUI({
  paywallId: 'ext_test',
  apiOrigin: 'https://example.com',
  identity: { email: 'ext@test' },
  fetch: mockFetch
});

// Экспонируем инстанс для Playwright-тестов через page.evaluate.
// В popup-странице page-world и extension-world совпадают (нет content script boundary),
// так что window.__paywall доступен напрямую из evaluate.
(globalThis as unknown as { __paywall: PaywallUI }).__paywall = paywall;

const log = document.getElementById('log');
const append = (line: string) => {
  if (log) log.textContent = `${line}\n${log.textContent ?? ''}`;
};

const EVENTS = [
  'open',
  'close',
  'ready',
  'error',
  'price_selected',
  'checkout_started',
  'purchase_completed',
  'purchase_failed'
] as const;

for (const event of EVENTS) {
  paywall.on(event, (payload) =>
    append(`${event}${payload !== undefined ? ' ' + JSON.stringify(payload, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v)) : ''}`)
  );
}

document.getElementById('open')?.addEventListener('click', () => paywall.open());
document.getElementById('close')?.addEventListener('click', () => paywall.close());
