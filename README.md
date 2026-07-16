# E-Commerce Data Collector

Tracks product **prices over time** across Amazon, Etsy and eBay — a NestJS crawler with a pluggable adapter architecture, and a React dashboard to browse products, chart price history, and run crawls.

A *scraper* grabs a price once. A **collector** re-visits the same product on a schedule so you get a time series. That distinction drives the whole design: prices are append-only and never updated in place.

![Dashboard](docs/images/dashboard.png)

<table>
<tr>
<td width="50%"><img src="docs/images/products.png" alt="Products list"/></td>
<td width="50%"><img src="docs/images/price-history.png" alt="Price history chart"/></td>
</tr>
</table>

---

## Features

- **Price history, not snapshots** — every observation is an immutable row; the chart is the product
- **Pluggable marketplaces** — add a site with one adapter class; the compiler finds the one place the frontend needs updating
- **API adapters outrank scrapers** — drop in an eBay/Etsy API key and the registry switches automatically, no code change
- **Honest about being blocked** — anti-bot walls end a run as `BLOCKED` with evidence, never as a silent "success with 0 results"
- **Polite by default** — robots.txt respected, per-domain throttling, conservative rate limits
- **Offline, deterministic tests** — adapter parsing is tested against frozen HTML with the network disabled

## Stack

| | |
|---|---|
| **Backend** | NestJS 11 · Prisma 7 · MySQL 8 · Selenium 4 · TypeScript 5.9 |
| **Frontend** | React 19 · Vite 7 · TanStack Query v5 · Tailwind v4 · Recharts 3 |
| **Testing** | Jest · Selenium (fixture, E2E and live-canary tiers) |

> **TypeScript is pinned to 5.9, not 7.** The NestJS 11 CLI ships 5.9.3 and Nest depends on `emitDecoratorMetadata`, which the TS 7 native port doesn't support the same way.

---

## Requirements

