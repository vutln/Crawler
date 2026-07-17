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

  @IsInt()
  @Min(1)
  @Max(8)
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsOptional()
  SELENIUM_MAX_DRIVERS = 2;

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
