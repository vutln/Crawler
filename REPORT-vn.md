# Báo cáo học tập — E-Commerce Data Collector

## Tổng quan dự án

Đây là một hệ thống thu thập dữ liệu thương mại điện tử được xây dựng bằng **NestJS, TypeScript, Prisma, MySQL, Selenium và Jest**.

Hệ thống thu thập thông tin sản phẩm từ Amazon, Etsy và eBay, đồng thời lưu lại giá sản phẩm qua nhiều lần thu thập. Khác với một công cụ scraper chỉ lấy dữ liệu tại một thời điểm, ứng dụng giữ lại toàn bộ lịch sử giá dưới dạng các bản ghi chỉ được thêm mới, từ đó cho phép theo dõi xu hướng giá theo thời gian.

Tôi đã có kinh nghiệm với ReactJS trước khi thực hiện dự án này, vì vậy báo cáo tập trung chủ yếu vào phần backend và những kiến thức liên quan đến NestJS.

## Những gì tôi đã học được

### Kiến trúc NestJS

Tôi học được cách NestJS tổ chức ứng dụng thông qua:

- Feature module
- Controller
- Injectable service
- Dependency injection
- DTO
- Lifecycle hook

Ứng dụng được chia thành các module như:

```text
ProductsModule
KeywordsModule
CrawlJobsModule
CrawlerModule
StatsModule
HealthModule
PrismaModule
```

Controller chịu trách nhiệm tiếp nhận request HTTP, trong khi service xử lý nghiệp vụ và sử dụng `PrismaService` để truy cập cơ sở dữ liệu.

Luồng xử lý điển hình:

```text
HTTP request
→ Controller
→ Kiểm tra DTO
→ Service
→ Prisma
→ MySQL
```

### Dependency Injection

Dependency injection trong NestJS là một trong những khác biệt lớn nhất so với Rails.

Các service khai báo dependency thông qua constructor:

```ts
constructor(
  private readonly prisma: PrismaService,
  private readonly registry: AdapterRegistry,
) {}
```

Tôi cũng sử dụng custom injection token để tạo ra các abstraction có thể thay thế implementation.

Ví dụ, crawler phụ thuộc vào interface `ICrawlQueue` thay vì phụ thuộc trực tiếp vào `InMemoryCrawlQueue`. Nhờ đó, implementation hiện tại có thể được thay thế bằng BullMQ trong tương lai mà không cần thay đổi scheduler hoặc controller.

### DTO và kiểm tra dữ liệu runtime

Tôi học được rằng TypeScript chỉ kiểm tra kiểu dữ liệu tại thời điểm biên dịch và không thể tự động xác thực dữ liệu HTTP khi ứng dụng đang chạy.

Dự án sử dụng các DTO class cùng với `class-validator` và `class-transformer`:

```ts
export class ListProductsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;
}
```

Global `ValidationPipe` được dùng để:

- Chuyển query parameter sang đúng kiểu dữ liệu
- Loại bỏ các field không được khai báo
- Từ chối các thuộc tính không hợp lệ
- Áp dụng các quy tắc validation

Cách tiếp cận này gần giống với việc kết hợp Rails strong parameters và form-object validation.

### Prisma và thiết kế cơ sở dữ liệu

Tôi sử dụng Prisma để định nghĩa:

- Database model
- Quan hệ giữa các bảng
- Composite key
- Unique constraint
- Index
- Migration
- Transaction
- Typed query

Quyết định quan trọng nhất trong thiết kế dữ liệu là tách trạng thái hiện tại của sản phẩm khỏi lịch sử giá.

```text
Product
→ Thông tin định danh và dữ liệu mới nhất

PriceSnapshot
→ Một bản ghi bất biến cho mỗi lần thu thập
```

Giá hiện tại được lưu trên `Product` để việc lọc và sắp xếp nhanh hơn, nhưng mỗi lần quan sát giá vẫn được thêm vào `PriceSnapshot`.

Hai thao tác này được thực hiện trong cùng một transaction để tránh trường hợp giá hiện tại và lịch sử giá không đồng nhất.

Tôi cũng thiết kế quan hệ many-to-many giữa sản phẩm và từ khóa vì một sản phẩm có thể xuất hiện trong kết quả của nhiều truy vấn tìm kiếm.

### Kiến trúc Adapter

Mỗi marketplace được triển khai thông qua một interface chung là `MarketplaceAdapter`.

```ts
interface MarketplaceAdapter {
  search(ctx: CrawlContext): AsyncIterable<ProductRecord>;

  fetchProduct(url: string, ctx: CrawlContext): Promise<ProductRecord | null>;
}
```

Thiết kế này cho phép Selenium và official API có thể được sử dụng thay thế cho nhau.

