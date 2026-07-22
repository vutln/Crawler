import {
  canonicalUrl,
  cleanText,
  detectCurrency,
  normalizeCurrency,
  parsePrice,
  parseRating,
  parseReviewCount,
} from './normalize';

describe('parsePrice', () => {
  it.each([
    ['$29.99', 29.99, 'USD'],
    ['$1,234.56', 1234.56, 'USD'],
    ['£19.99', 19.99, 'GBP'],
    ['USD 45.00', 45, 'USD'],
    ['  $7.50  ', 7.5, 'USD'],
  ])('parses %s', (input, price, currency) => {
    expect(parsePrice(input)).toEqual({ price, currency });
  });

  // The single most dangerous case in the whole crawler: get the separator
  // convention wrong and the stored price is off by 1000x, silently.
  it('treats the LAST separator as the decimal point (EU format)', () => {
    expect(parsePrice('€1.234,56')).toEqual({
      price: 1234.56,
      currency: 'EUR',
    });
  });

  it('treats the LAST separator as the decimal point (US format)', () => {
    expect(parsePrice('$1,234.56')).toEqual({
      price: 1234.56,
      currency: 'USD',
    });
  });

  it('reads a lone separator with 3 trailing digits as thousands, not decimals', () => {
    // "$1,234" is a thousand-something dollars, not $1.234.
    expect(parsePrice('$1,234').price).toBe(1234);
    expect(parsePrice('€1.234').price).toBe(1234);
  });

  /**
   * REGRESSION: caught by a live Amazon crawl. Amazon geolocates and served VND
   * to a Vietnamese IP; "VND 3,674,457" was parsed as 3.67 because the old rule
   * ("last separator wins") treated the final comma as a decimal point. A
   * 1,000,000x error that looks completely plausible in a price column.
   */
  it('treats repeated separators as thousands grouping, never as decimals', () => {
    expect(parsePrice('VND 3,674,457')).toEqual({
      price: 3674457,
      currency: 'VND',
    });
    expect(parsePrice('₫2,886,792').price).toBe(2886792);
    expect(parsePrice('3.674.457').price).toBe(3674457); // EU grouping
    expect(parsePrice('$1,234,567.89').price).toBe(1234567.89); // US, mixed
    expect(parsePrice('€1.234.567,89').price).toBe(1234567.89); // EU, mixed
  });

  it('reads a leading zero as a decimal, not grouping', () => {
    // "0.999" is 99.9 cents. "0 thousand 999" is not a thing.
    expect(parsePrice('$0.999').price).toBe(1); // rounds to cents
    expect(parsePrice('$0.99').price).toBe(0.99);
  });

  it('takes the low end of a range', () => {
    expect(parsePrice('$10.00 to $25.00').price).toBe(10);
    expect(parsePrice('$10.00 - $25.00').price).toBe(10);
  });

  // null, not 0. A missing price and a free product are different facts, and a
  // 0 would silently poison every average and every price-change calculation.
  it.each([null, undefined, '', '   ', 'See options', 'Currently unavailable'])(
    'returns null (never 0) for unparseable input: %s',
    (input) => {
      expect(parsePrice(input as string | null).price).toBeNull();
    },
  );

  it('handles non-breaking spaces from rendered HTML', () => {
    expect(parsePrice('$ 1 234.56').price).toBe(1234.56);
  });
});

describe('detectCurrency', () => {
  it('prefers an explicit ISO code over a symbol', () => {
    expect(detectCurrency('USD 45.00')).toBe('USD');
  });

  it('matches multi-char symbols before the bare dollar sign', () => {
    expect(detectCurrency('A$50.00')).toBe('AUD');
    expect(detectCurrency('C$50.00')).toBe('CAD');
    expect(detectCurrency('$50.00')).toBe('USD');
  });

  it('returns null when there is no currency signal', () => {
    expect(detectCurrency('45.00')).toBeNull();
  });
});

