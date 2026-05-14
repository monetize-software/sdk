import { useState } from 'react';
import {
  PaywallButton,
  PaywallGate,
  PaywallSupportButton,
  usePaywall,
  usePaywallAccess,
  usePaywallEvent,
  usePaywallPrices,
  usePaywallState,
  usePaywallUser
} from '../src';

/**
 * Демо-приложение для @monetize.software/sdk-react. Покрывает всё, что есть в
 * public API — служит и витриной для разработчиков, и тестовым полем для
 * Playwright e2e.
 *
 * Структура — отдельная карточка на каждый хук/компонент, чтобы видно было,
 * что делает каждая часть в изоляции, и можно было кликать поодиночке.
 */
export function App(): JSX.Element {
  return (
    <div className="container">
      <header className="card">
        <h1>@monetize.software/sdk-react</h1>
        <h2>Live demo · все хуки и компоненты</h2>
      </header>

      <ButtonsCard />
      <GateCard />
      <StateCard />
      <UserCard />
      <AccessCard />
      <PricesCard />
      <EventsCard />
    </div>
  );
}

function ButtonsCard(): JSX.Element {
  const paywall = usePaywall();
  return (
    <section className="card">
      <h2>&lt;PaywallButton&gt; / &lt;PaywallSupportButton&gt;</h2>
      <p>
        Декларативные кнопки — `mode` переключает варианты открытия. Render-prop
        для custom-элемента, родной button иначе.
      </p>
      <div className="row">
        <PaywallButton data-testid="open">Open paywall</PaywallButton>
        <PaywallSupportButton data-testid="open-support" className="secondary">
          Open support
        </PaywallSupportButton>
        <button
          className="secondary"
          data-testid="close"
          onClick={() => paywall?.close()}
        >
          Close (via usePaywall)
        </button>
      </div>
    </section>
  );
}

function GateCard(): JSX.Element {
  return (
    <section className="card">
      <h2>&lt;PaywallGate&gt;</h2>
      <p>Декларативный гейт — loading → fallback → children.</p>
      <PaywallGate
        loading={<span className="pill">loading…</span>}
        fallback={({ open }) => (
          <div className="row">
            <span className="pill blocked">blocked</span>
            <button onClick={open} data-testid="gate-upgrade">
              Upgrade to unlock
            </button>
          </div>
        )}
      >
        <div className="row">
          <span className="pill granted">granted</span>
          <span>Премиум-фича открыта.</span>
        </div>
      </PaywallGate>
    </section>
  );
}

function StateCard(): JSX.Element {
  const state = usePaywallState();
  return (
    <section className="card">
      <h2>usePaywallState()</h2>
      <pre data-testid="state">{JSON.stringify(state, null, 2)}</pre>
    </section>
  );
}

function UserCard(): JSX.Element {
  const user = usePaywallUser();
  return (
    <section className="card">
      <h2>usePaywallUser()</h2>
      <pre data-testid="user">{JSON.stringify(user, null, 2)}</pre>
    </section>
  );
}

function AccessCard(): JSX.Element {
  const access = usePaywallAccess();
  return (
    <section className="card">
      <h2>usePaywallAccess()</h2>
      <p>
        Статус:{' '}
        <span
          className={`pill ${access.status === 'ready' ? access.result.access : ''}`}
          data-testid="access-status"
        >
          {access.status === 'loading' ? 'loading' : access.result.access}
        </span>
      </p>
      <pre data-testid="access">{JSON.stringify(access, null, 2)}</pre>
    </section>
  );
}

function PricesCard(): JSX.Element {
  const { prices, loading, error } = usePaywallPrices();
  return (
    <section className="card">
      <h2>usePaywallPrices()</h2>
      {loading && !prices && <span className="pill">loading…</span>}
      {error && <span className="pill blocked">{error.message}</span>}
      {prices && (
        <ul data-testid="prices">
          {prices.map((p) => (
            <li key={p.id}>
              <strong>{p.label}</strong> — ${p.amount} {p.currency}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EventsCard(): JSX.Element {
  const [log, setLog] = useState<string[]>([]);
  const push = (line: string) => setLog((prev) => [line, ...prev].slice(0, 20));

  usePaywallEvent('open', () => push('open'));
  usePaywallEvent('close', () => push('close'));
  usePaywallEvent('ready', (b) =>
    push(`ready · prices=${b.prices.length}`)
  );
  usePaywallEvent('error', (e) => push(`error · ${e.code}`));
  usePaywallEvent('checkout_started', (p) =>
    push(`checkout_started · ${p.priceId}`)
  );
  usePaywallEvent('purchase_completed', (p) =>
    push(`purchase_completed · ${p.priceId ?? '—'}`)
  );

  return (
    <section className="card">
      <h2>usePaywallEvent() — лог</h2>
      <pre data-testid="events-log">{log.join('\n') || '(пока пусто)'}</pre>
    </section>
  );
}
