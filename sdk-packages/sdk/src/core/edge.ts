import { PaywallError } from './types';
import { STORAGE_KEYS, type StorageAdapter } from './storage';

// Mirror-origin failover for networks where the primary custom_domain is
// unreachable at the IP level (state-scale blocking of DO/Cloudflare/Hetzner
// ranges — the RF TSPU case). Custom-domain DNS zones are NS-delegated to the
// platform, which provisions an `edge.<custom_domain>` record pointing at a
// relay with reachable IPs. The SDK derives that name by convention — zero
// host-app configuration — and fails over to it when the primary dies at the
// network level (never on an HTTP status: any status proves reachability).

export const EDGE_SUBDOMAIN_PREFIX = 'edge.';

// After a successful failover the edge stays first-in-line for this long.
// On expiry the primary is tried first again (that request pays one hedge
// timeout) — the way back after an unblock is automatic, no state to clear.
export const EDGE_STICKY_TTL_MS = 30 * 60 * 1000;

// Non-final attempts get this long before the next candidate is tried.
// TSPU-style blocking silently drops packets (no RST) — without a deadline
// the request would hang for minutes instead of failing over.
export const EDGE_HEDGE_TIMEOUT_MS = 5_000;

// The last candidate gets a generous deadline instead of none: a stalled
// stream must eventually surface as network_error, not hang forever. Applied
// only when failover is active — single-candidate setups keep the platform
// defaults (no behavior change for pre-edge configurations).
export const EDGE_FINAL_TIMEOUT_MS = 30_000;

// Once response headers arrived, the hedge timer is swapped for this one: the
// body read gets its own generous deadline instead of the remainder of the
// 5s hedge. Bounds the DPI mid-body stall without killing legitimately slow
// bodies (large bootstrap on a slow link).
export const EDGE_BODY_TIMEOUT_MS = 30_000;

/** Duck-typed error name: DOMException isn't always instanceof Error in edge
 *  runtimes (Cloudflare Workers), so classification goes via `.name`. */
export function errorName(cause: unknown): string | undefined {
  return cause && typeof cause === 'object' && 'name' in cause
    ? String((cause as { name: unknown }).name)
    : undefined;
}

export interface Deadline {
  /** Signal to hand to fetch. Composes the caller's signal with arm()ed
   *  timers; without `eager` and without timers it is the caller's signal
   *  verbatim (pre-edge passthrough). */
  readonly signal: AbortSignal | undefined;
  /** true when the last abort came from an arm()ed timer, not the caller. */
  timedOut(): boolean;
  /** Start (restart) the deadline. null just clears the current timer. */
  arm(ms: number | null): void;
  disarm(): void;
  /** Clear the timer and unlink the caller-signal listener. Call in finally. */
  dispose(): void;
}

/**
 * One AbortController composing the caller's signal with swappable timers.
 * `eager` must be true when a timer may be armed AFTER the fetch started
 * (the body-read deadline) — the controller has to be the signal fetch got,
 * otherwise a later abort would not reach the in-flight stream.
 */
export function createDeadline(
  callerSignal: AbortSignal | null | undefined,
  opts: { eager?: boolean } = {}
): Deadline {
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let unlink: (() => void) | undefined;

  const ensureController = (): AbortController => {
    if (controller) return controller;
    controller = new AbortController();
    if (callerSignal) {
      if (callerSignal.aborted) {
        controller.abort(callerSignal.reason);
      } else {
        const forward = () => controller!.abort(callerSignal.reason);
        callerSignal.addEventListener('abort', forward);
        unlink = () => callerSignal.removeEventListener('abort', forward);
      }
    }
    return controller;
  };

  if (opts.eager) ensureController();

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  return {
    get signal() {
      return controller ? controller.signal : (callerSignal ?? undefined);
    },
    timedOut: () => timedOut,
    arm(ms: number | null): void {
      clearTimer();
      if (ms == null) return;
      const c = ensureController();
      timer = setTimeout(() => {
        timedOut = true;
        c.abort();
      }, ms);
    },
    disarm: clearTimer,
    dispose(): void {
      clearTimer();
      unlink?.();
    }
  };
}

/**
 * `https://api.example.com` → `https://edge.api.example.com`, or null when the
 * convention can't apply: http (local/dev), IP literals, dotless hosts
 * (localhost), or a host that already is an edge mirror.
 */
