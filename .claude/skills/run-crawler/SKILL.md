---
name: run-crawler
description: Launch this project's backend (NestJS on :3000) and frontend (Vite on :5173) for local development, including the MySQL precondition and Chrome/chromedriver caveats. Use when asked to run, start, boot or screenshot the app, or when a task needs the servers up (for example before the verify-crawl skill or npm run test:e2e).
---

# Run the collector locally

Two servers plus MySQL. No Docker, Java or Redis.

## 0. MySQL must be up first

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health
```

200 means everything below is already running — stop here.

The backend will not boot without MySQL. On Windows the service is typically `MySQL80`:

```powershell
Get-Service MySQL80 | Select-Object Status
```

## 1. Backend

```bash
cd backend && npm run start:dev
```

- API → <http://localhost:3000/api>
- Swagger → <http://localhost:3000/api/docs>

Wait for `[PrismaService] Connected to MySQL` **and** the `AdapterRegistry` lines. The registry log tells you which adapter each marketplace resolved to, which is the fastest way to see whether API credentials are live:

```
[AdapterRegistry] EBAY: using ebay-selenium (candidates: ebay-api [unavailable], ebay-selenium)
```

`ebay-api [unavailable]` just means no `EBAY_APP_ID`/`EBAY_CERT_ID` — expected, and the app is designed to run that way.

## 2. Frontend

```bash
cd frontend && npm run dev
```

Dashboard → <http://localhost:5173>

Vite proxies `/api` to :3000, so dev is same-origin and CORS never comes up. That only holds while `VITE_API_BASE_URL` is empty — leave it empty.

## First run only

```bash
cd backend
mysql -u root -p < prisma/init-db.sql   # after replacing CHANGE_ME
cp .env.example .env                    # DATABASE_URL must match that password
npm install && npx prisma migrate dev && npm run db:seed
```

## Failure modes

**Backend exits with `pool timeout: failed to retrieve a connection from pool (active=0 idle=0)`** — read the `cause` at the bottom of the stack. `RSA public key is not available client side` is MySQL 8's `caching_sha2_password`, not pool sizing: `PrismaService` enables `allowPublicKeyRetrieval` for loopback only. Appears after a MySQL restart drops the server's auth cache.

**`Access denied for user 'crawler'@'localhost'`** — `init-db.sql` hasn't run, or `.env` disagrees with the password in it.

**Chrome/driver version mismatch** — someone installed the `chromedriver` npm package. Remove it. Selenium Manager resolves a driver against the installed Chrome at runtime; a pinned one breaks on every Chrome auto-update.

**Stray browsers after a crash** — driver cleanup runs on graceful shutdown only:

```bash
taskkill /IM chromedriver.exe /F   # Windows
pkill chromedriver                 # POSIX
```

**`.env` edits appear ignored** — `nest --watch` only watches `.ts`. Restart manually.

## Notes

- `SELENIUM_HEADLESS=false` opens a real Chrome window — the fastest way to see why an adapter's selectors miss.
- Ports are fixed: backend 3000 (`PORT` in `.env`), frontend 5173. The Vite proxy assumes 3000.
- `npm run test:e2e` needs **both** servers already running.
- To drive an actual crawl and check the outcome, use the `verify-crawl` skill.
