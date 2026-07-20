# Learning Report — E-Commerce Data Collector

## Project Overview

This project is an e-commerce data collector built with **NestJS, TypeScript, Prisma, MySQL, Selenium, and Jest**.

It collects product information from Amazon, Etsy, and eBay and stores repeated price observations over time. Unlike a one-time scraper, the application preserves historical prices as append-only records, allowing users to view price trends.

I was already familiar with ReactJS before this project, so this report focuses on the backend and NestJS-related learning.

## What I Learned

### NestJS architecture

I learned how NestJS organizes applications through:

- Feature modules
- Controllers
- Injectable services
- Dependency injection
- DTOs
- Lifecycle hooks

The application is divided into modules such as:

```text
ProductsModule
KeywordsModule
CrawlJobsModule
CrawlerModule
StatsModule
HealthModule
PrismaModule
```

Controllers handle HTTP input, while services contain application logic and use `PrismaService` for database access.

A typical flow is:

```text
HTTP request
→ Controller
→ DTO validation
→ Service
→ Prisma
→ MySQL
```

### Dependency injection

NestJS dependency injection was one of the largest differences from Rails.

Services declare their dependencies through constructors:

```ts
constructor(
  private readonly prisma: PrismaService,
  private readonly registry: AdapterRegistry,
) {}
```

I also used custom injection tokens to create replaceable abstractions.

For example, the crawler depends on an `ICrawlQueue` interface rather than directly depending on the current in-memory queue. This means the implementation can later be replaced with BullMQ without changing the scheduler or controllers.

### DTO validation

I learned that TypeScript types do not validate HTTP input at runtime.

The project uses DTO classes with `class-validator` and `class-transformer`:

```ts
export class ListProductsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;
}
```

A global `ValidationPipe`:

- Converts query parameters into the expected types
- Removes unknown fields
- Rejects unexpected properties
- Applies validation rules

This is similar to combining Rails strong parameters with form-object validation.

### Prisma and database design

I used Prisma to define:

- Database models
- Relationships
- Composite keys
- Unique constraints
- Indexes
- Migrations
- Transactions
- Typed queries

The most important data-model decision was separating the current product state from its price history.

```text
Product
→ Identity and latest known values

PriceSnapshot
→ One immutable row per observation
```

The current price is mirrored on `Product` for fast filtering and sorting, but every observed price is also inserted into `PriceSnapshot`.

Both writes occur in the same transaction so the latest-price mirror cannot disagree with the historical data.

I also modelled products and keywords as a many-to-many relationship because one product may appear for several search terms.

### Adapter architecture

Each marketplace is implemented behind a common `MarketplaceAdapter` interface.

```ts
interface MarketplaceAdapter {
  search(ctx: CrawlContext): AsyncIterable<ProductRecord>;

  fetchProduct(url: string, ctx: CrawlContext): Promise<ProductRecord | null>;
}
```

This allows Selenium and official API implementations to be interchangeable.

The `AdapterRegistry` selects the highest-priority available adapter. For example, an official API adapter can be used when credentials exist, while Selenium remains the fallback.

Adding another marketplace mainly requires implementing and registering another adapter rather than changing the crawler pipeline.

### Asynchronous processing

The project helped me understand Node.js asynchronous behaviour more deeply.

Adapters return asynchronous iterators rather than loading every product into one array:

```ts
for await (const record of adapter.search(ctx)) {
  await persist(record);
}
```

This allows the application to:

- Process results incrementally
- Limit memory usage
- Preserve partial results
- Stop during a crawl
- Avoid waiting until every page has finished

I also used `AbortController` to cancel running crawls.

### Scheduling and background jobs

The project dynamically registers cron jobs stored in the database.

This is preferable to fixed `@Cron()` decorators because users can create and edit crawl schedules while the application is running.

Scheduled jobs create persisted `CrawlRun` records and place them into a queue. The HTTP request can return immediately while the crawl runs in the background.

The current queue is an in-memory FIFO queue with concurrency one. This is intentional because polite crawling is limited by external websites, not by CPU performance.

### Crawling reliability

I learned that web crawling requires more than parsing HTML.

The crawler includes:

- `robots.txt` handling
- Per-domain throttling
- Exponential backoff
- CAPTCHA and block detection
- Limited retry behaviour
- Browser lifecycle management
- Explicit crawl statuses

The application distinguishes between:

```text
SUCCEEDED
FAILED
BLOCKED
CANCELLED
```

A marketplace block is treated differently from an application failure or an empty search result.

### Node.js streams

The CSV export uses Node streams rather than generating the entire file in memory.

Products are loaded in batches with cursor pagination, converted to CSV, and written to the response incrementally.

The implementation also handles backpressure:

```ts
if (!output.write(data)) {
  await once(output, "drain");
}
```

This prevents a slow client from causing the entire export to accumulate in application memory.

### API documentation and testing

