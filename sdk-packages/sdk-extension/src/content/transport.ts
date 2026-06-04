// Content-side singleton TransportClient. One per content-script, reused by all
// PaywallUI instances on the same page (usually one per page, but several are
// technically possible — e.g. one paywall in an overlay, another in the host
// extension's popup, both inside the content-script of the same page).

import { TransportClient } from '../shared/transport-client';
import { createRuntimeChannel } from '../shared/chrome-port';
import { PORT_NAME } from '../shared/port-name';

let cached: TransportClient | null = null;

export function getContentTransport(): TransportClient {
  if (cached) return cached;
  cached = new TransportClient(() => createRuntimeChannel(PORT_NAME));
  return cached;
}

/** Test injection — for unit tests of RemoteBillingClient with a fake channel
 *  (without chrome.runtime). Not used in production. */
export function _setContentTransportForTests(client: TransportClient | null): void {
  cached = client;
}
