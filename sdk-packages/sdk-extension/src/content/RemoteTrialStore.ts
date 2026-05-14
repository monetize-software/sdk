// RemoteTrialStore — TrialStore-совместимый proxy. check / recordBlock /
// reset идут через transport в offscreen, где реальный TrialStore работает
// под navigator.locks — два таба не могут одновременно read-modify-write
// один и тот же counter, drift'а нет.

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
