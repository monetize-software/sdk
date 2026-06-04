import type { StorageAdapter } from '../storage';
import type { OpensTrialStatus, TimeTrialStatus, TrialConfig, TrialStatus } from '../types';
import type { TrialStore } from './TrialStore';

const HOUR_MS = 60 * 60 * 1000;

// Keys are 1-to-1 with legacy v2 (online/components/PayWallIframeOpener.tsx) —
// migrating from v2 to SDK 3.0 doesn't reset trial progress for existing users.
function timeKey(paywallId: string): string {
  return `paywall-${paywallId}-trial-time-first-open`;
}
function opensKey(paywallId: string): string {
  return `paywall-${paywallId}-skip-times`;
}

export class LocalTrialStore implements TrialStore {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly paywallId: string,
    private readonly config: TrialConfig
  ) {}

  async check(): Promise<TrialStatus> {
    if (this.config.mode === 'time') return this.checkTime();
    return this.checkOpens();
  }

  async recordBlock(): Promise<TrialStatus> {
    if (this.config.mode === 'time') return this.recordTime();
    return this.recordOpens();
  }

  async reset(): Promise<void> {
    await this.storage.removeItem(this.config.mode === 'time' ? timeKey(this.paywallId) : opensKey(this.paywallId));
  }

  private async checkTime(): Promise<TimeTrialStatus> {
    const totalMs = this.config.payload * HOUR_MS;
    const raw = await this.storage.getItem(timeKey(this.paywallId));
    const startedAt = raw ? Number(raw) : null;
    if (!startedAt || !Number.isFinite(startedAt)) {
      // The trial hasn't started yet — the first open() counts as an active
      // trial (the paywall won't show; we record firstOpen in recordBlock()).
      return {
        mode: 'time',
        blocked: true,
        startedAt: null,
        expiresAt: null,
        remainingMs: totalMs,
        totalMs
      };
    }
    const expiresAt = startedAt + totalMs;
    const remainingMs = Math.max(0, expiresAt - Date.now());
    return {
      mode: 'time',
      blocked: remainingMs > 0,
      startedAt,
      expiresAt,
      remainingMs,
      totalMs
    };
  }

  private async checkOpens(): Promise<OpensTrialStatus> {
    const total = this.config.payload;
    const raw = await this.storage.getItem(opensKey(this.paywallId));
    const used = raw ? Number(raw) : 0;
    const safeUsed = Number.isFinite(used) ? used : 0;
    // v2 semantics: `paywall-${id}-skip-times` stores the number of blocks
    // already performed. The trial is active while `used < total`. payload=3,
    // used=0..2 — still blocking; used=3 — the next open() shows the paywall.
    const blocked = safeUsed < total;
    const remaining = Math.max(0, total - safeUsed);
    return {
      mode: 'opens',
      blocked,
      remainingActions: remaining,
      totalActions: total
    };
  }

  private async recordTime(): Promise<TimeTrialStatus> {
    const totalMs = this.config.payload * HOUR_MS;
    const key = timeKey(this.paywallId);
    const raw = await this.storage.getItem(key);
    let startedAt = raw ? Number(raw) : null;
    if (!startedAt || !Number.isFinite(startedAt)) {
      startedAt = Date.now();
      await this.storage.setItem(key, String(startedAt));
    }
    const expiresAt = startedAt + totalMs;
    const remainingMs = Math.max(0, expiresAt - Date.now());
    return {
      mode: 'time',
      blocked: remainingMs > 0,
      startedAt,
      expiresAt,
      remainingMs,
      totalMs
    };
  }

  private async recordOpens(): Promise<OpensTrialStatus> {
    const total = this.config.payload;
    const key = opensKey(this.paywallId);
    const raw = await this.storage.getItem(key);
    const used = raw ? Number(raw) : 0;
    const safeUsed = Number.isFinite(used) ? used : 0;
    // Don't increment above total — the counter becomes "sticky at total"
    // after expiry, so that repeated `recordBlock()` calls (if one happens to
    // fire on an already-expired trial) don't diverge from `check()`.
    const next = Math.min(total, safeUsed + 1);
    await this.storage.setItem(key, String(next));
    const remaining = Math.max(0, total - next);
    return {
      mode: 'opens',
      blocked: next < total,
      remainingActions: remaining,
      totalActions: total
    };
  }
}
