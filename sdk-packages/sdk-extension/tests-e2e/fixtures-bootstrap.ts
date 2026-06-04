// Realistic bootstrap fixture for e2e and integration tests. Mirrors the
// shape that actually comes from the prod paywall (id=3 Stripe-test),
// so tests exercise the same code-paths as a real user.

export interface RealisticBootstrapOptions {
  withTrial?: boolean;
  withAuthPanel?: boolean;
  withCurrentSession?: boolean;
  visibility?: { visible: boolean; reason?: string; country?: string; tier?: number } | null;
  user?: {
    has_active_subscription: boolean;
    purchases?: Array<{ id: string; status: string }>;
    trial?: null;
  } | null;
}

export function buildRealisticBootstrap(opts: RealisticBootstrapOptions = {}): unknown {
  const blocks: unknown[] = [
    { type: 'heading', text: 'Get a plan to continue using our service', level: 2 },
    {
      type: 'price_grid',
      // Minimal for rendering.
      groups: [
        { id: 'monthly', label: 'per month' },
        { id: 'yearly', label: 'per year' }
      ]
    }
  ];

  if (opts.withCurrentSession) {
    // This block renders the Restore purchases / Contact Support links.
    blocks.push({ type: 'current_session' });
  }
  if (opts.withAuthPanel) {
    blocks.push({
      type: 'auth_panel',
      heading: 'Sign in',
      allow_signup: true,
      allow_password_reset: true,
      hide_when_authenticated: true
    });
  }

  return {
    settings: {
      id: 'demo',
      name: 'Demo Paywall',
      brand_color: '#7c3aed',
      is_test_mode: true,
      checkout_mode: 'guest',
      allow_close: true,
      ...(opts.withTrial
        ? { trial: { mode: 'opens', payload: 3, storage: 'client' } }
        : {}),
      ...(opts.visibility !== undefined ? { visibility: opts.visibility } : {})
    },
    prices: [
      {
        id: '101',
        currency: 'EUR',
        amount: 5.99,
        interval: 'month',
        interval_count: 1,
        trial_days: null,
        label: 'per month'
      },
      {
        id: '102',
        currency: 'USD',
        amount: 60,
        interval: 'year',
        interval_count: 1,
        trial_days: null,
        label: 'per year'
      },
      {
        id: '103',
        currency: 'EUR',
        amount: 35.88,
        interval: 'lifetime',
        interval_count: null,
        trial_days: null,
        label: 'one-time'
      }
    ],
    offers: [],
    layout: { type: 'modal', blocks },
    user: opts.user ?? null
  };
}
