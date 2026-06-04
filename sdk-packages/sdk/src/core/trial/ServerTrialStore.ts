import type { StorageAdapter } from '../storage';
import type { TrialConfig, TrialStatus } from '../types';
import { LocalTrialStore } from './LocalTrialStore';
import type { TrialStore } from './TrialStore';

let warned = false;

/**
 * Stub for the server-side trial store. Delegates to {@link LocalTrialStore} —
 * the SDK works correctly, but in fact the state lives on the client, not on
 * the backend.
 *
 * Once a server endpoint appears (`/api/v1/paywall/{id}/trial-state`), we'll
 * replace the internals: GET for `check()`, POST for `recordBlock()`. The
 * public `TrialStore` contract doesn't change — the `paywall.open()` flow in
 * PaywallUI won't need to be touched.
 *
 * While the admin sets `settings.trial.storage = 'server'`, we emit a single
 * console.warn and continue as with `'client'`. This lets the paywall owner
 * flip the toggle in the admin panel ahead of time and verify the SDK doesn't
 * break.
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
