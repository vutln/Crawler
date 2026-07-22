# Hướng dẫn Deploy lên Ubuntu (LAN Server)

Tài liệu này tổng hợp các bước deploy dự án E-commerce Crawler lên môi trường Ubuntu Server thông qua Docker, cùng với các bài học kinh nghiệm (findings) quan trọng được đúc kết từ quá trình xử lý lỗi thực tế khi chuyển đổi từ môi trường phát triển Windows sang môi trường production Linux.

## 1. Yêu cầu hệ thống (Prerequisites)
- Server Ubuntu đã cài đặt **Docker** và **Docker Compose plugin**.
- Mã nguồn đã được cập nhật về máy chủ (thông qua `git clone` hoặc `git pull`).
- Các cổng (ports) cần thiết không bị xung đột (mặc định Frontend sử dụng port 80). Nếu trên máy chủ đã có Nginx native chiếm port 80, hãy đổi port trong file `docker-compose.yml`.

## 2. Các bước Deploy cơ bản

1. Kéo mã nguồn mới nhất từ kho lưu trữ:
   ```bash
   git pull origin main
   ```
2. Build và khởi động các container ở chế độ nền (detached mode):
   ```bash
   docker compose up -d --build
   ```
3. Nạp dữ liệu mẫu ban đầu (Seed Database) - **Lưu ý: Chỉ làm ở lần đầu tiên hoặc khi DB trống**:
   ```bash
   docker compose exec backend npm run db:seed
   ```
4. Truy cập ứng dụng:
   - Frontend Dashboard: `http://<IP_UBUNTU_SERVER>/`
   - Backend API Docs (Swagger): `http://<IP_UBUNTU_SERVER>/api/docs`

---

## 3. Tổng hợp các lỗi thường gặp & Bài học kinh nghiệm (Findings)

Quá trình đưa dự án từ môi trường Local (Windows) lên môi trường Server (Ubuntu) thường gặp rào cản do sự khác biệt về kiến trúc và hệ điều hành. Dưới đây là các vấn đề trọng tâm đã được xử lý triệt để trong source code:

### 3.1. Phân biệt hoa/thường trong MySQL (Case Sensitivity)
- **Lỗi gặp phải:** Trên Windows, MySQL không phân biệt chữ hoa/thường (tên bảng `CrawlJob` và `crawljob` là một). Nhưng trên Ubuntu, hệ thống file là ext4 nên MySQL **phân biệt hoa thường nghiêm ngặt** (`lower_case_table_names=0`). Nếu Prisma tạo file SQL migration trên Windows bằng chữ thường, khi chạy trên Linux sẽ văng lỗi `Table 'crawler.crawljob' doesn't exist`.
- **Giải pháp:** Đã can thiệp sửa trực tiếp tên table trong các file `prisma/migrations/*/migration.sql` khớp chính xác với chuẩn PascalCase định nghĩa trong `schema.prisma` (VD: `CrawlJob`, `Keyword`, `PriceSnapshot`).

### 3.2. Rủi ro khi copy file Build từ Windows sang Linux (Docker Context)
- **Lỗi gặp phải:** Lệnh `COPY . .` trong Dockerfile có thể vô tình copy luôn thư mục `node_modules` (chứa các native bindings C++ biên dịch riêng cho Windows) và thư mục `dist` từ máy phát triển sang container Linux. Điều này gây lỗi ứng dụng văng `MODULE_NOT_FOUND` hoặc crash vì file nhị phân không tương thích.
- **Giải pháp:** Thiết lập file `.dockerignore` chuẩn chỉnh ở cả thư mục `backend` và `frontend` để tự động loại trừ `node_modules`, `dist`, và `src/generated`.

### 3.3. Lỗi sinh code của Prisma 7 trên Linux (Mệnh đề Import)
- **Lỗi gặp phải:** Khi cấu hình `moduleFormat = "cjs"` trong `schema.prisma` và chạy lệnh `npx prisma generate` bên trong Docker (Linux), Prisma 7 có hành vi tự động ghi đuôi file `.ts` vào các lệnh import nội bộ (VD: `import * as $Class from "./internal/class.ts"`). Khi biên dịch sang JavaScript và chạy bằng Node.js, Node.js sẽ báo lỗi `Cannot find module './internal/class.ts'` vì chuẩn CJS không thể đọc file đuôi `.ts`. Lỗi này kỳ lạ là không xảy ra trên Windows.
- **Giải pháp:** Sử dụng công cụ `sed` can thiệp trực tiếp vào `Dockerfile` của Backend để càn quét và đổi tất cả đuôi `.ts` thành `.js` ngay sau khi Prisma sinh code:
  ```dockerfile
  RUN npx prisma generate
  # Sửa lỗi Prisma 7 sinh import .ts trên Linux
  RUN find src/generated/prisma -type f -name "*.ts" -exec sed -i 's/\.ts"/.js"/g' {} +
  RUN find src/generated/prisma -type f -name "*.ts" -exec sed -i "s/\.ts'/.js'/g" {} +
  ```

### 3.4. Lỗi Validation Regex của biến môi trường (class-validator)
- **Lỗi gặp phải:** Ứng dụng bị crash ngay khi khởi động: `Invalid environment configuration: AMAZON_DELIVERY_ZIP must be a 5-digit US ZIP...`
- **Giải pháp:** Lập trình viên thiết lập giá trị mặc định cho `AMAZON_DELIVERY_ZIP` là chuỗi rỗng `""` (để báo hiệu không dùng). Tuy nhiên, bộ lọc `@Matches(/^\d{5}$/)` của `class-validator` lại quá cứng ngắc và đánh trượt chuỗi rỗng. Đã chỉnh sửa cấu trúc Regex cho phép chuỗi rỗng: `/^(\d{5})?$/`.

### 3.5. Xử lý CORS và định tuyến nội bộ trong mạng LAN
- **Vấn đề:** Khi deploy độc lập, Frontend trên trình duyệt gọi API sang Backend sẽ gây lỗi CORS do khác cổng hoặc khác IP, đặc biệt phức tạp khi cấu hình biến môi trường IP động.
- **Giải pháp:** Container `frontend` (dùng Nginx) được thiết lập tính năng `proxy_pass`. Toàn bộ các request có tiền tố `/api` từ người dùng sẽ được Nginx chặn lại và đẩy ngầm sang container `backend:3000` nội bộ. Nhờ đó, Frontend và Backend chạy chung trên một "mái nhà" (port 80) đối với người dùng cuối, triệt tiêu hoàn toàn rắc rối liên quan tới CORS.
