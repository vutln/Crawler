import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { RunStatus, type Marketplace } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CrawlRunnerService } from '../pipeline/crawl-runner.service';
import { sleep } from '../politeness/throttle.service';
import type { ICrawlQueue } from './crawl-queue.interface';

/**
 * Longest a LANE will hold for its own host's cooldown before giving up and
 * letting its remaining runs fail fast.
 *
 * This is the full backoff ceiling (CRAWL_MAX_BACKOFF_MS), not a fraction of it,
 * and that is the whole point of lanes. It used to be 5 minutes because the queue
 * was one lane and waiting out Amazon also stalled eBay and Etsy — the cap bought
 * the other two sites their turn, at the cost of stampeding the rest of Amazon's
 * batch into a wall that was still up. Now a cooldown costs only its own
 * marketplace, so there is no longer anything to trade away: wait the real number.
 *
 * Still capped rather than unbounded, because cooldownMs comes from the throttle
 * and a bug there should cost one lane an idle quarter-hour, not the process.
 */
const MAX_LANE_COOLDOWN_MS = 15 * 60_000;

/** One marketplace's serialized queue. Lanes are independent by construction. */
interface Lane {
  readonly marketplace: Marketplace;
  readonly pending: string[];
  active: string | null;
  draining: boolean;
}

/**
 * Single-process FIFO queue, serialized PER MARKETPLACE and concurrent across them.
 *
 * Concurrency within a lane is deliberately 1: the bottleneck is politeness, not
 * CPU, and running two crawls of the same site at once just means hitting that
 * domain twice as fast — precisely what gets a collector blocked.
 *
 * Concurrency ACROSS lanes is the point. Amazon walling costs Amazon a cooldown
 * and costs eBay and Etsy nothing, because they are different hosts and the
 * throttle is already keyed by host. Before this, one Amazon wall could hold the
 * only lane for minutes while eBay's whole day sat behind it.
 *
 * Not threads. Every lane is an async loop on the one Node thread, which is all
 * this workload needs — a crawl is almost entirely waiting on a network or a
 * browser, so a thread would spend its life parked on await. The real parallelism
 * lives in Chrome, one OS process per driver, bounded by SELENIUM_MAX_DRIVERS —
 * which must be >= the number of marketplaces or lanes will queue on drivers
 * instead of running.
 *
 * Known limitation, accepted by design: queued runs do not survive a restart.
 * onModuleDestroy marks orphans FAILED rather than leaving them RUNNING forever
 * — a lie in the dashboard is worse than an honest failure. If durability
 * becomes a requirement, implement ICrawlQueue with BullMQ; nothing else changes.
 */