`AdapterRegistry` sẽ chọn adapter có độ ưu tiên cao nhất và đang khả dụng. Ví dụ, khi có API credential, hệ thống có thể ưu tiên official API; nếu không có, Selenium sẽ được sử dụng làm phương án dự phòng.

Khi thêm marketplace mới, phần lớn chỉ cần triển khai và đăng ký adapter mới mà không phải thay đổi toàn bộ crawl pipeline.

### Xử lý bất đồng bộ

Dự án giúp tôi hiểu sâu hơn về cơ chế bất đồng bộ của Node.js.

Các adapter trả về asynchronous iterator thay vì tải toàn bộ sản phẩm vào một mảng:

```ts
for await (const record of adapter.search(ctx)) {
  await persist(record);
}
```

Cách này giúp ứng dụng:

- Xử lý kết quả theo từng phần
- Giảm mức sử dụng bộ nhớ
- Lưu lại kết quả đã thu thập nếu crawl bị lỗi giữa chừng
- Có thể dừng crawl đang chạy
- Không cần chờ tất cả các trang hoàn thành mới bắt đầu lưu dữ liệu

Tôi cũng sử dụng `AbortController` để hủy các crawl đang được thực thi.

### Scheduling và background job

Dự án đăng ký các cron job động dựa trên dữ liệu trong cơ sở dữ liệu.

Cách này phù hợp hơn việc sử dụng decorator `@Cron()` cố định vì người dùng có thể tạo và chỉnh sửa lịch crawl trong lúc ứng dụng đang chạy.

Các scheduled job sẽ tạo `CrawlRun` trong cơ sở dữ liệu và đưa chúng vào queue. HTTP request có thể trả kết quả ngay lập tức trong khi crawl tiếp tục chạy ở background.

Queue hiện tại là FIFO queue trong bộ nhớ với concurrency bằng một. Đây là quyết định có chủ đích vì crawler bị giới hạn bởi tính lịch sự khi truy cập website bên ngoài, không phải bởi năng lực xử lý CPU.

### Độ tin cậy khi crawling

Tôi học được rằng web crawling không chỉ đơn giản là parse HTML.

Crawler hiện hỗ trợ:

- Kiểm tra `robots.txt`
- Throttling theo domain
- Exponential backoff
- Phát hiện CAPTCHA và block
- Retry có giới hạn
- Quản lý vòng đời trình duyệt
- Trạng thái crawl rõ ràng

Ứng dụng phân biệt các trạng thái:

```text
SUCCEEDED
FAILED
BLOCKED
CANCELLED
```

Website từ chối crawler được xem là trạng thái khác với lỗi của ứng dụng hoặc kết quả tìm kiếm trống.

### Node.js stream

Tính năng xuất CSV sử dụng Node stream thay vì tạo toàn bộ file trong bộ nhớ.

Sản phẩm được đọc theo batch bằng cursor pagination, chuyển sang CSV và ghi dần vào HTTP response.

Implementation cũng xử lý backpressure:

```ts
if (!output.write(data)) {
  await once(output, "drain");
}
```

Điều này giúp tránh trường hợp client đọc dữ liệu chậm khiến toàn bộ file bị tích tụ trong bộ nhớ của ứng dụng.

### API documentation và kiểm thử

Backend sử dụng Swagger/OpenAPI để tài liệu hóa API và tạo TypeScript type cho frontend.

Chiến lược kiểm thử gồm:

- Unit test
- Frozen HTML fixture test
- API và end-to-end test
- Live canary test

Fixture test kiểm tra parsing mà không phụ thuộc vào website thật. Canary test được tách riêng vì giao diện HTML của marketplace có thể thay đổi bất kỳ lúc nào.

## Công nghệ đã sử dụng và vấn đề được giải quyết

| Công nghệ                     | Vấn đề được giải quyết                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| NestJS                        | Kiến trúc backend, module, controller và dependency injection      |
| TypeScript                    | Kiểm tra kiểu dữ liệu khi biên dịch và hỗ trợ refactor an toàn hơn |
| Prisma                        | Truy cập cơ sở dữ liệu có type, migration, relation và transaction |
| MySQL                         | Lưu trữ sản phẩm, từ khóa, crawl job, crawl run và lịch sử giá     |
| Selenium                      | Thu thập dữ liệu từ các website render bằng JavaScript             |
| Marketplace API               | Nguồn dữ liệu ổn định hơn khi có credential                        |
| Async generator               | Crawl từng phần với mức sử dụng bộ nhớ thấp hơn                    |
| `AbortController`             | Hủy crawl đang chạy                                                |
| Nest Scheduler                | Tạo scheduled job có thể cấu hình tại runtime                      |
| Queue abstraction             | Tách HTTP request khỏi quá trình crawl                             |
| `class-validator`             | Kiểm tra DTO và cấu hình môi trường tại runtime                    |
| Swagger                       | Tài liệu hóa API và tạo contract cho frontend                      |
| Node stream                   | Xuất CSV với mức sử dụng bộ nhớ ổn định                            |
| Jest                          | Unit test và integration test                                      |
| HTML fixture                  | Kiểm tra parser một cách ổn định và có thể lặp lại                 |
| Throttling và robots handling | Giảm hành vi crawl quá mức và tôn trọng website                    |

