import type { StorageAdapter } from '../storage';
import type { TrialConfig } from '../types';
import { LocalTrialStore } from './LocalTrialStore';
import { ServerTrialStore } from './ServerTrialStore';
import type { TrialStore } from './TrialStore';

export type { TrialStore } from './TrialStore';
export { LocalTrialStore } from './LocalTrialStore';
export { ServerTrialStore } from './ServerTrialStore';

/** Резолвит реализацию TrialStore по `settings.trial.storage` из bootstrap.
 *  null/undefined config — каллер должен это проверять сам и не вызывать
 *  фабрику (триал отключён → store вообще не нужен). */
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
