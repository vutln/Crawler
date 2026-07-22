import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  RunStatus,
  type CrawlJob,
  type Keyword,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AdapterRegistry } from '../adapters/adapter.registry';
import {
  BlockedError,
  type CrawlContext,
  type ProductRecord,
} from '../adapters/adapter.interface';
import { UNKNOWN_CURRENCY } from '../normalize';

export interface RunOutcome {
  status: RunStatus;
  itemsFound: number;
  itemsNew: number;
  itemsUpdated: number;
  error?: string;
  /**
   * On BLOCKED: how long the walled host is owed. Not persisted — it is advice to
   * the queue, which uses it to wait out the cooldown rather than stampede the
   * rest of the batch through it. See InMemoryCrawlQueue.drain.
   */
  cooldownMs?: number;
}

/** Mutable running tally, shared with collect() so a partial run still reports truthfully. */
interface Tally {
  found: number;
  created: number;
  updated: number;
}

function toCounts(
  t: Tally,
): Pick<RunOutcome, 'itemsFound' | 'itemsNew' | 'itemsUpdated'> {
  return { itemsFound: t.found, itemsNew: t.created, itemsUpdated: t.updated };
}

/**
 * Executes one CrawlRun: resolve adapter -> stream records -> persist.
 *
 * Knows nothing about Selenium, HTTP, or any specific marketplace. That is the
 * dividend of the adapter interface — this file never changes when a site is
 * added or when a site's DOM shifts.
 */
@Injectable()
export class CrawlRunnerService {
  private readonly logger = new Logger(CrawlRunnerService.name);

  /** runId -> controller, so a run can be cancelled while in flight. */
  private readonly inFlight = new Map<string, AbortController>();

