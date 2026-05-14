import type { TrialStatus } from '../types';

/**
 * Хранилище состояния pre-paywall триала. Изолирует логику доступа к
 * persistent-стейту: SDK дёргает `check()` перед `paywall.open()` и
 * `recordBlock()` когда решает не показывать модалку.
 *
 * Реализации:
 * - {@link LocalTrialStore} — localStorage / chrome.storage. Дефолт.
 * - {@link ServerTrialStore} — стаб; сейчас делегирует в Local + warning.
 *   Активируется через `settings.trial.storage = 'server'` из админки —
 *   когда серверный endpoint появится, заменим internals без изменения API.
 */
export interface TrialStore {
  /** Прочитать текущий статус без побочных эффектов. */
  check(): Promise<TrialStatus>;
  /** Зафиксировать факт блокировки показа: для `time` — init firstOpen,
   *  для `opens` — increment counter (capped at total). Возвращает
   *  свежий статус после записи. */
  recordBlock(): Promise<TrialStatus>;
  /** Сбросить хранилище триала (для дев/тестов / `paywall.resetTrial()`). */
  reset(): Promise<void>;
}
