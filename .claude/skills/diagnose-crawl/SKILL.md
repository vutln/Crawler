---
name: diagnose-crawl
description: Work out why a crawl returned no data, wrong data, or BLOCKED — Amazon/eBay/Etsy via Selenium. Use for "0 found but I can see products", missing prices, BLOCKED runs, or any claim about what a live marketplace does.
---

# Diagnosing a crawl

## Evidence rules

Live-site behaviour cannot be derived from reading code. Before stating what a
marketplace does:

- **One sample doesn't establish a wall.** Amazon's error page is non-deterministic —
  the same URL minutes apart gives a wall, then a clean render.
- **Check what page the probe actually landed on** before reading anything into the
  result. A probe that hit a bot wall says nothing about prices, selectors, or parsing.
- **Fixtures marked synthetic are not evidence of live DOM.** Check the file's header
  comment before citing it.
- **Comments are not evidence.** Verify the code path itself.
- If it hasn't been run this session, it isn't known. Say so rather than filling the gap.

## The probe

Boot the real DI container and use the real adapter — a hand-rolled Selenium script
tests something the crawler never does. Write to `backend/src/<name>-tmp.ts`, build,
run, **delete**.

```ts
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { AdapterRegistry } from './crawler/adapters/adapter.registry';
import { Marketplace } from './generated/prisma/client';
import type { CrawlContext } from './crawler/adapters/adapter.interface';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  await app.init();

  const adapter = app.get(AdapterRegistry).resolve(Marketplace.AMAZON);
  const ctx = {
    query: 'mechanical keyboard', maxPages: 1, maxItems: 5,
    signal: new AbortController().signal, logger: new Logger('probe'),
  } as CrawlContext;

  try {
    for await (const r of adapter.search(ctx)) console.log(r.title, r.price, r.currency);
  } catch (err) { console.log('threw:', (err as Error).message); }

  await app.close();
  process.exit(0);
}
void main();
```

```bash
cd backend && npx nest build && node dist/src/<name>-tmp.js
rm -f src/<name>-tmp.ts dist/src/<name>-tmp.js        # always clean up
```

A fresh process gets a **fresh in-memory throttle**, so it ignores any cooldown the
running server owes. That's why a probe can knock when the app refuses to.

To count real HTTP requests, wrap `driver.get` and read
`performance.getEntriesByType("navigation").length` per document — proves a fresh
document rather than a no-op.

## Read the page before believing the symptom

A parse failure and a wall look identical from outside. Dump it:

```ts
console.log('title :', await d.getTitle());
console.log('url   :', await d.getCurrentUrl());
console.log('body  :', (await d.findElement(By.css('body')).getText()).slice(0, 300));
console.log('len   :', (await d.getPageSource()).length);
```

Then ask `BlockDetectorService.inspect({ html, url })` — a plain class with no deps,
constructible anywhere (`new BlockDetectorService()`). Never hand-roll a second
"is this blocked" regex; a duplicate one already drifted and made the currency canary
report a false failure.

## What Amazon actually serves (measured 2026-07-17)

| Page                                            | Marker                              | Detected            |
| ----------------------------------------------- | ----------------------------------- | ------------------- |
| Real results                                    | `s-search-result`                   | —                   |
| "Sorry! Something went wrong" (Dogs of Amazon)  | title `Sorry!`                      | yes, **ambiguous**  |
| "Click the button below to continue shopping"   | `api-services-support@amazon.com`   | yes                 |
| AWS WAF JS challenge                            | `gokuProps`, blank title, ~2KB      | **NO — known gap**  |

The Dogs page is ambiguous by nature — served both for genuine 5xx blips and as a soft
block — so `navigate()` reloads it up to `MAX_AMBIGUOUS_RELOADS` (2) times, i.e. **3
loads at most**, stopping the moment it clears. Explicit refusals (CAPTCHA, WAF, "not a
robot") are never reloaded: the site answered in words.

Expect these in the log when it fires:

```
WARN  ...ambiguous by nature, look 2 of 3 before calling it a wall
LOG   ...cleared on look 2 — transient, not a wall
```

The AWS WAF challenge is undetected and does **not** self-resolve (static at 1,995 chars
after 14s). It surfaces as `title: ""` with zero elements — including no nav bar, so
anything that clicks nav UI silently finds nothing.

## "Where's the retry?" — and other things that never reached the page

`navigate()` bails **before** `driver.get` when the host owes more than
`MAX_IDLE_HOLD_MS` (15s):

```
AMAZON is 27s into a cooldown from an earlier block — not knocking again yet.
```

Those runs never loaded anything, so there's nothing to retry and no widget to click.
One block costs backoff step 6 ≈ 128s, so in a batch the **first** run hits the site and
the rest short-circuit. A missing retry line usually means this, not a broken retry.

## Common false leads

Before blaming the site or the code:

- **Repeated probing walls the IP within a session.** After that everything measures the
  wall. Stop and wait hours; no code change fixes it.
- **`pkill` doesn't match on Windows.** A stale process holds the port and you verify
  old code. Check for `EADDRINUSE`.
- **`nest --watch` restarting** produces console 500s that aren't bugs.
- **Waiting on a table shell** rather than a row reports "0 rows".
- Frontend "not working" that's really Tailwind preflight (`margin: 0` kills the UA's
  `margin: auto`).

## SUCCEEDED but 0 found

The adapter yielded nothing while the page had products. Usually **one** dead selector,
or a block signature near-missing by a character. Check in order: is it a wall
(`inspect()`); does the result container still match; did `parseCard` return early
because `title` was undefined.

`diagnoseEmptyPage` throws `BlockedError` only when the body is under 50 chars — a
rendered wall with text will *not* trip it.

The fixture tier is frozen HTML and cannot catch live drift. `npm run test:canary` is
that tier, and a CAPTCHA there is **inconclusive, not a failure**.