  private readonly runTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AdapterRegistry,
    config: ConfigService,
  ) {
    this.runTimeoutMs = config.get<number>('CRAWL_RUN_TIMEOUT_MS', 1_800_000);
  }

  async execute(runId: string): Promise<RunOutcome> {
    const run = await this.prisma.crawlRun.findUnique({
      where: { id: runId },
      include: { job: true, keyword: true },
    });
    if (!run) throw new Error(`CrawlRun ${runId} not found`);

    const controller = new AbortController();
    this.inFlight.set(runId, controller);

    /**
     * Watchdog. Nothing else bounds a run's total duration.
     *
     * Selenium's timeouts cover a single page load, so a driver that stops
     * responding between them — or an adapter loop that never terminates — leaves
     * this run RUNNING for as long as the process lives. Because both trigger paths
     * refuse a job that has an outstanding run, that one run disables the job
     * indefinitely; the queue lane it holds never advances either.
     *
     * Reuses the cancellation path rather than adding a second kill mechanism: the
     * adapters already check ctx.signal at every page boundary, so an abort unwinds
     * exactly as a user-initiated cancel does. `timedOut` is what keeps the two
     * distinguishable afterwards — a watchdog kill is a FAILURE to report, not a
     * CANCELLED that implies somebody chose it.
     */
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      this.logger.error(
        `Run ${runId} exceeded CRAWL_RUN_TIMEOUT_MS (${Math.round(
          this.runTimeoutMs / 1000,
        )}s) — aborting so it cannot block its job forever`,
      );
      controller.abort();
    }, this.runTimeoutMs);

    await this.prisma.crawlRun.update({
      where: { id: runId },
      data: { status: RunStatus.RUNNING, startedAt: new Date() },
    });

    // Counters live out here, not inside collect(), because a run that gets
    // blocked on page 2 has ALREADY written page 1's rows. If the tally were
    // scoped to collect() it would be lost on throw and the run would report
    // "0 found" while the products sit in the database — the status would
    // contradict the data.
    const stats: Tally = { found: 0, created: 0, updated: 0 };

    let outcome: RunOutcome;
    try {
      outcome = await this.collect(
        run.job,
        runId,
        controller.signal,
        stats,
        run.keyword,
      );
    } catch (err) {
      outcome = { ...this.classify(err), ...toCounts(stats) };
      this.logger.error(`Run ${runId} failed: ${outcome.error}`);
    } finally {
      clearTimeout(watchdog);
      this.inFlight.delete(runId);
    }

    /**
     * A watchdog abort must not masquerade as a cancellation.
     *
     * collect() reports CANCELLED for any aborted signal, which is right when a
     * human pressed cancel and wrong here — CANCELLED reads as "somebody chose to
     * stop this", and a run that hung for half an hour is a fault worth surfacing.
     * Applied after the try so it covers both paths: a clean unwind at the next
     * signal check, and a throw from whatever the abort interrupted.
     */
    if (timedOut) {
      outcome = {
        status: RunStatus.FAILED,
        error:
          `Run exceeded CRAWL_RUN_TIMEOUT_MS (${Math.round(this.runTimeoutMs / 1000)}s) ` +
          `and was aborted. Anything collected before that point was kept.`,
        ...toCounts(stats),
      };
    }

    await this.prisma.crawlRun.update({
      where: { id: runId },
      data: {
        status: outcome.status,
        finishedAt: new Date(),
        itemsFound: outcome.itemsFound,
        itemsNew: outcome.itemsNew,
        itemsUpdated: outcome.itemsUpdated,
        error: outcome.error ?? null,
      },
    });

    this.logger.log(
      `Run ${runId} ${outcome.status}: ${outcome.itemsFound} found, ` +
        `${outcome.itemsNew} new, ${outcome.itemsUpdated} updated`,
    );
    return outcome;
  }

  cancel(runId: string): boolean {
    const controller = this.inFlight.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async collect(
    job: CrawlJob,
    runId: string,
    signal: AbortSignal,
    stats: Tally,
    keyword: Keyword | null,
  ): Promise<RunOutcome> {
    const adapter = this.registry.resolve(job.marketplace);
    const logger = new Logger(`${adapter.name}:${runId.slice(0, 8)}`);

    const ctx: CrawlContext = {
      /**
       * The run's keyword is the only source of a search term now — CrawlJob has no
       * `query` column. PRODUCT_URLS runs carry no keyword and need none; they read
       * ctx.urls instead.
       *
       * Note the adapters still just receive a query string and know nothing about
       * keywords or sweeps. This line is the whole seam.
       */
      query: keyword?.text,
      urls: Array.isArray(job.urls) ? (job.urls as string[]) : undefined,
      maxPages: job.maxPages,
      /**
       * null means "no item cap" — translated to Infinity here, at the one
       * boundary where job config becomes crawl config.
       *
       * Every adapter already guards with `emitted >= ctx.maxItems`, which is
       * correct against Infinity for free. Widening CrawlContext.maxItems to
       * `number | null` instead would push a null check into 9 call sites across
       * 5 adapters and buy nothing.
       */
      maxItems: job.maxItems ?? Number.POSITIVE_INFINITY,
      signal,
      logger,
    };

    // Persist per record rather than batching at the end: a run that dies on
    // item 90 of 100 should keep the 89 it already collected. Partial data beats
    // no data for a price series.
    const persist = async (record: ProductRecord) => {
      stats.found++;
      // stats.found IS the 1-based position within this run, and adapters yield in
      // page order — so rank costs nothing extra to capture and is the only way to
      // answer "did we slip off page 1 for this keyword".
      const result = await this.upsert(
        record,
        job.marketplace,
        runId,
        keyword?.id,
        stats.found,
      );
      if (result === 'created') stats.created++;
      else stats.updated++;
    };

    if (job.type === 'PRODUCT_URLS') {
      for (const url of ctx.urls ?? []) {
        if (signal.aborted) break;
        const record = await adapter.fetchProduct(url, ctx);
        if (record) await persist(record);
      }
    } else {
      for await (const record of adapter.search(ctx)) {
        if (signal.aborted) break;
        await persist(record);
      }
    }

    return {
      status: signal.aborted ? RunStatus.CANCELLED : RunStatus.SUCCEEDED,
      ...toCounts(stats),
    };
  }

  /**
   * Upsert identity, then ALWAYS append a price snapshot.
   *
   * This is the core invariant of the whole project: prices are never updated in
   * place. Product holds slow-changing identity; every observation of a price
   * becomes a new immutable row. Overwrite the price and you have a scraper —
   * append it and you have a collector.
   */
  private async upsert(
    record: ProductRecord,
    marketplace: CrawlJob['marketplace'],
    runId: string,
    keywordId?: string,
    rank?: number,
  ): Promise<'created' | 'updated'> {
    const existing = await this.prisma.product.findUnique({
      where: {
        marketplace_externalId: { marketplace, externalId: record.externalId },
      },
      select: { id: true },
    });

    /**
     * Only what this adapter actually produced.
     *
     * These were `?? null`, and that spread into `update:` wrote NULL over every
     * field the running adapter doesn't collect. Not hypothetical: ebay-api has
     * no product review counts and outranks ebay-selenium (priority 100 vs 10),
     * so setting EBAY_APP_ID didn't merely stop adding review counts — it erased
     * the ones ebay-selenium had already stored, on every run, silently.
     *
     * Leaving them `undefined` is load-bearing: Prisma omits undefined fields
     * from the UPDATE entirely, and falls back to the column default on INSERT.
     * So `undefined` = "this adapter didn't look" = don't touch, while an
     * explicit null would still mean "it looked and found nothing".
     */
    const identity = {
      url: record.url,
      title: record.title,
      brand: record.brand,
      seller: record.seller,
      imageUrl: record.imageUrl,
      rating:
        record.rating != null ? new Prisma.Decimal(record.rating) : undefined,
      reviewCount: record.reviewCount,
    };

    /**
     * A price we cannot label is not a price.
     *
     * Refusing it here is what makes the currency honest end to end: parsePrice
     * happily reads "3.674.457" off an Amazon card as 3674457 with no symbol, and
     * storing that under a guessed USD is how ₫ prices became $3,674,457.
     */
    const labelled = record.currency !== null;
    const price =
      labelled && record.price != null
        ? new Prisma.Decimal(record.price)
        : null;

    if (record.price != null && !labelled) {
      this.logger.warn(
        `${marketplace} ${record.externalId}: price ${record.price} has no detectable ` +
          `currency — storing price as null rather than guessing one.`,
      );
    }

    // One transaction: the snapshot and the denormalized mirror on Product must
    // land together or not at all. If these could diverge, the products list
    // would show a price that no snapshot in the history actually contains.
    await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.upsert({
        where: {
          marketplace_externalId: {
            marketplace,
            externalId: record.externalId,
          },
        },
        create: {
          marketplace,
          externalId: record.externalId,
          ...identity,
          // Column is NOT NULL, so an unknown currency needs a value. XXX is the
          // ISO-4217 code for "no currency involved" and it always rides with a
          // null price — never a number wearing a currency we invented.
          currency: record.currency ?? UNKNOWN_CURRENCY,
          currentPrice: price,
          inStock: record.inStock,
          snapshotCount: 1,
        },
        update: {
          ...identity,
          // Same rule as `identity`: don't let a run that failed to read the
          // currency overwrite one an earlier run read correctly.
          ...(record.currency !== null && { currency: record.currency }),
          currentPrice: price,
          inStock: record.inStock,
          snapshotCount: { increment: 1 },
        },
        select: { id: true },
      });

      // Append-only. Never an update — this row is the history.
      await tx.priceSnapshot.create({
        data: {
          productId: product.id,
          price,
          currency: record.currency ?? UNKNOWN_CURRENCY,
          inStock: record.inStock,
          seller: record.seller ?? null,
          crawlRunId: runId,
        },
      });

      /**
       * Which keyword surfaced this product. Inside the SAME transaction as the
       * snapshot: a product row with no link would be invisible to the results
       * screen's keyword filter while its price history quietly accumulated.
       *
       * Upsert, not create — a product legitimately reappears for the same keyword
       * every single day, and lastSeenAt/lastRank are what make that a time series
       * rather than a duplicate-key crash.
       */
      if (keywordId) {
        await tx.productKeyword.upsert({
          where: { productId_keywordId: { productId: product.id, keywordId } },
          create: {
            productId: product.id,
            keywordId,
            marketplace,
            lastRank: rank,
          },
          update: { lastSeenAt: new Date(), lastRank: rank },
        });
      }
    });

    return existing ? 'updated' : 'created';
  }

  /** Map a thrown error onto a run status the dashboard can act on. */
  private classify(err: unknown): RunOutcome {
    const base = { itemsFound: 0, itemsNew: 0, itemsUpdated: 0 };

    if (err instanceof BlockedError) {
      // Not a crash — the site refused us. Distinct status so a BLOCKED run is
      // never mistaken for a bug or for a genuinely empty result set.
      return {
        ...base,
        status: RunStatus.BLOCKED,
        error: `${err.message}${err.evidence ? ` | evidence: ${err.evidence}` : ''}`,
        cooldownMs: err.retryAfterMs,
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    if (/abort/i.test(message)) {
      return { ...base, status: RunStatus.CANCELLED, error: 'Cancelled' };
    }

    return { ...base, status: RunStatus.FAILED, error: message.slice(0, 2000) };
  }
}
