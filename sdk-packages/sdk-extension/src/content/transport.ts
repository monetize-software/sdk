// Content-side singleton TransportClient. Один на content-script, переиспользуется
// всеми инстансами PaywallUI на одной странице (на странице обычно один, но
// несколько технически возможны — например один пейвол в overlay'е, другой
// в popup'е host-расширения, оба внутри content-script'а одной страницы).

import { TransportClient } from '../shared/transport-client';
import { createRuntimeChannel } from '../shared/chrome-port';
import { PORT_NAME } from '../shared/port-name';

let cached: TransportClient | null = null;

export function getContentTransport(): TransportClient {
  if (cached) return cached;
  cached = new TransportClient(() => createRuntimeChannel(PORT_NAME));
  return cached;
}

/** Тестовая инжекция — для unit-тестов RemoteBillingClient'а с фейковым
 *  каналом (без chrome.runtime). В проде не используется. */
export function _setContentTransportForTests(client: TransportClient | null): void {
  cached = client;
}