@Injectable()
export class InMemoryCrawlQueue
  implements ICrawlQueue, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(InMemoryCrawlQueue.name);
  private readonly lanes = new Map<Marketplace, Lane>();
  private readonly cancelled = new Set<string>();
  private shuttingDown = false;
  /** Aborts every lane's cooldown wait so shutdown isn't held hostage — see coolDown(). */
  private readonly shutdown = new AbortController();

  constructor(
    private readonly runner: CrawlRunnerService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Fail every run left QUEUED or RUNNING by a previous process.
   *
   * onModuleDestroy already does this on a GRACEFUL shutdown — but it is a lifecycle
   * hook, so it never runs on the shutdowns that actually strand things: SIGKILL,
   * `taskkill /F`, an OOM kill, a crash, a power cut. After one of those the database
   * still says RUNNING and nothing in the process knows otherwise.
   *
   * That is not a cosmetic lie. Both trigger paths refuse a job with an outstanding
   * run — CrawlJobsService.trigger throws "already has a run queued or in progress"
   * and the cron logs "previous run still in progress" — so a single hard kill
   * PERMANENTLY disables that job. No timeout expires it, no retry clears it, and
   * the only cure is editing the database by hand. The dashboard's active-run count
   * is wrong forever too.
   *
   * Sound because this queue is single-process and in-memory (see the class note):
   * at bootstrap `lanes` is empty, so nothing can legitimately be in flight, and any
   * such row is by definition a corpse. That reasoning is the ONLY thing making a
   * blanket updateMany safe here — it would be actively destructive under a
   * multi-instance deployment, where one booting instance would kill another's live
   * runs. A durable queue (BullMQ) is the answer if this ever runs more than once;
   * ICrawlQueue exists so that swap stays cheap.
   *
   * FAILED, not re-queued: the run may have written products before dying, so
   * re-running it silently is not obviously safe, and a wrong status is worse than
   * an honest failure. The error text says what happened so it does not read as a
   * crawl fault.
   */
  async onApplicationBootstrap(): Promise<void> {
    const { count } = await this.prisma.crawlRun.updateMany({
      where: { status: { in: [RunStatus.QUEUED, RunStatus.RUNNING] } },
      data: {
        status: RunStatus.FAILED,
        finishedAt: new Date(),
        error:
          'Server stopped before this run finished — recovered at startup, not a crawl failure',
      },
    });

    if (count > 0) {
      this.logger.warn(
        `Recovered ${count} run(s) left QUEUED/RUNNING by a previous process and ` +
          `marked them FAILED. Their jobs can be triggered again.`,
      );
    }
  }

  async enqueue(runId: string, marketplace: Marketplace): Promise<void> {
    if (this.shuttingDown) throw new Error('Queue is shutting down');

    const lane = this.laneFor(marketplace);
    lane.pending.push(runId);
    this.logger.log(
      `Enqueued ${runId} on ${marketplace} (lane depth: ${lane.pending.length}, ` +
        `total: ${this.size()})`,
    );

    // Intentionally not awaited: enqueue must return so the HTTP request can
    // respond immediately with a QUEUED run. The lane's drain loop owns the work.
    void this.drain(lane);
  }

  async cancel(runId: string): Promise<boolean> {
    for (const lane of this.lanes.values()) {
      if (lane.active === runId) return this.runner.cancel(runId);

      const index = lane.pending.indexOf(runId);
      if (index === -1) continue;

      lane.pending.splice(index, 1);
      this.cancelled.add(runId);
      await this.prisma.crawlRun.update({
        where: { id: runId },
        data: { status: RunStatus.CANCELLED, finishedAt: new Date() },
      });
      return true;
    }
    return false;
  }

  /** Queued across every lane. */
  size(): number {
    let total = 0;
    for (const lane of this.lanes.values()) total += lane.pending.length;
    return total;
  }

  /** True while ANY lane has a run in flight. */
  isBusy(): boolean {
    for (const lane of this.lanes.values()) if (lane.active) return true;
    return false;
  }

  private laneFor(marketplace: Marketplace): Lane {
    let lane = this.lanes.get(marketplace);
    if (!lane) {
      // Created on first use rather than seeded from the enum: a marketplace with
      // no jobs should cost nothing, and this cannot go stale when the enum grows.
      lane = { marketplace, pending: [], active: null, draining: false };
      this.lanes.set(marketplace, lane);
    }
    return lane;
  }

  private async drain(lane: Lane): Promise<void> {
    // One loop PER LANE. Re-entrancy would break serialization within the lane,
    // which is the guarantee that keeps us from hammering a single host.
    if (lane.draining) return;
    lane.draining = true;

    try {
      while (lane.pending.length > 0 && !this.shuttingDown) {
        const runId = lane.pending.shift()!;
        if (this.cancelled.delete(runId)) continue;

        lane.active = runId;
        try {
          const outcome = await this.runner.execute(runId);

          /**
           * Wait out a wall instead of stampeding the rest of THIS LANE through it.
           *
           * This exists because of fan-out. A wall costs the host ~128s of backoff,
           * during which navigate() refuses to knock and fails in MILLISECONDS —
           * failing fast is far quicker than the cooldown, so with 20 keywords
           * queued back to back, one block at keyword 5 would burn keywords 6..20
           * in a few seconds and mark them all BLOCKED. A whole day of that
           * marketplace's data, destroyed by a single wall.
           *
           * Not a retry: the blocked run stays BLOCKED and is not re-run. This only
           * decides when the next run IN THIS LANE is allowed to knock, and it never
           * shortens the cooldown — the host is owed exactly as long either way.
           *
           * Other lanes keep running throughout. That is the whole reason the wait
           * can now be the full cooldown instead of a compromise.
           */
          if (outcome.status === RunStatus.BLOCKED && outcome.cooldownMs) {
            await this.coolDown(lane, outcome.cooldownMs);
          }
        } catch (err) {
          // execute() records its own failures; this only catches a runner bug.
          // Swallowing here is essential — one bad run must not kill the loop
          // and strand every queued run behind it. Scoped to one lane either way.
          this.logger.error(
            `Unhandled error draining ${runId} on ${lane.marketplace}: ` +
              `${(err as Error).message}`,
          );
        } finally {
          lane.active = null;
        }
      }
    } finally {
      lane.draining = false;
    }
  }

  private async coolDown(lane: Lane, cooldownMs: number): Promise<void> {
    if (lane.pending.length === 0 || this.shuttingDown) return;

    const waitMs = Math.min(cooldownMs, MAX_LANE_COOLDOWN_MS);
    this.logger.warn(
      `${lane.marketplace} walled — holding that lane ${Math.round(waitMs / 1000)}s before ` +
        `its next run (${lane.pending.length} still queued for it). Other marketplaces ` +
        `are unaffected.`,
    );

    try {
      await sleep(waitMs, this.shutdown.signal);
    } catch {
      // Aborted by shutdown. The loop's own shuttingDown check ends things.
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    // Release every lane's cooldown wait immediately: without this, shutdown would
    // block for up to MAX_LANE_COOLDOWN_MS behind a sleeping drain loop.
    this.shutdown.abort();

    const orphans: string[] = [];
    for (const lane of this.lanes.values()) {
      if (lane.active) {
        this.runner.cancel(lane.active);
        orphans.push(lane.active);
      }
      orphans.push(...lane.pending);
    }

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
