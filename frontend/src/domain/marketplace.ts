import type { Marketplace } from '@/types/api';

/**
 * Everything the UI knows about a marketplace.
 *
 * A Record, not an array, because `Record<Marketplace, T>` is exhaustively
 * checked: adding a value to the Prisma enum and regenerating types makes this
 * file — and only this file — fail to compile. An array would stay silently
 * stale and the new site would never appear in a dropdown.
 */
export interface MarketplaceMeta {
  label: string;
  badgeClass: string;
  /** Adapter caveat, shown in the create-job form when selected. */
  note?: string;
}

export const MARKETPLACE: Record<Marketplace, MarketplaceMeta> = {
  AMAZON: {
    label: 'Amazon',
    badgeClass: 'bg-amber-100 text-amber-800',
    note: 'robots.txt permits search. Prices only render for a browser user-agent — leave CRAWL_USER_AGENT empty.',
  },
  ETSY: {
    label: 'Etsy',
    badgeClass: 'bg-orange-100 text-orange-800',
    note: "Etsy's robots.txt disallows /search — scraping runs will fail. Set ETSY_API_KEY to use the official API.",
  },
  EBAY: {
    label: 'eBay',
    badgeClass: 'bg-blue-100 text-blue-800',
    note: "eBay's robots.txt disallows /sch — scraping runs will fail. Set EBAY_APP_ID to use the Browse API.",
  },
};

// Derived — never hand-maintain.

export const MARKETPLACES = Object.keys(MARKETPLACE) as Marketplace[];

export const MARKETPLACE_OPTIONS: Array<{ value: Marketplace; label: string }> =
  MARKETPLACES.map((value) => ({ value, label: MARKETPLACE[value].label }));

export const DEFAULT_MARKETPLACE: Marketplace = MARKETPLACES[0];

export const marketplaceLabel = (m: Marketplace): string => MARKETPLACE[m].label;

/** Guard for untrusted input (URL params). */
export function isMarketplace(value: unknown): value is Marketplace {
  return typeof value === 'string' && value in MARKETPLACE;
}
