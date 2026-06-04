import type { TrialStatus } from '../types';

/**
 * Store for the pre-paywall trial state. Isolates the logic of accessing the
 * persistent state: the SDK calls `check()` before `paywall.open()` and
 * `recordBlock()` when it decides not to show the modal.
 *
 * Implementations:
 * - {@link LocalTrialStore} — localStorage / chrome.storage. The default.
 * - {@link ServerTrialStore} — a stub; currently delegates to Local + a
 *   warning. Activated via `settings.trial.storage = 'server'` from the admin
 *   panel — once a server endpoint appears, we'll replace the internals
 *   without changing the API.
 */
export interface TrialStore {
  /** Read the current status without side effects. */
  check(): Promise<TrialStatus>;
  /** Record the fact that the display was blocked: for `time` — init
   *  firstOpen, for `opens` — increment the counter (capped at total).
   *  Returns the fresh status after the write. */
  recordBlock(): Promise<TrialStatus>;
  /** Reset the trial store (for dev/tests / `paywall.resetTrial()`). */
  reset(): Promise<void>;
}
