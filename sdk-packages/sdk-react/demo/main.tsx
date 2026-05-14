import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PaywallProvider } from '../src';
import { App } from './App';
import { mockFetch } from './mockFetch';

const PAYWALL_ID =
  new URLSearchParams(location.search).get('id') ?? 'demo';

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <PaywallProvider
      options={{
        paywallId: PAYWALL_ID,
        apiOrigin: 'https://demo.local',
        identity: { email: 'demo@example.com', userId: 'demo-user' },
        // Open shadowMode для Playwright — он не сможет читать содержимое
        // closed shadow root. В проде у хостов остаётся default `closed`.
        shadowMode: 'open',
        fetch: mockFetch
      }}
    >
      <App />
    </PaywallProvider>
  </StrictMode>
);
