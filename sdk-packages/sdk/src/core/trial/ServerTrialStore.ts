import type { StorageAdapter } from '../storage';
import type { TrialConfig, TrialStatus } from '../types';
import { LocalTrialStore } from './LocalTrialStore';
import type { TrialStore } from './TrialStore';

let warned = false;

/**
 * Стаб серверного хранилища триала. Делегирует в {@link LocalTrialStore} —
 * SDK работает корректно, но фактически state живёт у клиента, а не на бэке.
 *
 * Когда появится серверный endpoint (`/api/v1/paywall/{id}/trial-state`),
 * заменим internals: GET для `check()`, POST для `recordBlock()`. Публичный
 * контракт `TrialStore` не меняется — `paywall.open()` flow в PaywallUI
 * трогать не придётся.
 *
 * Пока админка кладёт `settings.trial.storage = 'server'`, мы выводим один
 * console.warn и продолжаем как с `'client'`. Это позволяет владельцу пейвола
 * включить тоггл в админке заранее и проверить, что SDK не падает.
 */
export class ServerTrialStore implements TrialStore {
  private readonly fallback: LocalTrialStore;

  constructor(storage: StorageAdapter, paywallId: string, config: TrialConfig) {
    if (!warned) {
      warned = true;
      console.warn(
        '[paywall] trial.storage="server" is not implemented yet — falling back to client storage. ' +
          'State lives in localStorage; users can reset trial by clearing site data.'
      );
    }
    this.fallback = new LocalTrialStore(storage, paywallId, config);
  }

  check(): Promise<TrialStatus> {
    return this.fallback.check();
  }

  recordBlock(): Promise<TrialStatus> {
    return this.fallback.recordBlock();
  }

  reset(): Promise<void> {
    return this.fallback.reset();
  }
}
