import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { RunStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CrawlRunnerService } from '../pipeline/crawl-runner.service';
import { sleep } from '../politeness/throttle.service';
import type { ICrawlQueue } from './crawl-queue.interface';

/**
 * Longest the queue will hold for one host's cooldown before giving up and just
 * letting the remaining runs fail fast.
 *
 * A cap exists because this queue is a single lane: waiting out Amazon also stalls
 * eBay and Etsy. 5 minutes absorbs the common case whole — a first wall costs 6
 * backoff steps, ~128s at the default floor — while bounding the damage when a
 * host is deep into a repeat cooldown (which reaches the 15-minute ceiling).
 *
 * If this cap starts being hit, the real fix is per-marketplace lanes, not a
 * bigger number: then Amazon's cooldown costs Amazon nothing but time.
 */
const MAX_QUEUE_COOLDOWN_MS = 5 * 60_000;

/**
 * Single-process FIFO queue with concurrency 1.
 *
 * Concurrency is deliberately 1: the bottleneck is politeness, not CPU. Running
 * crawls in parallel just means hitting the same domain twice as fast, which is
 * precisely what gets a collector blocked.
 *
 * Known limitation, accepted by design: queued runs do not survive a restart.
 * onModuleDestroy marks orphans FAILED rather than leaving them RUNNING forever
 * — a lie in the dashboard is worse than an honest failure. If durability
 * becomes a requirement, implement ICrawlQueue with BullMQ; nothing else changes.
 */
@Injectable()
export class InMemoryCrawlQueue implements ICrawlQueue, OnModuleDestroy {
  private readonly logger = new Logger(InMemoryCrawlQueue.name);
  private readonly pending: string[] = [];
  private readonly cancelled = new Set<string>();
  private active: string | null = null;
  private draining = false;
  private shuttingDown = false;
  /** Aborts a cooldown wait so shutdown isn't held hostage by one — see coolDown(). */
  private readonly shutdown = new AbortController();

  constructor(
    private readonly runner: CrawlRunnerService,
    private readonly prisma: PrismaService,
  ) {}

  async enqueue(runId: string): Promise<void> {
    if (this.shuttingDown) throw new Error('Queue is shutting down');
    this.pending.push(runId);
    this.logger.log(`Enqueued ${runId} (depth: ${this.pending.length})`);
    // Intentionally not awaited: enqueue must return so the HTTP request can
    // respond immediately with a QUEUED run. The drain loop owns the work.
    void this.drain();
  }

  async cancel(runId: string): Promise<boolean> {
    if (this.active === runId) return this.runner.cancel(runId);

    const index = this.pending.indexOf(runId);
    if (index === -1) return false;

    this.pending.splice(index, 1);
    this.cancelled.add(runId);
    await this.prisma.crawlRun.update({
      where: { id: runId },
      data: { status: RunStatus.CANCELLED, finishedAt: new Date() },
    });
    return true;
  }

  size(): number {
    return this.pending.length;
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  private async drain(): Promise<void> {
    if (this.draining) return; // one loop only — re-entrancy would break serialization
    this.draining = true;

    try {
      while (this.pending.length > 0 && !this.shuttingDown) {
        const runId = this.pending.shift()!;
        if (this.cancelled.delete(runId)) continue;

        this.active = runId;
        try {
          const outcome = await this.runner.execute(runId);

          /**
           * Wait out a wall instead of stampeding the rest of the batch through it.
           *
           * This exists because of fan-out. A wall costs the host ~128s of backoff,
           * during which navigate() refuses to knock and fails in MILLISECONDS —
           * failing fast is far quicker than the cooldown, so with 20 keywords
           * queued back to back, one block at keyword 5 would burn keywords 6..20
           * in a few seconds and mark them all BLOCKED. A whole day of that
           * marketplace's data, destroyed by a single wall.
           *
           * Not a retry: the blocked run stays BLOCKED and is not re-run. This only
           * decides when the NEXT run is allowed to knock, and it never shortens
           * the cooldown — the host is owed exactly as long either way.
           */
          if (outcome.status === RunStatus.BLOCKED && outcome.cooldownMs) {
            await this.coolDown(outcome.cooldownMs);
          }
        } catch (err) {
          // execute() records its own failures; this only catches a runner bug.
          // Swallowing here is essential — one bad run must not kill the loop
          // and strand every queued run behind it.
          this.logger.error(`Unhandled error draining ${runId}: ${(err as Error).message}`);
        } finally {
          this.active = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async coolDown(cooldownMs: number): Promise<void> {
    if (this.pending.length === 0 || this.shuttingDown) return;

    const waitMs = Math.min(cooldownMs, MAX_QUEUE_COOLDOWN_MS);
    this.logger.warn(
      `Host walled — holding the queue ${Math.round(waitMs / 1000)}s before the next run ` +
        `(${this.pending.length} still queued). Knocking now would just fail them all.`,
    );

    try {
      await sleep(waitMs, this.shutdown.signal);
    } catch {
      // Aborted by shutdown. The loop's own shuttingDown check ends things.
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    // Release any cooldown wait immediately: without this, shutdown would block
    // for up to MAX_QUEUE_COOLDOWN_MS behind a sleeping drain loop.
    this.shutdown.abort();
    if (this.active) this.runner.cancel(this.active);

    const orphans = [this.active, ...this.pending].filter(Boolean) as string[];
    if (orphans.length === 0) return;

    this.logger.warn(`Shutting down with ${orphans.length} unfinished run(s); marking FAILED`);
    await this.prisma.crawlRun.updateMany({
      where: { id: { in: orphans }, status: { in: [RunStatus.QUEUED, RunStatus.RUNNING] } },
      data: {
        status: RunStatus.FAILED,
        finishedAt: new Date(),
        error: 'Server shut down before this run completed',
      },
    });
  }
}
