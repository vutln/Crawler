import type { Marketplace } from '../../generated/prisma/client';

/**
 * The seam that keeps BullMQ an option without paying for Redis today.
 * Callers depend on this token, never on the implementation.
 */
export interface ICrawlQueue {
  /**
   * Enqueue a persisted CrawlRun. Returns immediately.
   *
   * `marketplace` is the LANE key, not decoration: runs are serialized against
   * others for the same marketplace and run concurrently with the rest, so one
   * site's cooldown cannot stall another's. The caller passes it because the
   * caller already holds the job — looking it up here would mean a database
   * round trip per enqueue, N times per sweep, for something already in hand.
   */
  enqueue(runId: string, marketplace: Marketplace): Promise<void>;

  /** Abort a running job, or drop it if it hasn't started. */
  cancel(runId: string): Promise<boolean>;

  size(): number;
  isBusy(): boolean;
}

export const CRAWL_QUEUE = Symbol('CRAWL_QUEUE');
