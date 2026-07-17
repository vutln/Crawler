---
name: verify-crawl
description: Verify a crawler change by driving a REAL crawl run end-to-end and reading its outcome. Use after changing any adapter, the block detector, the politeness services, or the crawl pipeline — unit and fixture tests run against frozen HTML and cannot catch live behavior by construction. Also use when asked to confirm a crawl actually works, or to reproduce a BLOCKED/FAILED run.
---

# Verify a crawl end-to-end

Unit and fixture tests in this repo are deterministic **because the HTML is frozen**. That is their value and their blind spot: they stay green while the live DOM drifts and while sites start serving new anti-bot pages. `npm test` passing is not evidence that a crawler change works.

The only real verification is: trigger a run, poll it to a terminal status, and read what it reports.

## When to use

Use after touching:
- `src/crawler/adapters/**` — any adapter or `SeleniumAdapterBase`
- `src/crawler/politeness/**` — block detector, robots, throttle
- `src/crawler/pipeline/**` — the runner or upsert logic
- `src/crawler/queue/**` — queue or scheduler

Skip for changes with no runtime surface here (frontend-only, docs, DTO renames the compiler already checks).

## Preconditions

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health   # expect 200
```

Not 200 → the backend isn't up or MySQL is unreachable. Use the `run-crawler` skill; do not proceed. A `pool timeout ... active=0 idle=0` in the backend log is almost always the `caching_sha2_password` RSA issue — see Troubleshooting in CLAUDE.md.

## The flow

**1. Find a job, or create one.**

```bash
curl -s http://localhost:3000/api/crawl-jobs
```

Reuse a seeded job whose `marketplace` matches what you changed. To create one:

```bash
curl -s -X POST http://localhost:3000/api/crawl-jobs \
  -H 'Content-Type: application/json' \
  -d '{"name":"verify: block detector","marketplace":"AMAZON","type":"SEARCH",
       "query":"tungsten cube","maxPages":1,"maxItems":5}'
```

Keep `maxPages`/`maxItems` small. You are verifying behavior, not collecting data — and deep pagination is what earns a block.

**2. Trigger it.** Returns immediately with a `QUEUED` run; the id is what you poll.

```bash
curl -s -X POST http://localhost:3000/api/crawl-jobs/<JOB_ID>/run
```

**3. Poll to a terminal status.** The queue is concurrency 1, so a run may sit `QUEUED` behind another. Selenium runs take ~15-20s; a blocked one should now fail in ~1-2s.

```bash
node -e '
const id = process.argv[1];
(async () => {
  for (let i = 0; i < 40; i++) {
    const r = await (await fetch(`http://localhost:3000/api/crawl-runs/${id}`)).json();
    if (!["QUEUED","RUNNING"].includes(r.status)) {
      console.log(JSON.stringify({status:r.status, itemsFound:r.itemsFound,
        itemsNew:r.itemsNew, durationMs:r.durationMs, error:r.error}, null, 2));
      return;
    }
    await new Promise(s => setTimeout(s, 2000));
  }
  console.log("still not terminal after 80s — check the backend log");
})();
' <RUN_ID>
```

## How to read the result

**`error` is the payload, not an afterthought.** For a `BLOCKED` run it carries the anti-bot evidence, and that evidence is the actual result of the test.

| Status | itemsFound | Verdict |
|---|---|---|
| `SUCCEEDED` | > 0 | **Pass.** |
| `SUCCEEDED` | **0** | **RED FLAG — investigate before anything else.** |
| `BLOCKED` | 0 | **Pass**, if `error` names a real signature with evidence. The site refused us and we said so. |
| `FAILED` | 0 | **Pass** if `error` says robots.txt disallows — that's eBay/Etsy working as designed. Otherwise a real bug. |
| `CANCELLED` | any | Someone aborted it. Not a result. |

### SUCCEEDED with 0 items is the failure this project exists to prevent

It is indistinguishable from a genuine no-match search, and it is exactly how a wall slips through. It has happened twice here — an Etsy JS challenge, and the Amazon "Dogs of Amazon" page that only got caught by an accidental `bodyChars=0`. Both reached the dashboard as a clean run.

If you see it, do not accept it. Work out which of three things it is:

1. **A genuinely empty search** — confirm by opening the same query in a normal browser.
2. **DOM drift** — the selectors no longer match. Check the backend log for `no result containers, but the page has content`, which prints the page title and first 240 chars.
3. **An undetected wall** — the page is a block with no matching signature. This is a block-detector gap: add a signature and a regression test to `block-detector.service.spec.ts`, using the page's verbatim text.

### Expected per marketplace, with no API credentials

| Marketplace | Expected | Meaning |
|---|---|---|
| `AMAZON` | `SUCCEEDED`, or `BLOCKED` on a warmed-up IP | Both are correct outcomes |
| `EBAY` | `FAILED` — robots.txt disallows `/sch/` | Correct. Set `EBAY_APP_ID`/`EBAY_CERT_ID` for the Browse API |
| `ETSY` | `FAILED` — robots.txt disallows `/search` | Correct. Set `ETSY_API_KEY` for Open API v3 |

A `BLOCKED` Amazon run is **a passing verification**, not a failure to work around. Report it as such.

## Rules

- **Never evade a block to make a run go green.** No fabricated user-agent, no proxy rotation, no fingerprint spoofing, no CAPTCHA solving. Invariant #2 in CLAUDE.md. If Amazon is blocking, the answer is back off or use the Product Advertising API.
- **Don't set `CRAWL_RESPECT_ROBOTS=false`** to get past an eBay/Etsy `FAILED`. That refusal is the system working.
- **Re-running a blocked crawl repeatedly deepens the throttle.** One run per change, then read it.
- **`.env` changes need a manual restart** — `nest --watch` only watches `.ts`.

## API reference

Verified against the DTOs; don't guess these.

- `GET /api/health`
- `GET|POST /api/crawl-jobs` · `GET|PATCH|DELETE /api/crawl-jobs/:id` · `POST /api/crawl-jobs/:id/run`
- `GET /api/crawl-runs` — paginates with **`page` / `pageSize`** (not `take`/`limit`); also `status`, `marketplace`, `jobId`
- `GET /api/crawl-runs/:id` · `POST /api/crawl-runs/:id/cancel`
- `GET /api/products` — **`page` / `pageSize`**, plus `marketplace`, `sortBy`, `sortOrder`
- `GET /api/stats/overview` — includes `activeAdapter` per marketplace, so it shows whether the API or Selenium path is live
- Swagger: <http://localhost:3000/api/docs>
