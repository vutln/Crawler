import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/** `"true"`/`"false"` from .env are strings; coerce before @IsBoolean sees them. */
const toBool = () =>
  Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  });

export class EnvVars {
  @IsEnum(NodeEnv)
  @IsOptional()
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(1)
  @Max(65535)
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsOptional()
  PORT = 3000;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @IsOptional()
  TEST_DATABASE_URL?: string;

  @IsBoolean()
  @toBool()
  @IsOptional()
  SELENIUM_HEADLESS = true;

  @IsInt()
  @Min(1000)
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsOptional()
  SELENIUM_TIMEOUT_MS = 30_000;

  /**
   * Concurrent Chrome instances. 3 = one per marketplace.
   *
   * This is the real ceiling on the queue's per-marketplace lanes: each lane needs
   * a driver to crawl, so at 2 the third lane sits waiting on WebDriverFactory
   * rather than running, and a third of the concurrency the lanes exist to provide
   * never materializes. Raise this alongside any new Selenium marketplace.
   *
   * The cost is memory — roughly 200-400MB per Chrome — so this is the knob to
   * turn DOWN on a small box, accepting that lanes then take turns.
   */
  @IsInt()
  @Min(1)
  @Max(8)
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsOptional()
  SELENIUM_MAX_DRIVERS = 3;

  @IsInt()
  @Min(0)
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsOptional()
  CRAWL_MIN_DELAY_MS = 2000;

  @IsInt()
  @Min(0)
  @Max(10)
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsOptional()
  CRAWL_MAX_RETRIES = 3;

  /**
   * Ceiling on per-domain exponential backoff. A detected wall costs several
   * steps at once, so this is what a repeatedly-blocked host actually waits.
   * Default 15min: an Amazon soft block lifts on a scale of minutes-to-hours,
   * and the old 60s ceiling was noise against that.
   */
  @IsInt()
  @Min(0)
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsOptional()
  CRAWL_MAX_BACKOFF_MS = 900_000;

  /**
   * How many times navigate() may load a page again when the block it hit might
   * not be a real wall. Total attempts are 1 + this.
   *
   * Applies to exactly two kinds of signal, both of which the detector marks
   * explicitly: an AMBIGUOUS page (the marketplace error page, which is served for
   * genuine 5xx blips as well as soft blocks) and a SELF-RESOLVING interstitial
   * (a "checking your browser" page that hands control back on its own).
   *
   * It never applies to an explicit refusal — a CAPTCHA, a DataDome challenge, an
   * automated-access notice. Those answered in words, and reloading them is a
   * retry loop against a host that is already saying no.
   */
  @IsInt()
  @Min(0)
  @Max(5)
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsOptional()
  CRAWL_MAX_BLOCK_RELOADS = 2;

  /**
   * How long to let a self-resolving interstitial finish before reloading it.
   *
   * Some bot checks are a holding page: they run a JS check and then send the
   * browser on to the page you asked for. Waiting costs no requests at all and is
   * the politest possible response — we are doing what the site asked.
   *
   * Measured 2026-07-20, and worth knowing before raising this: Etsy's DataDome
   * challenge did NOT self-resolve — static for 63s across 2 reloads — so it is
   * NOT marked self-resolving and never reaches this wait. Raising this number
   * only makes genuine walls slower to report.
   */
  @IsInt()
  @Min(0)
  @Max(120_000)
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsOptional()
  CRAWL_INTERSTITIAL_WAIT_MS = 20_000;

  /**
   * Hard ceiling on a single run, after which it is aborted and marked FAILED.
   *
   * A watchdog, not a performance budget. Nothing else bounds a run: Selenium's
   * own timeouts cover one page load, so a driver that stops responding between
   * them, or an adapter loop that never terminates, leaves the run RUNNING for as
   * long as the process lives. Both trigger paths refuse a job with an outstanding
   * run, so one hung run disables that job indefinitely.
   *
   * Generous on purpose — a 2-page crawl that waits out a 15-minute repeat-block
   * cooldown is slow but healthy, and killing it would destroy real work. This
   * fires only for runs that are genuinely stuck.
   */
  @IsInt()
  @Min(60_000)
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsOptional()
  CRAWL_RUN_TIMEOUT_MS = 1_800_000; // 30 minutes

  @IsBoolean()
  @toBool()
  @IsOptional()
  CRAWL_RESPECT_ROBOTS = true;

  /**
   * IANA timezone the daily sweep's cron expressions are interpreted in.
   *
   * Load-bearing for a US-market collector, and wrong by default without it. The
   * `cron` package uses the SERVER's local time when no timezone is given, so on
   * this machine (ICT) "0 0 6 * * *" fires at 06:00 Vietnam time — 23:00 UTC the
   * PREVIOUS day. Every snapshot's capturedAt then lands in a US timezone's
   * yesterday, and ProductsService.priceHistory buckets by MySQL's DATE_FORMAT,
   * so a "daily" price series silently splits across day boundaries.
   *
   * Defaults to UTC rather than America/New_York: UTC is the choice that behaves
   * identically wherever this runs, which is the property a default should have.
   * Set America/New_York if you want buckets aligned to the US market day.
   *
   * Validated by the `cron` package at registration; a bad value is logged and the
   * job is skipped, never a boot failure — see SchedulerService.register.
   */
  @IsString()
  @IsOptional()
  CRAWL_TIMEZONE = 'UTC';

  /**
   * Empty = send Chrome's own user-agent (the truthful default).
   * Set a value only to identify your crawler with something more specific.
   * Note the trade-off measured against Amazon: a non-browser UA gets the same
   * listings but with every price stripped. See README.
   */
  @IsString()
  @IsOptional()
  CRAWL_USER_AGENT = '';

  // Optional API credentials. Presence flips the adapter registry from the
  // Selenium adapter to the official-API adapter for that marketplace.
  @IsString()
  @IsOptional()
  EBAY_APP_ID?: string;

  @IsString()
  @IsOptional()
  EBAY_CERT_ID?: string;

  @IsString()
  @IsOptional()
  ETSY_API_KEY?: string;

  @IsString()
  @IsOptional()
  CRAWL_EXTRA_HEADERS_JSON = '{}';

  @IsString()
  @IsOptional()
  CRAWL_COOKIES_JSON = '[]';

  /**
   * US ZIP to set as the browser session's delivery address. Empty = don't set one.
   *
   * Amazon hides the price on any listing it can't ship to the session's address,
   * and with no address it infers one from the egress IP — so a non-US egress gets
   * listings back with title and reviews but no price. Naming a US ZIP is what makes
   * those prices visible, and is the delivery half of the US-market requirement
   * that CRAWL_COOKIES_JSON's i18n-prefs=USD only covers the currency half of.
   *
   * Unlike the currency, this is NOT a cookie and cannot be seeded: Amazon holds the
   * address server-side against the session, so AmazonSeleniumAdapter sets it through
   * the site's own location widget on each new browser.
   */
  @IsString()
  @IsOptional()
  @Matches(/^\d{5}$/, {
    message:
      'AMAZON_DELIVERY_ZIP must be a 5-digit US ZIP (e.g. 00501), or empty to not set one',
  })
  AMAZON_DELIVERY_ZIP = '';
}

export function validateEnv(raw: Record<string, unknown>): EnvVars {
  // Empty strings in .env (e.g. `EBAY_APP_ID=`) should read as "unset", not "".
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== ''),
  );

  const config = plainToInstance(EnvVars, cleaned, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const errors = validateSync(config, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors
      .map(
        (e) =>
          `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
      )
      .join('\n');
    // Fail at boot with something actionable rather than a null-deref 40 frames deep.
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return config;
}
