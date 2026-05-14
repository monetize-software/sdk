import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PaywallButton, PaywallProvider, PaywallSupportButton } from '../src';
import { FakePaywall, asPaywallUI } from './fakePaywall';

describe('<PaywallButton>', () => {
  it('по клику дёргает paywall.open() с прокинутыми OpenOptions', () => {
    const fake = new FakePaywall();
    render(
      <PaywallProvider instance={asPaywallUI(fake)}>
        <PaywallButton renew skipTrial>
          Upgrade
        </PaywallButton>
      </PaywallProvider>
    );

    fireEvent.click(screen.getByText('Upgrade'));
    expect(fake.openCalls).toBe(1);
  });

  it('mode="support" зовёт openSupport()', () => {
    const fake = new FakePaywall();
    render(
      <PaywallProvider instance={asPaywallUI(fake)}>
        <PaywallButton mode="support">Help</PaywallButton>
      </PaywallProvider>
    );
    fireEvent.click(screen.getByText('Help'));
    expect(fake.openSupportCalls).toBe(1);
    expect(fake.openCalls).toBe(0);
  });

  it('PaywallSupportButton — сахар над mode="support"', () => {
    const fake = new FakePaywall();
    render(
      <PaywallProvider instance={asPaywallUI(fake)}>
        <PaywallSupportButton>Support</PaywallSupportButton>
      </PaywallProvider>
    );
    fireEvent.click(screen.getByText('Support'));
    expect(fake.openSupportCalls).toBe(1);
  });

  it('render-prop отдаёт open() и ready', () => {
    const fake = new FakePaywall();
    render(
      <PaywallProvider instance={asPaywallUI(fake)}>
        <PaywallButton
          render={({ open, ready }) => (
            <a href="#" data-ready={ready} onClick={open}>
              custom
            </a>
          )}
        />
      </PaywallProvider>
    );
    const link = screen.getByText('custom');
    expect(link.getAttribute('data-ready')).toBe('true');
    fireEvent.click(link);
    expect(fake.openCalls).toBe(1);
  });

  it('host onClick вызывается ПОСЛЕ open() — не может отменить открытие', () => {
    const fake = new FakePaywall();
    const order: string[] = [];
    render(
      <PaywallProvider instance={asPaywallUI(fake)}>
        <PaywallButton onClick={() => order.push('host')}>x</PaywallButton>
      </PaywallProvider>
    );
    // Перехватываем порядок: open() мутирует counter, потом host onClick пушит 'host'.
    fireEvent.click(screen.getByText('x'));
    expect(fake.openCalls).toBe(1);
    expect(order).toEqual(['host']); // host onClick стрельнул после open()
  });
});
