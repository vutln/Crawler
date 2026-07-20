/**
 * Barrel for the domain registries. Import from '@/domain'.
 *
 * These are the extension seam: each registry is a `Record<Enum, Meta>` keyed by a
 * generated API enum, so adding a marketplace or run status fails to compile until
 * every registry has an entry for it. Runtime rows (keywords, jobs) do NOT belong
 * here — they'd turn a compile-time exhaustiveness check into a lookup that can
 * miss.
 *
 * `export type` on the Meta interfaces is required: verbatimModuleSyntax is on, so
 * a plain re-export would emit a runtime import for a type that does not exist.
 */

// Marketplaces
export type { MarketplaceMeta } from './marketplace';
export {
  MARKETPLACE,
  MARKETPLACES,
  MARKETPLACE_OPTIONS,
  DEFAULT_MARKETPLACE,
  marketplaceLabel,
  isMarketplace,
} from './marketplace';

// Run statuses
export type { RunStatusMeta } from './run-status';
export {
  RUN_STATUS,
  RUN_STATUSES,
  RUN_STATUS_OPTIONS,
  ACTIVE_STATUSES,
  isActiveStatus,
  isRunStatus,
} from './run-status';
