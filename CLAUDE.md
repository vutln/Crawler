# CLAUDE.md

Engineering context for this repo. [README.md](README.md) covers setup, run and test; this file covers *why the code is shaped the way it is*, and which parts must not be casually changed.

## Invariants — do not break these

1. **Prices are append-only.** `PriceSnapshot` rows are INSERTed, never UPDATEd. Overwrite a price and this stops being a collector. `Product.currentPrice` is a denormalized mirror, written in the same transaction as the snapshot — it is not the source of truth.
2. **Block detection detects and stops. It never evades.** No fabricated user-agents, no CAPTCHA solving, no fingerprint spoofing. A wall ends the run as `BLOCKED` with evidence.
3. **`robots.txt` is respected by default.** `CRAWL_RESPECT_ROBOTS=false` exists, but it deliberately ignores an explicit `Disallow` — that is the operator's decision, not the default.
4. **A run never reports success it didn't have.** Zero products with an unrendered page is `BLOCKED`, not `SUCCEEDED`. An orphaned run at shutdown is `FAILED`, not left `RUNNING` — a lie in the dashboard is worse than an honest failure.
5. **`MarketplaceAdapter` mentions no browser, DOM or HTTP.** It abstracts *obtaining product data*. That is what lets an API adapter and a Selenium adapter be interchangeable.

> **TypeScript is pinned to 5.9, not 7.** The NestJS 11 CLI ships 5.9.3 and Nest depends on `emitDecoratorMetadata`, which the TS 7 native port doesn't support the same way.

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

## Architecture notes

**Job vs Run.** `CrawlJob` is a definition ("track keyboards on eBay, daily"); `CrawlRun` is one execution. Separate, because the repetition is what produces the price series.

**Append-only prices.** `PriceSnapshot` rows are inserted, never updated. `Product.currentPrice` is a denormalized mirror written in the same transaction, so the list can filter and sort on price with an indexed `WHERE` instead of a correlated subquery per row.

**Queue.** In-process, concurrency 1 — the bottleneck is politeness, not CPU. Queued runs don't survive a restart (orphans are marked `FAILED`, since a lie in the dashboard is worse than an honest failure). `ICrawlQueue` is the seam: implement it with BullMQ and no caller changes.

**`BLOCKED` is a first-class outcome.** A blocked page returns HTTP 200 with parseable HTML, so without detection a crawl "succeeds" with zero products and looks identical to a search with no matches. The detector **detects and stops — it never evades**.

**Adapter selection is Strategy, not Adapter.** Several adapters may claim one marketplace (`ebay-api` at priority 100, `ebay-selenium` at 10). `AdapterRegistry` takes the highest-priority *available* one; API adapters report unavailable without credentials, so the app boots and crawls with an empty `.env` and silently upgrades when keys appear. The per-class `toRecord()` / `parseCard()` conversions are the genuine Adapter part.

**Politeness is enforced by convention, not the compiler.** `SeleniumAdapterBase.navigate()` owns the robots → throttle → block-check order, but a subclass only gets it *if it calls `navigate()`*. An adapter calling `driver.get()` directly would bypass robots.txt and throttling silently. If you add an adapter, route every page load through `navigate()`.

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

## Testing philosophy

**Why fixtures.** Testing adapters against live sites produces failures caused by A/B tests and rate limits rather than your code, which trains everyone to ignore red. Fixture tests run with Chrome's DNS resolving everything except loopback to `NOTFOUND`.

**Why the canary.** Fixtures are deterministic *because* the HTML is frozen — so they stay green while the real DOM drifts. The canary is the only thing that catches that. It's expected to be flaky; a failure means "go look", not "the build is broken". It never runs in CI.

Refresh a fixture with real markup:

```bash
npm run fixtures:capture -- amazon "mechanical keyboard"
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

**`pool timeout: failed to retrieve a connection from pool` with `active=0 idle=0`** — read the `cause` at the very bottom of the stack. If it says *"RSA public key is not available client side"*, this is MySQL 8's `caching_sha2_password` auth, not a pool-sizing problem: the driver can't encrypt the password without the server's public key, so every connection attempt fails and the pool stays empty. `PrismaService` enables `allowPublicKeyRetrieval` for loopback hosts, which covers local dev. Against a **remote** database it stays off on purpose — whoever answers the key request receives the password encrypted to their key — so use TLS, or set `cachingRsaPublicKey` to the server's `public_key.pem`.

Expect this to appear *after a MySQL restart*: the server caches a successful auth per user, so connections work until that cache is dropped. Authenticating once with the `mysql` CLI repopulates it and makes the error vanish on its own — which is why it looks intermittent.

**Chrome/driver version mismatch** — you installed the `chromedriver` package. Remove it.

**Leftover `chrome.exe` processes** — cleanup runs on graceful shutdown only. Kill with `taskkill /IM chromedriver.exe /F` (Windows) or `pkill chromedriver`.

**`.env` changes seem ignored** — `nest --watch` only watches `.ts` files. Restart the backend manually.

**Every Amazon run is `BLOCKED`** — expected on some networks. Use eBay/Etsy with API keys for reliable collection.