## So sánh với Rails

| Rails                      | NestJS trong dự án                 |
| -------------------------- | ---------------------------------- |
| Ruby                       | TypeScript                         |
| Rails                      | NestJS                             |
| Rails controller           | Nest controller                    |
| `routes.rb`                | Decorator trên controller          |
| Service object             | Injectable Nest service            |
| Rails Engine               | Nest feature module                |
| Strong parameters          | DTO và `ValidationPipe`            |
| Active Record model        | Prisma model và generated type     |
| Active Record query        | Prisma Client query                |
| Rails migration            | Prisma migration                   |
| Active Job                 | Queue và crawl runner              |
| Sidekiq                    | BullMQ nếu bổ sung trong tương lai |
| `sidekiq-cron`             | Scheduler service                  |
| `rescue_from`              | Exception filter                   |
| `ENV.fetch` và initializer | `ConfigModule` có validation       |
| RSpec/Minitest             | Jest                               |
| Capybara/Selenium          | Selenium WebDriver                 |
| Puma                       | Node HTTP process                  |
| Gemfile                    | `package.json`                     |
| Bundler                    | npm                                |

Khác biệt lớn nhất là Rails cung cấp một full-stack framework có mức độ tích hợp rất cao, trong khi NestJS chủ yếu cung cấp cấu trúc ứng dụng và dependency injection. Các phần như ORM, queue, authentication hoặc infrastructure cần được lựa chọn riêng.

Prisma cũng khác Active Record. Kết quả từ Prisma chủ yếu là các data object, không phải model có các method như `save()` hoặc method quan hệ. Vì vậy, business logic chủ yếu được đặt trong NestJS service.

## Những kiến thức tôi vẫn còn thiếu

### Authentication và authorization

Dự án hiện chưa bao gồm:

- Đăng ký và đăng nhập người dùng
- Hash mật khẩu
- JWT hoặc session authentication
- Authentication guard
- Role và permission
- Resource-level authorization

Đây có thể xem là phần tương đương với Devise và Pundit trong Rails.

### Durable job queue

Queue hiện tại chỉ tồn tại trong bộ nhớ ứng dụng. Các job đang chờ sẽ bị mất nếu server khởi động lại.

Tôi vẫn cần thêm kinh nghiệm thực tế với:

- BullMQ
- Redis
- Worker process riêng
- Durable retry
- Dead-letter queue
- Job deduplication
- Idempotent worker

### Production deployment

Tôi vẫn cần cải thiện kinh nghiệm trong các lĩnh vực:

- Docker
- CI/CD
- Production database migration
- Secret management
- Cloud deployment
- Containerized Chrome
- Reverse proxy và TLS
- Backup và recovery

### Horizontal scaling

Scheduler và queue hiện tại giả định rằng chỉ có một backend process.

Nếu chạy nhiều instance, hệ thống sẽ cần:

- Distributed lock
- Shared durable queue
- Idempotency
- Cơ chế tránh chạy trùng scheduled job
- Tách API service và worker service

### Observability

Dự án có sử dụng Nest Logger, nhưng một hệ thống production còn cần:

- Structured logging
- Request ID và crawl correlation ID
- Metrics
- Queue monitoring
- Error alert
- Distributed tracing
- OpenTelemetry

### Kiểm thử hiệu năng và lỗi

Tôi vẫn cần thêm kinh nghiệm với:

- Load testing
- Concurrent CSV export
- Database connection pool saturation
- Memory profiling
- Event-loop monitoring
- Restart recovery
- Long-running Selenium stability test

## Kết luận

Dự án này giúp tôi chuyển đổi cách tư duy backend từ Rails sang NestJS và Node.js.

Những kinh nghiệm trước đây với MVC, cơ sở dữ liệu quan hệ, migration, service object, scheduled job và REST API vẫn có thể áp dụng tốt.

Các kiến thức mới quan trọng nhất bao gồm:

- Dependency injection rõ ràng
- NestJS feature module
- DTO validation tại runtime
- Prisma thay cho Active Record
- Promise và asynchronous iteration
- Cancellation và lifecycle management
- Stream và backpressure
- Adapter và queue implementation có thể thay thế

Các ưu tiên học tập tiếp theo của tôi là authentication, durable queue, production deployment, observability, horizontal scaling và kiểm thử hiệu năng chuyên sâu hơn.
