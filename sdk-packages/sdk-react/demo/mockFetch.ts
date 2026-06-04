// The demo uses the same trick as sdk/demo: hardcoded responses instead of
// real network requests. Without a backend you can test all the hooks and
// components, and the Playwright e2e tests run offline.

interface MockPrice {
  id: string;
  currency: string;
  amount: number;
  interval: string;
  interval_count: number | null;
  trial_days: number | null;
  label: string;
  description?: string;
}

const mockSettings = {
  id: 'demo',
  name: 'Upgrade to Pro',
  brand_color: '#7c3aed'
};

const mockPrices: MockPrice[] = [
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
  }
];

interface MockBootstrap {
  settings: typeof mockSettings;
  prices: MockPrice[];
  offers: unknown[];
  user?: unknown;
}

const bootstrap: MockBootstrap = {
  settings: mockSettings,
  prices: mockPrices,
  offers: []
};

export const mockFetch: typeof fetch = async (input) => {
  const url =
    typeof input === 'string'
      ? input
      : (input as Request).url ?? (input as URL).toString();
  await new Promise((r) => setTimeout(r, 200));

  // SDK 3 hits a single /bootstrap; the old /settings|/prices|/offers are
  // kept for compatibility with tests that mock the endpoints
  // individually.
  if (url.includes('/bootstrap')) return json(bootstrap);
  if (url.endsWith('/settings')) return json(mockSettings);
  if (url.endsWith('/prices')) return json(mockPrices);
  if (url.endsWith('/offers')) return json([]);
  if (url.endsWith('/start-checkout')) {
    return json({
      url: 'https://example.com/mock-checkout',
      sessionId: 'mock_session'
    });
  }

  return new Response('not found', { status: 404 });
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