export function deriveEdgeOrigin(apiOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(apiOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname;
  if (host.startsWith(EDGE_SUBDOMAIN_PREFIX)) return null;
  if (!host.includes('.')) return null;
  // IP literals: IPv4 (digits and dots only) and IPv6 ([::1] — hostname keeps
  // the colons).
  if (host.includes(':') || /^[\d.]+$/.test(host)) return null;
  return `https://${EDGE_SUBDOMAIN_PREFIX}${host}${url.port ? `:${url.port}` : ''}`;
}

type ActiveOrigin = 'primary' | 'edge';

interface EdgeState {
  active: ActiveOrigin;
  /** Epoch ms of the primary→edge switch. NOT refreshed by later edge
   *  successes — its expiry is what schedules the periodic primary re-probe. */
  switchedAt: number;
}

// Shared across every client in the JS context — BillingClient, AuthClient and
// ApiGatewayClient hold separate ApiClient/resolver instances, but one
// discovery must benefit all of them. Keyed by primary origin.
const sharedStates = new Map<string, EdgeState>();

export interface OriginResolverOptions {
  apiOrigin: string;
  /** false — disable failover; string — explicit mirror origin overriding the
   *  `edge.<host>` convention; undefined — derive by convention. */
  edgeFallback?: false | string;
  /** When present, the discovered state survives restarts: the first request
   *  of the next session goes straight to the working origin instead of
   *  paying the hedge timeout again. */
  storage?: StorageAdapter;
}

export class OriginResolver {
  readonly primary: string;
  readonly edge: string | null;
  /** Resolves once the persisted state (if any) has been consulted. */
  readonly ready: Promise<void>;
  private storage: StorageAdapter | undefined;
  private storageKey: string;

  constructor(opts: OriginResolverOptions) {
    this.primary = opts.apiOrigin;
    this.storage = opts.storage;
    // Same key basis as the in-memory sharedStates (origin, not paywallId) —
    // otherwise two paywalls on one custom_domain hydrate/persist past each
    // other and a stale record can shadow a fresh one.
    let hostKey: string;
    try {
      hostKey = new URL(this.primary).host;
    } catch {
      hostKey = this.primary;
    }
    this.storageKey = STORAGE_KEYS.edgeState(hostKey);

    let edge: string | null;
    if (opts.edgeFallback === false) {
      edge = null;
    } else if (typeof opts.edgeFallback === 'string') {
      try {
        edge = new URL(opts.edgeFallback).origin;
      } catch {
        throw new PaywallError(
          'invalid_config',
          `edgeFallback is not a valid origin: "${opts.edgeFallback}"`
        );
      }
    } else {
      edge = deriveEdgeOrigin(this.primary);
    }
    this.edge = edge === this.primary ? null : edge;
    this.ready = this.hydrate();
  }

  private async hydrate(): Promise<void> {
    if (!this.storage || !this.edge || sharedStates.has(this.primary)) return;
    try {
      const raw = await this.storage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<EdgeState>;
      if (
        (parsed.active === 'edge' || parsed.active === 'primary') &&
        typeof parsed.switchedAt === 'number' &&
        // Re-check after the await: a parallel client in this context may have
        // already discovered fresher truth than the persisted record.
        !sharedStates.has(this.primary)
      ) {
        sharedStates.set(this.primary, {
          active: parsed.active,
          switchedAt: parsed.switchedAt
        });
      }
    } catch {
      /* corrupted record — failover re-discovers from scratch */
    }
  }

  /** Origins in the order they should be tried for this request. */
  candidates(): string[] {
    if (!this.edge) return [this.primary];
    const state = sharedStates.get(this.primary);
    if (
      state?.active === 'edge' &&
      Date.now() - state.switchedAt < EDGE_STICKY_TTL_MS
    ) {
      return [this.edge, this.primary];
    }
    return [this.primary, this.edge];
  }

  /**
   * Record which origin actually served a response. Writes (memory + storage)
   * happen only on transitions — the happy path never touches storage.
   */
  noteSuccess(origin: string): void {
    if (!this.edge) return;
    const state = sharedStates.get(this.primary);
    if (origin === this.edge) {
      const fresh =
        state?.active === 'edge' &&
        Date.now() - state.switchedAt < EDGE_STICKY_TTL_MS;
      // While fresh, keep the original switchedAt — see EdgeState.switchedAt.
      if (fresh) return;
      this.setState({ active: 'edge', switchedAt: Date.now() });
    } else if (origin === this.primary && state?.active === 'edge') {
      this.setState({ active: 'primary', switchedAt: Date.now() });
    }
  }

  private setState(state: EdgeState): void {
    sharedStates.set(this.primary, state);
    if (this.storage) {
      void this.storage
        .setItem(this.storageKey, JSON.stringify(state))
        .then(undefined, () => {});
    }
  }
}

/**
 * The shared failover loop: try candidates in sticky order, move to the next
 * one only on retryable network failures. Retryable = PaywallError with code
 * 'network_error' whose `originRetryable` is not false — the attempt callback
 * marks post-headers failures of non-idempotent requests as non-retryable
 * (the origin has already processed the request; a replay would re-execute
 * the side effect). HTTP statuses and caller aborts never fail over.
 */
export async function runWithFailover<T>(
  resolver: OriginResolver,
  attempt: (
    origin: string,
    isLast: boolean,
    candidateCount: number
  ) => Promise<T>,
  opts: {
    /** Try only the preferred origin (stream bodies can't be replayed). */
    firstOnly?: boolean;
  } = {}
): Promise<T> {
  // Cheap after the first call; on a cold start it lets a previously
  // discovered edge preference load, so a returning blocked user goes
  // straight to the mirror instead of paying the hedge timeout again.
  await resolver.ready;
  const all = resolver.candidates();
  const candidates = opts.firstOnly ? all.slice(0, 1) : all;

  for (let i = 0; i < candidates.length; i++) {
    const isLast = i === candidates.length - 1;
    try {
      const result = await attempt(candidates[i], isLast, candidates.length);
      resolver.noteSuccess(candidates[i]);
      return result;
    } catch (err) {
      const retryable =
        err instanceof PaywallError &&
        err.code === 'network_error' &&
        err.originRetryable !== false;
      if (isLast || !retryable) throw err;
    }
  }
  // The loop always returns or throws; TS needs the tail.
  throw new PaywallError('network_error', 'Network request failed');
}

// The sticky map is module-level; without a reset it leaks between test cases
// that reuse the same origins.
export function __resetEdgeStateForTests(): void {
  sharedStates.clear();
}
