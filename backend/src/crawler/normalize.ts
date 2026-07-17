/** Pure price/text normalization — where marketplace text goes wrong silently. */

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '£': 'GBP',
  '€': 'EUR',
  '¥': 'JPY',
  '₫': 'VND',
  '₹': 'INR',
  '₩': 'KRW',
  'A$': 'AUD',
  'C$': 'CAD',
};

export interface ParsedPrice {
  price: number | null;
  currency: string | null;
}

/**
 * Parse a marketplace price into a number + ISO-4217 code. See toNumber() for
 * the separator rules, which are where this gets dangerous.
 *
 * Returns null, never 0, for unparseable input: a missing price and a free item
 * are different facts, and 0 poisons every average.
 */
export function parsePrice(input: string | null | undefined): ParsedPrice {
  if (!input) return { price: null, currency: null };

  const text = input.replace(/ /g, ' ').trim();
  if (!text) return { price: null, currency: null };

  const currency = detectCurrency(text);

  // Ranges ("$10.00 to $25.00") — take the low end, consistently.
  const numericPart = text.split(/\s+(?:to|-|–|—)\s+/i)[0] ?? text;

  const digits = numericPart.match(/[\d.,\s]+/g)?.join('') ?? '';
  const cleaned = digits.replace(/\s/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return { price: null, currency };

  const price = toNumber(cleaned);
  if (price === null || !Number.isFinite(price) || price < 0) {
    return { price: null, currency };
  }

  return { price: Math.round(price * 100) / 100, currency };
}

/**
 * Decide which separators are grouping and which is the decimal point.
 *
 * The highest-risk function here: get it wrong and you store a price off by
 * 1000x that looks entirely plausible in a table. Rules by confidence:
 *   1. Two+ of the SAME separator -> grouping ("3,674,457")
 *   2. Both kinds present         -> the LAST is decimal ("1.234,56" EU vs "1,234.56" US)
 *   3. Exactly one               -> ambiguous; see below
 */
function toNumber(cleaned: string): number | null {
  const commas = (cleaned.match(/,/g) ?? []).length;
  const dots = (cleaned.match(/\./g) ?? []).length;

  let normalized: string;

  if (commas === 0 && dots === 0) {
    normalized = cleaned;
  } else if (commas > 0 && dots > 0) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      normalized = cleaned.replace(/\./g, '').replace(/,/g, '.'); // EU: 1.234,56
    } else {
      normalized = cleaned.replace(/,/g, ''); // US: 1,234.56
    }
  } else if (commas > 1) {
    // No number has two decimal points.
    normalized = cleaned.replace(/,/g, '');
  } else if (dots > 1) {
    normalized = cleaned.replace(/\./g, '');
  } else {
    // Ambiguous by construction: "1,234" is 1234 in the US and 1.234 in the EU,
    // and nothing in the string settles it. Exactly 3 trailing digits =>
    // grouping, since 3-decimal prices are far rarer than thousands.
    const sep = commas === 1 ? ',' : '.';
    const idx = cleaned.lastIndexOf(sep);
    const trailing = cleaned.length - idx - 1;
    const leading = cleaned.slice(0, idx);

    // ...unless the integer part is 0: "0.999" is a decimal, never 999.
    const isGrouping = trailing === 3 && leading !== '0' && leading !== '';

    normalized = isGrouping
      ? cleaned.split(sep).join('')
      : sep === ','
        ? cleaned.replace(',', '.')
        : cleaned;
  }

  const value = Number.parseFloat(normalized);
  return Number.isNaN(value) ? null : value;
}

export function detectCurrency(text: string): string | null {
  const iso = /\b(USD|EUR|GBP|JPY|VND|INR|AUD|CAD|KRW|CNY|SGD)\b/i.exec(text);
  if (iso) return iso[1].toUpperCase();

  // Longest-first so "A$" and "C$" beat a bare "$".
  const symbols = Object.keys(CURRENCY_SYMBOLS).sort((a, b) => b.length - a.length);
  for (const symbol of symbols) {
    if (text.includes(symbol)) return CURRENCY_SYMBOLS[symbol];
  }
  return null;
}

