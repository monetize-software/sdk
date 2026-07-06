import type {
  PaywallBootstrap,
  PaywallExperiment,
  PaywallExperimentVariant,
  PaywallPrice
} from './types';
import { STORAGE_KEYS, type StorageAdapter } from './storage';

// Client-side A/B experiment engine.
//
// Assignment happens on the device: a deterministic hash of
// `${visitorId}:${experimentId}` picks a bucket over the variant weights. This
// keeps every server/client cache layer variant-agnostic — the bootstrap
// payload is identical for all users (it carries ALL variants), and the SDK
// materializes the assigned one locally. The first computed assignment is
// persisted (first-touch stickiness): editing weights mid-experiment must not
// rebucket already-exposed users, and the persisted record also survives the
// hash inputs changing (e.g. a migration of the bucketing function).
//
// Substitution is idempotent: the replacement map is keyed by CONTROL price
// ids taken from the raw `experiment` block (always present in the payload),
// so re-running it over an already-substituted bootstrap finds nothing to
// replace and only re-fixes layout/offer references if a later
// applyLocaleOverrides resurrected control ids.

export interface ExperimentAssignment {
  experimentId: string;
  variant: string;
}

interface PersistedAssignment extends ExperimentAssignment {
  at: number;
}

// FNV-1a 32-bit — tiny, dependency-free, and uniform enough for traffic
// splitting. Not cryptographic (doesn't need to be).
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministically picks a variant for a visitor: bucket = hash % totalWeight,
 * then a cumulative walk over the variants in server order. Weights are
 * normalized over their sum, so 50/50, 1/1 and 90/10 all work. Returns null on
 * a degenerate config (no variants / non-positive total weight).
 */
export function pickVariant(
  experiment: Pick<PaywallExperiment, 'id' | 'variants'>,
  visitorId: string
): string | null {
  const variants = experiment.variants.filter((v) => v && typeof v.key === 'string');
  const total = variants.reduce((sum, v) => sum + Math.max(0, v.weight || 0), 0);
  if (total <= 0) return null;
  const bucket = fnv1a(`${visitorId}:${experiment.id}`) % total;
  let cumulative = 0;
  for (const v of variants) {
    cumulative += Math.max(0, v.weight || 0);
    if (bucket < cumulative) return v.key;
  }
  return variants[variants.length - 1]?.key ?? null;
}

/**
 * Resolves the sticky assignment for the experiment: a persisted record wins
 * (if it belongs to the same experiment id and the variant still exists),
 * otherwise a fresh deterministic pick is computed and persisted. Storage
 * failures degrade to the deterministic pick — same visitor, same variant, so
 * the UX stays consistent even without persistence.
 */
export async function resolveExperimentAssignment(
  storage: StorageAdapter,
  paywallId: string,
  experiment: PaywallExperiment,
  getVisitorId: () => Promise<string>
): Promise<ExperimentAssignment | null> {
  const key = STORAGE_KEYS.experiment(paywallId);

  try {
    const raw = await storage.getItem(key);
    if (raw) {
      const persisted = JSON.parse(raw) as PersistedAssignment | null;
      if (
        persisted &&
        persisted.experimentId === experiment.id &&
        experiment.variants.some((v) => v.key === persisted.variant)
      ) {
        return { experimentId: persisted.experimentId, variant: persisted.variant };
      }
    }
  } catch {
    /* corrupted / unavailable — fall through to a deterministic pick */
  }

  const visitorId = await getVisitorId();
  const variant = pickVariant(experiment, visitorId);
  if (!variant) return null;

  const assignment: ExperimentAssignment = { experimentId: experiment.id, variant };
  try {
    const record: PersistedAssignment = { ...assignment, at: Date.now() };
    await storage.setItem(key, JSON.stringify(record));
  } catch {
    /* quota / disabled — the deterministic pick keeps it stable anyway */
  }
  return assignment;
}

/**
 * Materializes the assigned variant into the bootstrap (mutates it):
 *  - stamps `experiment.assigned_variant` (read by EventTracker props and
 *    createCheckout attribution);
 *  - for kind='prices' with a non-control payload — substitutes the variant
 *    prices into `bootstrap.prices` and remaps price-id references in the
 *    layout (price_grid.priceIds / popular_price_id / cta_button.priceId) and
 *    in offers (`offer.price_id`).
 *
 * Must run AFTER applyLocaleOverrides: locale overrides may replace the layout
 * wholesale with one that references control price ids again. Safe to re-run.
 */
export function applyExperimentAssignment(
  bootstrap: PaywallBootstrap,
  assignment: ExperimentAssignment
): void {
  const experiment = bootstrap.experiment;
  if (!experiment || experiment.id !== assignment.experimentId) return;

  experiment.assigned_variant = assignment.variant;

  if (experiment.kind !== 'prices') return;
  const variant = experiment.variants.find((v) => v.key === assignment.variant);
  if (!variant) return;
  applyPriceVariant(bootstrap, variant);
}

function applyPriceVariant(
  bootstrap: PaywallBootstrap,
  variant: PaywallExperimentVariant
): void {
  const replacements = new Map<string, PaywallPrice & { replaces: string | null }>();
  for (const price of variant.prices ?? []) {
    if (price.replaces != null) replacements.set(String(price.replaces), price);
  }
  if (replacements.size === 0) return;

  bootstrap.prices = bootstrap.prices.map((p) => replacements.get(p.id) ?? p);

  const idMap = new Map<string, string>();
  replacements.forEach((vp, controlId) => idMap.set(controlId, vp.id));
  const remap = (id: string): string => idMap.get(id) ?? id;

  for (const block of bootstrap.layout?.blocks ?? []) {
    if (block.type === 'price_grid') {
      if (block.priceIds) block.priceIds = block.priceIds.map(remap);
      if (block.popular_price_id) block.popular_price_id = remap(block.popular_price_id);
    } else if (block.type === 'cta_button' && block.priceId) {
      block.priceId = remap(block.priceId);
    }
  }

  for (const offer of bootstrap.offers ?? []) {
    if (offer.price_id != null) offer.price_id = remap(offer.price_id);
  }
}
