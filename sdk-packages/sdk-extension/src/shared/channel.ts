// Abstraction of a duplex channel between two runtimes. Real implementations —
// chrome.runtime.Port (extension), MessageChannel (in tests, to verify logic
// without a browser). The transport knows nothing about chrome.* — all it needs
// is `send / onMessage / onDisconnect`.

import type { Envelope } from './protocol';

export interface MessageChannel {
  send(envelope: Envelope): void;
  /** Returns an unsubscribe function. Multiple subscriptions are allowed. */
  onMessage(cb: (envelope: Envelope) => void): () => void;
  /** Fires once — after disconnect the channel is considered dead. */
  onDisconnect(cb: () => void): () => void;
  /** Close the channel from this side. */
  close(): void;
}

/** Channel factory — needed for reconnect: on disconnect TransportClient calls
 *  the factory again and gets a fresh channel. */
export type ChannelFactory = () => MessageChannel;