describe('normalizeCurrency', () => {
  it('uppercases a valid ISO-4217 code', () => {
    expect(normalizeCurrency('eur')).toBe('EUR');
    expect(normalizeCurrency(' vnd ')).toBe('VND');
  });

  /**
   * REGRESSION — this function used to take `fallback = 'USD'` and return it for
   * anything it couldn't parse, which silently relabelled money.
   *
   * The damage needed a second ingredient this repo also has: amazon.com
   * geolocates, and test/fixtures/amazon/search.html was captured from a Vietnam
   * IP with 175 occurrences of VND. parsePrice reads a bare "3.674.457" as
   * 3674457 with currency null, the old fallback stamped it USD, and the products
   * table showed $3,674,457.00 — a number that looks entirely real.
   *
   * Returning null forces the caller to decide, and CrawlRunnerService.upsert
   * decides by refusing to store the price at all. Same argument the file already
   * makes for parsePrice returning null rather than 0.
   */
  it('returns null rather than guessing USD when the currency is unknown', () => {
    expect(normalizeCurrency(null)).toBeNull();
    expect(normalizeCurrency(undefined)).toBeNull();
    expect(normalizeCurrency('')).toBeNull();
    expect(normalizeCurrency('dollars')).toBeNull();
  });
});

describe('parseRating', () => {
  it('extracts from marketplace phrasing', () => {
    expect(parseRating('4.5 out of 5 stars')).toBe(4.5);
    expect(parseRating('4,5')).toBe(4.5);
  });

  it('rejects out-of-range values instead of clamping', () => {
    // A "9.5" here means the selector matched the wrong element. Silently
    // clamping to 5 would hide a real parsing bug.
    expect(parseRating('9.5')).toBeUndefined();
    expect(parseRating('no rating')).toBeUndefined();
  });
});

describe('parseReviewCount', () => {
  it.each([
    ['1,234 ratings', 1234],
    ['(2.5k)', 2500],
    ['89', 89],
  ])('parses %s', (input, expected) => {
    expect(parseReviewCount(input)).toBe(expected);
  });

  it('returns undefined with no digits', () => {
    expect(parseReviewCount('no reviews yet')).toBeUndefined();
  });

  /**
   * REGRESSION — a rating string reaching this function produced a confident
   * wrong answer, not a null.
   *
   * Amazon's review selector was `[data-csa-c-func-deps="aui-da-a-popover"] span`
   * — the RATING popover — and textOf() returns the first non-empty node under it.
   * So "4.5 out of 5 stars" arrived here, got stripped to "455", and every Amazon
   * product recorded 455 reviews. Nothing downstream could tell that from a real
   * count. The selector is fixed (aria-label="1,648 ratings"); this is the belt
   * that survives the next drift.
   */
  it.each([
    ['4.5 out of 5 stars', '4.5 out of 5 stars'],
    ['4.5 out of 5', '4.5 out of 5'],
    ['4.5 stars', '4.5 stars'],
    ['1 star', '1 star'],
  ])('refuses to read a rating as a count: %s', (_label, input) => {
    expect(parseReviewCount(input)).toBeUndefined();
  });

  // The word "ratings" is what a COUNT is called on Amazon — screening it out
  // would discard the only reliable hook on the card. Only "out of"/"stars"
  // distinguish a rating from a count.
  it("still reads Amazon's own aria-label count", () => {
    expect(parseReviewCount('1,648 ratings')).toBe(1648);
    expect(parseReviewCount('13 ratings')).toBe(13);
  });
});

describe('canonicalUrl', () => {
  it('strips tracking noise so one product yields one URL', () => {
    const dirty =
      'https://www.amazon.com/dp/B01234567?ref=sr_1_1&qid=1699999999&sr=8-1&th=1';
    expect(canonicalUrl(dirty)).toBe('https://www.amazon.com/dp/B01234567');
  });

  it('keeps meaningful params', () => {
    expect(canonicalUrl('https://www.ebay.com/itm/123?_nkw=camera')).toContain(
      '_nkw=camera',
    );
  });

  it('resolves relative URLs against the base', () => {
    expect(canonicalUrl('/dp/B01234567', 'https://www.amazon.com')).toBe(
      'https://www.amazon.com/dp/B01234567',
    );
  });

  it('returns the input unchanged when it is not a URL', () => {
    expect(canonicalUrl('not a url')).toBe('not a url');
  });
});

describe('cleanText', () => {
  it('collapses whitespace', () => {
    expect(cleanText('  hello \n\t  world  ')).toBe('hello world');
  });

  it('truncates to the limit', () => {
    expect(cleanText('a'.repeat(50), 10)).toHaveLength(10);
  });

  it('returns empty string for nullish input', () => {
    expect(cleanText(null)).toBe('');
  });
});
