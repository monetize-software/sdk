import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { PaywallAccessResult, PaywallUser } from '../src';
import { PaywallGate, PaywallProvider } from '../src';
import { FakePaywall, asPaywallUI } from './fakePaywall';

const BLOCKED: PaywallAccessResult = {
  access: 'blocked',
  reason: 'no_subscription',
  visibility: null,
  trial: null,
  user: null
};

const GRANTED: PaywallAccessResult = {
  access: 'granted',
  reason: 'has_subscription',
  visibility: null,
  trial: null,
  user: { user_id: 'u1' } as unknown as PaywallUser
};

describe('<PaywallGate>', () => {
  it('loading → fallback на blocked → children на granted', async () => {
    const fake = new FakePaywall({ initialAccess: BLOCKED });

    const { rerender } = render(
      <PaywallProvider instance={asPaywallUI(fake)}>
        <PaywallGate
          loading={<span>loading…</span>}
          fallback={<span>blocked</span>}
        >
          <span>granted</span>
        </PaywallGate>
      </PaywallProvider>
    );

    expect(screen.getByText('loading…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('blocked')).toBeInTheDocument());

    fake.setAccess(GRANTED);
    act(() => {
      fake.emit('userChange', {});
    });

    await waitFor(() => expect(screen.getByText('granted')).toBeInTheDocument());

    rerender(
      <PaywallProvider instance={asPaywallUI(fake)}>
        <PaywallGate
          loading={<span>loading…</span>}
          fallback={<span>blocked</span>}
        >
          <span>granted</span>
        </PaywallGate>
      </PaywallProvider>
    );
    expect(screen.getByText('granted')).toBeInTheDocument();
  });

  it('openOnBlocked={true} автоматически дёргает paywall.open()', async () => {
    const fake = new FakePaywall({ initialAccess: BLOCKED });
    render(
      <PaywallProvider instance={asPaywallUI(fake)}>
        <PaywallGate openOnBlocked fallback={<span>blocked</span>}>
          <span>granted</span>
        </PaywallGate>
      </PaywallProvider>
    );

    await waitFor(() => expect(fake.openCalls).toBe(1));
  });

  it('render-prop fallback получает open()-callback', async () => {
    const fake = new FakePaywall({ initialAccess: BLOCKED });
    render(
      <PaywallProvider instance={asPaywallUI(fake)}>
        <PaywallGate
          fallback={({ open }) => (
            <button onClick={open}>open from fallback</button>
          )}
        >
          <span>granted</span>
        </PaywallGate>
      </PaywallProvider>
    );

    const btn = await screen.findByText('open from fallback');
    btn.click();
    expect(fake.openCalls).toBe(1);
  });
});
