/**
 * Demo data so the dashboard isn't a wall of empty states before the first crawl.
 *
 * Deliberately generates *multi-point price history* rather than a flat product
 * list — a single snapshot per product would leave the price chart (the whole
 * reason this project exists) with nothing to draw.
 *
 * Run: npm run db:seed
 */
import path from 'node:path';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient, CrawlJobType, Marketplace, RunStatus, RunTrigger } from '../src/generated/prisma/client';

// Self-sufficient on purpose. `prisma db seed` would load prisma.config.ts (which
// reads .env) first, but `npm run db:seed` invokes tsx directly and skips it —
// leaving DATABASE_URL undefined and `new URL('')` throwing an opaque
// ERR_INVALID_URL. Load it here so both entry points work.
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // no .env — fall through to ambient env vars (CI)
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const url = new URL(process.env.DATABASE_URL);
const adapter = new PrismaMariaDb({
  host: url.hostname,
  port: url.port ? Number(url.port) : 3306,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ''),
});

const prisma = new PrismaClient({ adapter });

interface SeedProduct {
  marketplace: Marketplace;
  externalId: string;
  title: string;
  brand: string;
  seller: string;
  basePrice: number;
  currency: string;
  rating: number;
  reviewCount: number;
  url: string;
}

const PRODUCTS: SeedProduct[] = [
  {
    marketplace: Marketplace.AMAZON,
    externalId: 'B0DEMO0001',
    title: 'Wireless Mechanical Keyboard, 75% Hot-Swappable RGB',
    brand: 'Keychron',
    seller: 'Amazon.com',
    basePrice: 94.99,
    currency: 'USD',
    rating: 4.6,
    reviewCount: 3820,
    url: 'https://www.amazon.com/dp/B0DEMO0001',
  },
  {
    marketplace: Marketplace.AMAZON,
    externalId: 'B0DEMO0002',
    title: 'Noise Cancelling Over-Ear Headphones, 40h Battery',
    brand: 'Sony',
    seller: 'Amazon.com',
    basePrice: 278.0,
    currency: 'USD',
    rating: 4.7,
    reviewCount: 15240,
    url: 'https://www.amazon.com/dp/B0DEMO0002',
  },
  {
    marketplace: Marketplace.EBAY,
    externalId: '285000000001',
    title: 'Vintage Film Camera 35mm SLR with 50mm f/1.8 Lens',
    brand: 'Canon',
    seller: 'retro_optics',
    basePrice: 149.5,
    currency: 'USD',
    rating: 4.9,
    reviewCount: 214,
    url: 'https://www.ebay.com/itm/285000000001',
  },
  {
    marketplace: Marketplace.EBAY,
    externalId: '285000000002',
    title: 'Refurbished Laptop 14" 16GB RAM 512GB SSD',
    brand: 'ThinkPad',
    seller: 'techrenew',
    basePrice: 412.0,
    currency: 'USD',
    rating: 4.3,
    reviewCount: 89,
    url: 'https://www.ebay.com/itm/285000000002',
  },
  {
    marketplace: Marketplace.ETSY,
    externalId: '1700000001',
    title: 'Handmade Ceramic Mug, Speckled Glaze, 12oz',
    brand: 'ClayAndCo',
    seller: 'ClayAndCoStudio',
    basePrice: 32.0,
    currency: 'USD',
    rating: 4.8,
    reviewCount: 1120,
    url: 'https://www.etsy.com/listing/1700000001/handmade-ceramic-mug',
  },
  {
    marketplace: Marketplace.ETSY,
    externalId: '1700000002',
    title: 'Personalized Leather Notebook Cover, A5',
    brand: 'NorthLeather',
    seller: 'NorthLeatherGoods',
    basePrice: 58.0,
    currency: 'USD',
    rating: 4.9,
    reviewCount: 640,
    url: 'https://www.etsy.com/listing/1700000002/leather-notebook-cover',
  },
];

/**
 * Deterministic pseudo-random. Math.random() would make every reseed produce a
 * different chart, which makes "did my change break the chart?" unanswerable.
 */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** A believable price walk: mostly flat, occasional step changes. Real prices don't wobble daily. */
function priceWalk(base: number, points: number, rand: () => number): number[] {
  const prices: number[] = [];
  let current = base;

  for (let i = 0; i < points; i++) {
    const roll = rand();
    if (roll > 0.88) {
      // ~12% chance of a real move: -15% to +10%
      const delta = (rand() * 0.25 - 0.15) * base;
      current = Math.max(base * 0.5, current + delta);
    }
    prices.push(Math.round(current * 100) / 100);
  }
  return prices;
}