- **Node.js** ≥ 20.19 (Prisma 7's floor; 22.x recommended)
- **MySQL** 8.0+
- **Chrome** (any recent version)

No Docker, Java or Redis needed. **Do not install the `chromedriver` npm package** — Selenium Manager resolves a driver against your installed Chrome at runtime. A pinned driver breaks the moment Chrome auto-updates.

## Quick start

### 1. Create the databases

Pick a password, put it in `prisma/init-db.sql` (replacing `CHANGE_ME`), then run it as root:

```bash
cd backend
mysql -u root -p < prisma/init-db.sql
```

<details>
<summary>Windows: mysql isn't on PATH by default</summary>

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p < prisma\init-db.sql
```
Or add `C:\Program Files\MySQL\MySQL Server 8.0\bin` to your PATH.
</details>

### 2. Backend

```bash
cd backend
cp .env.example .env          # then set DATABASE_URL to the password from step 1
npm install
npx prisma migrate dev --name init
npm run db:seed               # demo products + 30 days of price history
npm run start:dev
```

- API → <http://localhost:3000/api>
- Swagger → <http://localhost:3000/api/docs>

### 3. Frontend

```bash
cd frontend
npm install
npm run dev                   # http://localhost:5173
```

Vite proxies `/api` to the backend, so dev is same-origin and **CORS never comes up**. That only holds because `VITE_API_BASE_URL` is empty — keep it that way locally.

---

## Reality check on scraping these sites

This was measured against all three live sites. **Read this before planning around the Selenium adapters.**

| Site | robots.txt on search | Result with default settings |
|---|---|---|
| **eBay** | `Disallow: /sch/` for `*` | Run `FAILED` — the crawler refuses |
| **Etsy** | `Disallow: /search?*q=` for `*` | Run `FAILED` — the crawler refuses |
| **Amazon** | `/s?k=` allowed | Run `SUCCEEDED` — products collected |

**eBay and Etsy disallow search scraping in robots.txt.** eBay states it in prose too: *"The use of robots or other automated means to access the eBay site without the express permission of eBay is strictly prohibited… Approved enterprise integrations must use our official API."* With `CRAWL_RESPECT_ROBOTS=true` (the default) the collector correctly refuses. That is the system working.

**Amazon strips prices from non-browser user-agents.** Same URL, same 16 listings, only the UA changed:

| `CRAWL_USER_AGENT` | Cards | Prices |
|---|---|---|
| *(empty — the default)* | 16 | **16** |
| `EcomCollectorBot/1.0` | 16 | **0** |

`CRAWL_USER_AGENT` ships empty, so Chrome sends its own genuine string — which says `HeadlessChrome`. Nothing is disguised. Setting a *fabricated* desktop-browser UA to look less automated is a different act, and this repo doesn't do it for you. Amazon's ToS restricts automated access regardless of UA; the Product Advertising API is the supported path.

**Amazon geolocates** — from a Vietnamese IP it serves VND, not USD. `Product.currency` is per-row and the UI formats accordingly, so mixed-currency tables are expected.

### So the official APIs aren't an optimization — they're the path

`EbayApiAdapter` and `EtsyApiAdapter` already exist and implement the identical interface. Add credentials and the registry switches with no code change:

```env
EBAY_APP_ID=...   EBAY_CERT_ID=...   # eBay Browse API
ETSY_API_KEY=...                     # Etsy Open API v3
```

This is exactly why `MarketplaceAdapter` abstracts *"obtain product data"* rather than *"drive a browser"* — the empirical result cost a config line instead of a rewrite.

**Use this responsibly.** Scraping may breach a site's terms of service regardless of what robots.txt permits. Check the terms for any site you point this at, and prefer the official API where one exists.

---

## Adding a marketplace

Four edits — **the compiler names three of them**:

```
1. backend/prisma/schema.prisma            add to `enum Marketplace`, then migrate
2. backend/src/crawler/adapters/…          one class implementing MarketplaceAdapter
3. backend/src/crawler/crawler.module.ts   add it to ADAPTERS
4. cd frontend && npm run gen:api          then fix the ONE compile error
```

Extend `SeleniumAdapterBase` to inherit robots checks, throttling, block detection and driver lifecycle. Nothing else on the backend changes.

Step 4 is the interesting part. `Marketplace` is generated from the Prisma enum via OpenAPI, and `frontend/src/domain/marketplace.ts` keys a `Record<Marketplace, …>` off it. `Record` is exhaustively checked, so adding `WALMART` yields exactly one error:

```
src/domain/marketplace.ts(32,14): error TS2741:
  Property 'WALMART' is missing in type '{ AMAZON: …; ETSY: …; EBAY: … }'
```

Fill in that entry and dropdowns, badges, URL validation and form defaults all follow — every array is derived from the Record. An array of enum values would compile fine forever while silently omitting the new site from every dropdown.

---

## Testing

```bash
cd backend
npm test              # unit + fixture adapter tests — offline, deterministic
npm run test:e2e      # Selenium against the dashboard (needs both servers running)
npm run test:canary   # hits LIVE sites to detect DOM drift — not for CI
```

| Tier | Proves | CI |
|---|---|---|
| Unit | Price/rating/URL normalization, block detection | ✅ |
| Fixture | Real parser, real Chrome, frozen HTML, network disabled | ✅ |
| E2E | Dashboard flows against real API + DB | ✅ |
| Canary | Live DOM still matches our selectors | ❌ never |

**Why fixtures.** Testing adapters against live sites produces failures caused by A/B tests and rate limits rather than your code, which trains everyone to ignore red. Fixture tests run with Chrome's DNS resolving everything except loopback to `NOTFOUND`.

**Why the canary.** Fixtures are deterministic *because* the HTML is frozen — so they stay green while the real DOM drifts. The canary is the only thing that catches that. It's expected to be flaky; a failure means "go look", not "the build is broken".

Refresh a fixture with real markup:

```bash
npm run fixtures:capture -- amazon "mechanical keyboard"
```

---

## Architecture notes

**Job vs Run.** `CrawlJob` is a definition ("track keyboards on eBay, daily"); `CrawlRun` is one execution. Separate, because the repetition is what produces the price series.

**Append-only prices.** `PriceSnapshot` rows are inserted, never updated. `Product.currentPrice` is a denormalized mirror written in the same transaction, so the list can filter and sort on price with an indexed `WHERE` instead of a correlated subquery per row.

**Queue.** In-process, concurrency 1 — the bottleneck is politeness, not CPU. Queued runs don't survive a restart (orphans are marked `FAILED`, since a lie in the dashboard is worse than an honest failure). `ICrawlQueue` is the seam: implement it with BullMQ and no caller changes.

**`BLOCKED` is a first-class outcome.** A blocked page returns HTTP 200 with parseable HTML, so without detection a crawl "succeeds" with zero products and looks identical to a search with no matches. The detector **detects and stops — it never evades**.

## Project structure

```
backend/
├─ prisma/                  schema, migrations, seed, init-db.sql
└─ src/
   ├─ crawler/
   │  ├─ adapters/          MarketplaceAdapter + one folder per site
   │  ├─ driver/            WebDriverFactory (pooling, lifecycle)
   │  ├─ pipeline/          CrawlRunner: adapter → normalize → upsert
   │  ├─ politeness/        robots.txt, throttle, block detection
   │  └─ queue/             ICrawlQueue, in-memory impl, scheduler
   ├─ products/  crawl-jobs/  stats/  health/
   └─ prisma/  config/

frontend/src/
├─ api/          typed client, query keys
├─ domain/       marketplace + run-status registries (the extension seam)
├─ hooks/        TanStack Query hooks
├─ pages/        one folder per page: index.tsx + components/
└─ components/   shared UI
```

## Environment

See [`backend/.env.example`](backend/.env.example).

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | Parsed and handed to `@prisma/adapter-mariadb` |
| `SELENIUM_HEADLESS` | `true` | `false` opens a real window — useful when writing an adapter |
| `CRAWL_MIN_DELAY_MS` | `2000` | Per-domain floor |
| `CRAWL_RESPECT_ROBOTS` | `true` | `false` deliberately ignores an explicit `Disallow` |
| `CRAWL_USER_AGENT` | *(empty)* | Empty = Chrome's own UA. Required for Amazon prices |
| `EBAY_APP_ID` / `EBAY_CERT_ID` | — | Set → eBay switches to the Browse API |
| `ETSY_API_KEY` | — | Set → Etsy switches to Open API v3 |

Config is validated at boot, so a bad value fails immediately with a readable message.

## Troubleshooting

**`Access denied for user 'crawler'@'localhost'`** — `prisma/init-db.sql` hasn't run, or `.env` doesn't match the password you set in it.

**`P3014` shadow database error** — the `crawler` user needs global `CREATE`/`DROP` for `migrate dev`; `init-db.sql` grants this.

**Chrome/driver version mismatch** — you installed the `chromedriver` package. Remove it.

**Leftover `chrome.exe` processes** — cleanup runs on graceful shutdown only. Kill with `taskkill /IM chromedriver.exe /F` (Windows) or `pkill chromedriver`.

**`.env` changes seem ignored** — `nest --watch` only watches `.ts` files. Restart the backend manually.

**Every Amazon run is `BLOCKED`** — expected on some networks. Use eBay/Etsy with API keys for reliable collection.
