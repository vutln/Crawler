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
  private readonly headers: Record<string, string>;

  constructor(private readonly config: ConfigService) {
    this.enabled = this.config.get<boolean>('CRAWL_RESPECT_ROBOTS', true);

    // The UA here serves two purposes: the header on the robots.txt fetch, and the
    // token matched against User-agent groups. It has to resolve to whatever
    // WebDriverFactory actually puts on the wire — see its create(). An empty
    // CRAWL_USER_AGENT means Chrome sends its own HeadlessChrome/NNN, so the
    // EcomCollector string this used to invent was a third identity that nothing
    // else ever used: asking permission as one client and then crawling as another.
    //
    // That distinction is a no-op today — neither string matches a named group on
    // Amazon, eBay or Etsy, so both fall through to `*` and evaluate identically.
    // It stops being a no-op the day one of them writes a rule for headless
    // browsers, which is precisely the case where the answer should change and the
    // invented identity would have silently ignored it.
    //
    // No version: groups match on the product token, and Chrome's exact build isn't
    // knowable until a driver exists.
    const configured = this.config.get<string>('CRAWL_USER_AGENT');
    this.headers = {
      'User-Agent': configured || 'HeadlessChrome',
      Accept: 'text/plain,*/*;q=0.8',
    };
  }

  private get userAgent(): string {
    return this.headers['User-Agent'];
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
        headers: this.headers,
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