/** "4.5 out of 5 stars" | "4,5" -> 4.5. Out-of-range values are rejected, not clamped. */
export function parseRating(input: string | null | undefined): number | undefined {
  if (!input) return undefined;
  const match = /(\d+([.,]\d+)?)/.exec(input);
  if (!match) return undefined;

  const value = Number.parseFloat(match[1].replace(',', '.'));
  if (Number.isNaN(value) || value < 0 || value > 5) return undefined;
  return Math.round(value * 100) / 100;
}

/** "1,234 ratings" | "(2.5k)" -> 1234 | 2500 */
/**
 * Reject strings that are plainly not a review count before stripping digits.
 *
 * Stripping non-digits from a rating produces a confident wrong answer rather
 * than no answer: "4.5 out of 5 stars" -> "455" -> 455 reviews. That is worse
 * than undefined, because nothing downstream can tell it from a real count.
 *
 * This fires in practice. Amazon's review selector used to match the rating
 * popover, and textOf() returns the first non-empty node under it — so the
 * rating string was what reached this function on a real crawl.
 *
 * Deliberately does NOT reject /rating/: Amazon's own review-count hook is
 * aria-label="1,648 ratings", so screening that word out would discard the one
 * reliable signal on the page. "out of" and "stars" are what separate a rating
 * from a count; "ratings" is what a count is called.
 */
const NOT_A_REVIEW_COUNT = /out of|\bstars?\b/i;

export function parseReviewCount(input: string | null | undefined): number | undefined {
  if (!input) return undefined;
  if (NOT_A_REVIEW_COUNT.test(input)) return undefined;

  const k = /(\d+([.,]\d+)?)\s*k\b/i.exec(input);
  if (k) return Math.round(Number.parseFloat(k[1].replace(',', '.')) * 1000);

  const digits = input.replace(/[^\d]/g, '');
  if (!digits) return undefined;

  const value = Number.parseInt(digits, 10);
  return Number.isNaN(value) ? undefined : value;
}

/** Collapse whitespace; MySQL TEXT is fine with length but the UI is not. */
export function cleanText(input: string | null | undefined, maxLength = 1000): string {
  if (!input) return '';
  const flat = input.replace(/\s+/g, ' ').trim();
  return flat.length > maxLength ? flat.slice(0, maxLength) : flat;
}

/** Strip tracking/session junk so the same product doesn't yield N distinct URLs. */
export function canonicalUrl(input: string, base?: string): string {
  try {
    const url = new URL(input, base);
    const noise = [
      'ref', 'ref_', 'pd_rd_i', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pf_rd_p',
      'pf_rd_r', 'psc', 'th', 'qid', 'sr', 'keywords', 'sprefix', 'crid',
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'hash', 'epid', '_trkparms', '_trksid', 'var', 'click_key', 'ga_order',
      'ga_search_type', 'ga_view_type', 'ga_search_query', 'organic_search_click',
      'frs',
    ];
    for (const param of noise) url.searchParams.delete(param);
    url.hash = '';
    return url.toString();
  } catch {
    return input;
  }
}

/**
 * ISO-4217 code for "no currency involved". Stored when a listing's currency
 * could not be determined, alongside a null price — see CrawlRunnerService.upsert.
 */
export const UNKNOWN_CURRENCY = 'XXX';

/**
 * Uppercase ISO-4217, or null when the marketplace didn't tell us.
 *
 * Returns null rather than defaulting to USD, and that is the whole point. This
 * used to take `fallback = 'USD'`, which meant any price whose symbol wasn't
 * scraped was stamped USD regardless of what it actually was. Combined with a
 * non-US egress — amazon.com geolocates, and test/fixtures/amazon/search.html is
 * 175 occurrences of VND captured from www.amazon.com — a ₫2,490,000 keyboard
 * was stored as $2,490,000.00 and was indistinguishable from a real price in the
 * table, the chart and the CSV.
 *
 * This file already makes exactly this argument for parsePrice ("Returns null,
 * never 0 — 0 poisons every average"). A guessed currency poisons the same
 * averages and is harder to spot, because the number itself looks fine.
 */
export function normalizeCurrency(
  currency: string | null | undefined,
): string | null {
  if (!currency) return null;
  const upper = currency.toUpperCase().trim();
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}