The backend uses Swagger/OpenAPI to document routes and generate frontend API types.

The testing strategy includes:

- Unit tests
- Frozen HTML fixture tests
- API and end-to-end tests
- Live canary tests

Fixture tests verify parsing behaviour without relying on live websites. Canary tests are separate because marketplace HTML can change unpredictably.

## Technologies and Problems Solved

| Technology                     | Problem solved                                                       |
| ------------------------------ | -------------------------------------------------------------------- |
| NestJS                         | Backend architecture, modules, controllers, and dependency injection |
| TypeScript                     | Compile-time contracts and safer refactoring                         |
| Prisma                         | Typed database access, migrations, relations, and transactions       |
| MySQL                          | Persistent product, keyword, job, run, and price-history storage     |
| Selenium                       | Collecting data from JavaScript-rendered websites                    |
| Marketplace APIs               | More reliable data sources when credentials are available            |
| Async generators               | Incremental crawling with lower memory usage                         |
| `AbortController`              | Cancelling active crawls                                             |
| Nest Scheduler                 | Runtime-configurable recurring jobs                                  |
| Queue abstraction              | Separating HTTP requests from crawl execution                        |
| `class-validator`              | Runtime validation of DTOs and configuration                         |
| Swagger                        | API documentation and frontend contract generation                   |
| Node streams                   | Constant-memory CSV export                                           |
| Jest                           | Unit and integration testing                                         |
| HTML fixtures                  | Deterministic parser tests                                           |
| Throttling and robots handling | More responsible crawling behaviour                                  |

## Rails Analogies

| Rails                       | NestJS project                  |
| --------------------------- | ------------------------------- |
| Ruby                        | TypeScript                      |
| Rails                       | NestJS                          |
| Rails controller            | Nest controller                 |
| `routes.rb`                 | Controller route decorators     |
| Service object              | Injectable Nest service         |
| Rails Engine                | Nest feature module             |
| Strong parameters           | DTO and `ValidationPipe`        |
| Active Record model         | Prisma model and generated type |
| Active Record query         | Prisma Client query             |
| Rails migration             | Prisma migration                |
| Active Job                  | Queue and crawl runner          |
| Sidekiq                     | BullMQ, if added later          |
| `sidekiq-cron`              | Scheduler service               |
| `rescue_from`               | Exception filter                |
| `ENV.fetch` and initializer | Validated `ConfigModule`        |
| RSpec/Minitest              | Jest                            |
| Capybara/Selenium           | Selenium WebDriver              |
| Puma                        | Node HTTP process               |
| Gemfile                     | `package.json`                  |
| Bundler                     | npm                             |

The largest difference is that Rails provides a highly integrated full-stack framework, while NestJS provides structure and dependency injection but expects the developer to select separate tools for persistence, queues, authentication, and other infrastructure.

Prisma is also different from Active Record. Prisma results are data objects rather than models with methods such as `save()` or relationship methods. Business logic therefore lives mainly in NestJS services.

## What I Still Lack

### Authentication and authorization

The project does not yet cover:

- User login and registration
- Password hashing
- JWT or session authentication
- Authentication guards
- Roles and permissions
- Resource-level authorization

This would be comparable to learning the NestJS equivalents of Devise and Pundit.

### Durable job queues

The current queue exists only in application memory. Pending jobs do not survive a restart.

I still need practical experience with:

- BullMQ
- Redis
- Separate worker processes
- Durable retries
- Dead-letter queues
- Job deduplication
- Idempotent workers

### Production deployment

I still need to improve my experience with:

- Docker
- CI/CD
- Production database migrations
- Secret management
- Cloud deployment
- Containerized Chrome
- Reverse proxies and TLS
- Backup and recovery

### Horizontal scaling

The current scheduler and queue assume one backend process.

Running multiple instances would require:

- Distributed locking
- Durable shared queues
- Idempotency
- Prevention of duplicate scheduled jobs
- Separate API and worker services

### Observability

The project uses Nest's logger, but a production system would also need:

- Structured logs
- Request and crawl correlation IDs
- Metrics
- Queue monitoring
- Error alerts
- Tracing
- OpenTelemetry

### Performance and failure testing

I still need more experience with:

- Load testing
- Concurrent export testing
- Database pool saturation
- Memory profiling
- Event-loop monitoring
- Restart recovery
- Long-running Selenium stability tests

## Conclusion

This project helped me transfer my Rails backend knowledge into NestJS and Node.js.

My existing experience with MVC, relational databases, migrations, service objects, scheduled work, and REST APIs transferred well.

The main new areas were:

- Explicit dependency injection
- NestJS feature modules
- DTO-based runtime validation
- Prisma instead of Active Record
- Promises and asynchronous iteration
- Cancellation and lifecycle management
- Streams and backpressure
- Replaceable adapter and queue implementations

My next priorities are authentication, durable queues, production deployment, observability, horizontal scaling, and deeper performance testing.
