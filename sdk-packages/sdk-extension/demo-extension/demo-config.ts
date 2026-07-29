// Demo configuration — deliberately WITHOUT defaults.
//
// `apiOrigin` is your paywall's `custom_domain`, and the SDK requires it
// explicitly (see BillingClient: no fallback origin, `invalid_config` when it is
// missing or disagrees with bootstrap). A default here would defeat that: a
// misconfigured integration would quietly talk to somebody else's host and only
// surface at checkout, in production. Fail loudly at startup instead.
//
// Set both values once, from any extension context's console:
//
//   chrome.storage.local.set({
//     __demo_paywall_id: '123',
//     __demo_api_origin: 'https://pay.your-domain.com'
//   })

export interface DemoConfig {
  paywallId: string;
  apiOrigin: string;
}

export const DEMO_CONFIG_HINT =
  'Demo not configured. Run in an extension console:\n' +
  "chrome.storage.local.set({ __demo_paywall_id: '<paywall id>', " +
  "__demo_api_origin: 'https://<your custom domain>' })";

/** Config from chrome.storage, or null when either half is missing. */
export async function readDemoConfig(): Promise<DemoConfig | null> {
  const cfg = (await chrome.storage.local.get([
    '__demo_paywall_id',
    '__demo_api_origin'
  ])) as { __demo_paywall_id?: string; __demo_api_origin?: string };

  const paywallId = cfg.__demo_paywall_id?.trim();
  // Trailing slashes would turn every request path into a double slash.
  const apiOrigin = cfg.__demo_api_origin?.trim().replace(/\/+$/, '');
  if (!paywallId || !apiOrigin) return null;
  return { paywallId, apiOrigin };
}
