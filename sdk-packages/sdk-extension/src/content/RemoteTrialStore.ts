// RemoteTrialStore — a TrialStore-compatible proxy. check / recordBlock / reset
// go through transport to offscreen, where the real TrialStore runs under
// navigator.locks — two tabs can't read-modify-write the same counter
// simultaneously, so there's no drift.

import type { TrialStore } from '@sdk/core/trial';
import type { TrialConfig, TrialStatus } from '@sdk/core/types';
import type { TransportClient } from '../shared/transport-client';

export class RemoteTrialStore implements TrialStore {
  constructor(
    private readonly transport: TransportClient,
    private readonly paywallId: string,
    private readonly config: TrialConfig
  ) {}

  async check(): Promise<TrialStatus> {
    return this.transport.request('trial.check', {
      paywallId: this.paywallId,
      config: this.config
    });
  }

  async recordBlock(): Promise<TrialStatus> {
    return this.transport.request('trial.recordBlock', {
      paywallId: this.paywallId,
      config: this.config
    });
  }

  async reset(): Promise<void> {
    await this.transport.request('trial.reset', {
      paywallId: this.paywallId,
      config: this.config
    });
  }
}
