// Offscreen page entry. Owns the real BillingClient (and in Phase 4+ —
// AuthClient, EventTracker) — the single source of truth for the whole
// extension.
//
// Imported in `offscreen.html`:
//   <script type="module">
//     import { startOffscreenServer } from '@monetize.software/sdk-extension/offscreen';
//     startOffscreenServer({ paywallId: '123', apiOrigin: 'https://...' });
//   </script>

import { OffscreenServer } from './server';

export interface OffscreenServerOptions {
  paywallId: string;
  apiOrigin?: string;
  /** If true — the offscreen-server creates its own AuthClient and connects it
   *  to BillingClient for Bearer authorization. The session is stored in the
   *  offscreen localStorage and shared across all surfaces of the extension via
   *  the authChange broadcast. */
  auth?: boolean;
  /** Analytics. Enabled by default; pass false to disable entirely. An object —
   *  custom parameters (endpoint, batch). There's one EventTracker per
   *  extension, all content track() calls are forwarded to it. */
  analytics?:
    | boolean
    | {
        endpoint?: string;
        flushIntervalMs?: number;
        maxBufferSize?: number;
      };
}

let active: OffscreenServer | null = null;

export function startOffscreenServer(opts: OffscreenServerOptions): OffscreenServer {
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    throw new Error('@monetize.software/sdk-extension/offscreen requires chrome.runtime');
  }
  if (active) {
    // Double start — can happen if the host loads the offscreen-bootstrap twice
    // (HMR in dev, or a bug with a duplicate <script>). We return the existing
    // instance — re-creating would register a second listener on runtime.onConnect.
    return active;
  }
  active = new OffscreenServer(opts);
  active.start();
  return active;
}

export type { OffscreenServer };
