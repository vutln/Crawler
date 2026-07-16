/**
 * The seam that keeps BullMQ an option without paying for Redis today.
 * Callers depend on this token, never on the implementation.
 */
export interface ICrawlQueue {
  /** Enqueue a persisted CrawlRun. Returns immediately. */
  enqueue(runId: string): Promise<void>;

  /** Abort a running job, or drop it if it hasn't started. */
  cancel(runId: string): Promise<boolean>;

  size(): number;
  isBusy(): boolean;
}

export const CRAWL_QUEUE = Symbol('CRAWL_QUEUE');