async function main(): Promise<void> {
  console.log('Seeding…');

  // Idempotent: wipe in FK-safe order so reseeding is always clean.
  await prisma.priceSnapshot.deleteMany();
  await prisma.crawlRun.deleteMany();
  await prisma.product.deleteMany();
  await prisma.crawlJob.deleteMany();
  await prisma.category.deleteMany();

  const jobs = await Promise.all([
    prisma.crawlJob.create({
      data: {
        name: 'Mechanical keyboards (Amazon)',
        marketplace: Marketplace.AMAZON,
        type: CrawlJobType.SEARCH,
        query: 'mechanical keyboard',
        maxPages: 2,
        maxItems: 50,
        cronExpression: '0 0 6 * * *', // daily 06:00
        enabled: true,
      },
    }),
    prisma.crawlJob.create({
      data: {
        name: 'Vintage cameras (eBay)',
        marketplace: Marketplace.EBAY,
        type: CrawlJobType.SEARCH,
        query: 'vintage film camera',
        maxPages: 2,
        maxItems: 50,
        cronExpression: '0 0 */6 * * *', // every 6h
        enabled: true,
      },
    }),
    prisma.crawlJob.create({
      data: {
        name: 'Handmade ceramics (Etsy)',
        marketplace: Marketplace.ETSY,
        type: CrawlJobType.SEARCH,
        query: 'handmade ceramic mug',
        maxPages: 1,
        maxItems: 25,
        cronExpression: null, // manual only
        enabled: true,
      },
    }),
  ]);
  console.log(`  ${jobs.length} crawl jobs`);

  const jobByMarketplace = new Map(jobs.map((j) => [j.marketplace, j]));

  // 30 days of history, one snapshot per day.
  const DAYS = 30;
  const now = Date.now();
  const rand = seededRandom(42);

  let snapshotTotal = 0;

  for (const spec of PRODUCTS) {
    const job = jobByMarketplace.get(spec.marketplace)!;
    const prices = priceWalk(spec.basePrice, DAYS, rand);

    const run = await prisma.crawlRun.create({
      data: {
        jobId: job.id,
        status: RunStatus.SUCCEEDED,
        trigger: RunTrigger.SCHEDULED,
        startedAt: new Date(now - 60_000),
        finishedAt: new Date(now - 30_000),
        itemsFound: 1,
        itemsNew: 1,
        itemsUpdated: 0,
      },
    });

    const currentPrice = prices[prices.length - 1];

    const product = await prisma.product.create({
      data: {
        marketplace: spec.marketplace,
        externalId: spec.externalId,
        url: spec.url,
        title: spec.title,
        brand: spec.brand,
        seller: spec.seller,
        imageUrl: null,
        currency: spec.currency,
        rating: spec.rating,
        reviewCount: spec.reviewCount,
        firstSeenAt: new Date(now - DAYS * 86_400_000),
        currentPrice,
        inStock: true,
        snapshotCount: DAYS,
      },
    });

    await prisma.priceSnapshot.createMany({
      data: prices.map((price, i) => ({
        productId: product.id,
        price,
        currency: spec.currency,
        // One deliberate out-of-stock blip so the UI's stock states are exercised.
        inStock: !(spec.externalId === 'B0DEMO0002' && i === DAYS - 8),
        seller: spec.seller,
        crawlRunId: run.id,
        capturedAt: new Date(now - (DAYS - 1 - i) * 86_400_000),
      })),
    });

    snapshotTotal += prices.length;
  }

  // A BLOCKED run, because it's a first-class outcome for Amazon and the
  // dashboard should show what one looks like before you hit a real one.
  await prisma.crawlRun.create({
    data: {
      jobId: jobByMarketplace.get(Marketplace.AMAZON)!.id,
      status: RunStatus.BLOCKED,
      trigger: RunTrigger.MANUAL,
      startedAt: new Date(now - 3_600_000),
      finishedAt: new Date(now - 3_580_000),
      itemsFound: 0,
      itemsNew: 0,
      itemsUpdated: 0,
      error:
        'AMAZON blocked the request: Amazon CAPTCHA challenge | evidence: Enter the characters you see below',
    },
  });

  console.log(`  ${PRODUCTS.length} products`);
  console.log(`  ${snapshotTotal} price snapshots across ${DAYS} days`);
  console.log('Done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
