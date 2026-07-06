// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { PaywallUI } from '../src/ui/PaywallUI';
import { PaywallRoot } from '../src/ui/PaywallRoot';
import type { BillingClient } from '../src/core/BillingClient';
import type { LayoutBlock, PaywallBootstrap } from '../src/core/types';

// Custom title override (OpenOptions.title):
// - open({title}) replaces the text of the layout's h1 heading block;
// - a layout without an h1 gets the title prepended as a new heading;
// - the override is scoped to the call — a re-open without `title` shows the
//   configured heading again (no stale override through handle.update);
// - render-level (PaywallRoot.titleOverride) behaves the same for both cases.

const TEST_API_ORIGIN = 'https://test.example.com';

function makeBootstrap(blocks: LayoutBlock[]): PaywallBootstrap {
  return {
    settings: { id: 'pw_1', name: 'Pro' },
    prices: [
      { id: 'price_1', currency: 'USD', amount: 9.99, interval: 'month', interval_count: 1, trial_days: null }
    ],
    offers: [],
    layout: { type: 'modal', blocks }
  };
}

const BLOCKS_WITH_HEADING: LayoutBlock[] = [
  { type: 'heading', text: 'Configured Title', level: 1 },
  { type: 'price_grid', priceIds: ['price_1'] },
  { type: 'cta_button', label: 'Continue', action: 'checkout' }
];

const BLOCKS_WITHOUT_HEADING: LayoutBlock[] = [
  { type: 'price_grid', priceIds: ['price_1'] }
];

async function flush(): Promise<void> {
  // Several macrotask ticks: bootstrap goes fetch → json → storage persist →
  // setState, and a single setTimeout(0) doesn't ride the whole chain out.
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
  });
}

describe('PaywallRoot.titleOverride (render level)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    render(null, container);
    container.remove();
  });

  function mount(bootstrap: PaywallBootstrap, titleOverride: string | null) {
    const client = {
      bootstrap: vi.fn(async () => bootstrap),
      createCheckout: vi.fn()
    } as unknown as BillingClient;
    act(() => {
      render(
        h(PaywallRoot, {
          client,
          open: true,
          onClose: (): void => undefined,
          onEvent: (): void => undefined,
          titleOverride
        }),
        container
      );
    });
  }

  it('replaces the h1 text of the layout heading block', async () => {
    mount(makeBootstrap(BLOCKS_WITH_HEADING), 'Unlock export');
    await flush();
    expect(container.querySelector('h1')?.textContent).toBe('Unlock export');
  });

  it('without an override the configured heading is rendered', async () => {
    mount(makeBootstrap(BLOCKS_WITH_HEADING), null);
    await flush();
    expect(container.querySelector('h1')?.textContent).toBe('Configured Title');
  });

  it('prepends an h1 when the layout has no heading block', async () => {
    mount(makeBootstrap(BLOCKS_WITHOUT_HEADING), 'Projects limit reached');
    await flush();
    expect(container.querySelector('h1')?.textContent).toBe('Projects limit reached');
  });
});

describe('PaywallUI open({title}) end-to-end (shadow mount)', () => {
  let host: HTMLElement;
  let ui: PaywallUI;

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
  });
  afterEach(() => {
    ui?.destroy();
    host.remove();
  });

  function makeUI(bootstrap: PaywallBootstrap): PaywallUI {
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify(bootstrap), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    return new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: fetchFn,
      autoDetectReturn: false,
      analytics: false,
      shadowMode: 'open',
      host
    });
  }

  it('open({title}) shows the custom title; a re-open without it restores the configured one', async () => {
    ui = makeUI(makeBootstrap(BLOCKS_WITH_HEADING));

    ui.open({ title: 'Unlock export' });
    await flush();
    expect(host.shadowRoot!.querySelector('h1')?.textContent).toBe('Unlock export');

    // Scoped to the call: the next open() must not carry the stale override
    // through handle.update.
    ui.close();
    ui.open();
    await flush();
    expect(host.shadowRoot!.querySelector('h1')?.textContent).toBe('Configured Title');
  });

  it('open({title}) on a layout without a heading renders the title as a new h1', async () => {
    ui = makeUI(makeBootstrap(BLOCKS_WITHOUT_HEADING));

    ui.open({ title: 'Projects limit reached' });
    await flush();
    expect(host.shadowRoot!.querySelector('h1')?.textContent).toBe('Projects limit reached');
  });
});
