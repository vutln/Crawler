import type { ConfigService } from '@nestjs/config';
import { Marketplace } from '../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AdapterRegistry } from '../adapters/adapter.registry';
import type { ProductRecord } from '../adapters/adapter.interface';
import { CrawlRunnerService } from './crawl-runner.service';

/**
 * upsert() is where every adapter's output becomes durable, so it is where a bad
 * write becomes permanent. These tests assert the SHAPE of the Prisma payload
 * rather than round-tripping a database: the bugs being pinned are about which
 * keys are present, which is exactly what a real DB would hide behind a
 * successful write.
 */
describe('CrawlRunnerService.upsert', () => {
  interface Captured {
    create: Record<string, unknown>;
    update: Record<string, unknown>;
    snapshot: Record<string, unknown>;
  }

  function makeRunner(opts: { existing?: boolean } = {}): {
    runner: CrawlRunnerService;
    captured: Captured;
  } {
    const captured: Captured = { create: {}, update: {}, snapshot: {} };

    const tx = {
      product: {
        upsert: (args: { create: object; update: object }) => {
          captured.create = args.create as Record<string, unknown>;
          captured.update = args.update as Record<string, unknown>;
          return Promise.resolve({ id: 'prod_1' });
        },
      },
      priceSnapshot: {
        create: (args: { data: object }) => {
          captured.snapshot = args.data as Record<string, unknown>;
          return Promise.resolve({});
        },
      },
    };

    const prisma = {
      product: {
        findUnique: () => Promise.resolve(opts.existing ? { id: 'prod_1' } : null),
      },
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaService;

    const registry = {} as AdapterRegistry;
    // Only CRAWL_RUN_TIMEOUT_MS is read, and only by execute() — these upsert tests
    // never reach the watchdog, so the fallback is all that matters here.
    const config = {
      get: (_k: string, fallback?: unknown) => fallback,
    } as unknown as ConfigService;

    return {
      runner: new CrawlRunnerService(prisma, registry, config),
      captured,
    };
  }

  function record(over: Partial<ProductRecord> = {}): ProductRecord {
    return {
      externalId: 'B0TEST',
      url: 'https://www.amazon.com/dp/B0TEST',
      title: 'Test keyboard',
      price: 49.99,
      currency: 'USD',
      inStock: true,
      ...over,
    };
  }

  /** upsert is private; it is the unit under test, and going through execute() would mock a DB instead. */
  function upsert(runner: CrawlRunnerService, r: ProductRecord): Promise<unknown> {
    return (
      runner as unknown as {
        upsert: (r: ProductRecord, m: Marketplace, id: string) => Promise<unknown>;
      }
    ).upsert(r, Marketplace.EBAY, 'run_1');
  }

  /**
   * REGRESSION — setting EBAY_APP_ID silently erased every review count in the DB.
   *
   * `identity` was built with `?? null` and spread into BOTH create and update, so
   * any field the running adapter doesn't collect was written as NULL over a good
   * value. ebay-api has no product review counts and outranks ebay-selenium
   * (priority 100 vs 10), so flipping on API credentials didn't merely stop adding
   * counts — it destroyed the ones already collected, on every run, forever.
   *
   * The fix rests on Prisma's undefined/null distinction, and so does this test:
   * `undefined` is omitted from the UPDATE entirely ("don't touch"), while `null`
   * compiles to `SET col = NULL`. The spread still CREATES the key — so asserting
   * the key is absent would be testing the wrong thing. What matters is the value:
   * undefined preserves, null destroys.
   */
  it('does not overwrite fields the adapter never collected', async () => {
    const { runner, captured } = makeRunner({ existing: true });

    // Exactly what ebay-api emits: no reviewCount, no rating, no imageUrl.
    await upsert(runner, record({ reviewCount: undefined, rating: undefined, imageUrl: undefined }));

    // Each of these was `null` before the fix, and null is what erased the data.
    // toBeUndefined() fails on null, so this is the regression.
    expect(captured.update.reviewCount).toBeUndefined();
    expect(captured.update.rating).toBeUndefined();
    expect(captured.update.imageUrl).toBeUndefined();
  });

  it('does write a field the adapter did collect', async () => {
    const { runner, captured } = makeRunner({ existing: true });
    await upsert(runner, record({ reviewCount: 1648 }));

    expect(captured.update.reviewCount).toBe(1648);
  });

  /**
   * REGRESSION — ₫3,674,457 was stored as $3,674,457.00.
   *
   * parsePrice reads a bare "3.674.457" off an Amazon card as a number with no
   * currency, and normalizeCurrency's old `fallback = 'USD'` labelled it USD. A
   * price we cannot label is not a price: keep the product, drop the number.
   */
  it('refuses to store a price whose currency could not be determined', async () => {
    const { runner, captured } = makeRunner();
    await upsert(runner, record({ price: 3674457, currency: null }));

    expect(captured.create.currentPrice).toBeNull();
    expect(captured.snapshot.price).toBeNull();
    // XXX is ISO-4217 "no currency involved" — never a guess.
    expect(captured.create.currency).toBe('XXX');
    expect(captured.snapshot.currency).toBe('XXX');
    // The listing itself is still worth keeping.
    expect(captured.create.title).toBe('Test keyboard');
  });

  it('stores a price that does carry a currency', async () => {
    const { runner, captured } = makeRunner();
    await upsert(runner, record({ price: 49.99, currency: 'USD' }));

    expect(String(captured.create.currentPrice)).toBe('49.99');
    expect(captured.create.currency).toBe('USD');
  });

  /** A run that failed to read the currency must not relabel one an earlier run read correctly. */
  it('does not overwrite a known currency with an unknown one', async () => {
    const { runner, captured } = makeRunner({ existing: true });
    await upsert(runner, record({ price: null, currency: null }));

    expect(captured.update).not.toHaveProperty('currency');
  });

  it('appends a snapshot on every observation — the core invariant', async () => {
    const { runner, captured } = makeRunner({ existing: true });
    await upsert(runner, record());

    expect(captured.snapshot.crawlRunId).toBe('run_1');
    expect(captured.update.snapshotCount).toEqual({ increment: 1 });
  });
});
