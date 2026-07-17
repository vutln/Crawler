import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
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
