import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { RunStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CrawlRunnerService } from '../pipeline/crawl-runner.service';
import type { ICrawlQueue } from './crawl-queue.interface';

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
          await this.runner.execute(runId);
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

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
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
