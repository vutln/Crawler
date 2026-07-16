import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import robotsParser, { type Robot } from 'robots-parser';

interface CacheEntry {
  robot: Robot | null;
  fetchedAt: number;
}

/**
 * robots.txt gate. Checked before every fetch when CRAWL_RESPECT_ROBOTS=true.
 *
 * Fetched with plain HTTP, not Selenium — spinning up Chrome to read a text file
 * would be absurd, and robots.txt is never JS-rendered.
 */
@Injectable()
export class RobotsService {
  private readonly logger = new Logger(RobotsService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs = 60 * 60 * 1000; // 1h — robots.txt is not volatile
  private readonly enabled: boolean;
  private readonly userAgent: string;

  constructor(private readonly config: ConfigService) {
    this.enabled = this.config.get<boolean>('CRAWL_RESPECT_ROBOTS', true);
    // Used for two things: the UA header when fetching robots.txt, and matching
    // it against User-agent groups. Either value falls through to the `*` group
    // (we match no named-bot group), so rule evaluation is identical whether or
    // not CRAWL_USER_AGENT is set.
    this.userAgent =
      this.config.get<string>('CRAWL_USER_AGENT') || 'Mozilla/5.0 (compatible; EcomCollector/1.0)';
  }

  async isAllowed(url: string): Promise<boolean> {
    if (!this.enabled) return true;

    const robot = await this.load(url);
    // No robots.txt (404) or unreachable => not a prohibition. Standard behaviour.
    if (!robot) return true;

    return robot.isAllowed(url, this.userAgent) ?? true;
  }

  /** Site-declared politeness. When present it overrides our own floor if stricter. */
  async crawlDelayMs(url: string): Promise<number | null> {
    if (!this.enabled) return null;
    const robot = await this.load(url);
    const seconds = robot?.getCrawlDelay(this.userAgent);
    return typeof seconds === 'number' ? seconds * 1000 : null;
  }

  private async load(url: string): Promise<Robot | null> {
    let origin: string;
    let robotsUrl: string;
    try {
      const parsed = new URL(url);
      origin = parsed.origin;
      robotsUrl = `${origin}/robots.txt`;
    } catch {
      return null;
    }

    const cached = this.cache.get(origin);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) return cached.robot;

    let robot: Robot | null = null;
    try {
      const res = await fetch(robotsUrl, {
        headers: { 'User-Agent': this.userAgent },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        robot = robotsParser(robotsUrl, await res.text());
      } else {
        this.logger.debug(`${robotsUrl} -> HTTP ${res.status}; treating as unrestricted`);
      }
    } catch (err) {
      // Network failure is not consent, but it is also not a ban. Log and allow;
      // the throttle still paces us.
      this.logger.warn(`Could not fetch ${robotsUrl}: ${(err as Error).message}`);
    }

    this.cache.set(origin, { robot, fetchedAt: Date.now() });
    return robot;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
