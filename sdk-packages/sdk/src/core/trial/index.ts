import type { StorageAdapter } from '../storage';
import type { TrialConfig } from '../types';
import { LocalTrialStore } from './LocalTrialStore';
import { ServerTrialStore } from './ServerTrialStore';
import type { TrialStore } from './TrialStore';

export type { TrialStore } from './TrialStore';
export { LocalTrialStore } from './LocalTrialStore';
export { ServerTrialStore } from './ServerTrialStore';

/** Resolves the TrialStore implementation by `settings.trial.storage` from
 *  bootstrap. A null/undefined config — the caller must check for it itself
 *  and not call the factory (trial disabled → the store isn't needed at all). */
export function createTrialStore(
  storage: StorageAdapter,
  paywallId: string,
  config: TrialConfig
): TrialStore {
  if (config.storage === 'server') {
    return new ServerTrialStore(storage, paywallId, config);
  }
  return new LocalTrialStore(storage, paywallId, config);
}
