# Hugging Face Stream Proxy cho Cloudflare Workers

> 🌐 Language / Ngôn ngữ: [English](README.md) | **Tiếng Việt**

Cloudflare Worker giúp stream an toàn các file từ Hugging Face tới Kaggle hoặc
bất kỳ HTTP client nào. Worker hỗ trợ Resolver request có xác thực, byte range,
conditional request, redirect có giới hạn và stream response mà không buffer
toàn bộ file model trong bộ nhớ Worker.

Luồng streaming chính:

```text
Client
  -> Stream Proxy Worker
  -> huggingface.co/resolve/<commit>/<file> + HF_TOKEN
  -> Xet/CDN signed URL không mang HF_TOKEN
  -> streamed response
```

Luồng lưu trữ asset tùy chọn:

```text
Client
  -> /assets/*
  -> ASSET_SERVICE
  -> R2 Assets Worker
  -> Cloudflare R2
```

Luồng asset sử dụng dự án companion
[Huggingface Models Assets Cloudflare Worker](https://github.com/dangkhoa2016/Huggingface-Models-Assets-Cloudflare-Worker).

## Tính năng

- Stream upstream response body mà không nạp toàn bộ file model vào bộ nhớ
  Worker.
- Hỗ trợ request `GET`, `HEAD` và `OPTIONS`.
- Giữ lại `Range` cùng các conditional-request header và trả về upstream
  metadata như ETag.
- Chỉ thêm `HF_TOKEN` cho hostname chính xác `huggingface.co`.
- Xử lý redirect thủ công với số hop có thể cấu hình.
- Loại bỏ thông tin xác thực khi request chuyển sang Xet, CDN hoặc host khác.
- Từ chối direct target không dùng HTTPS và redirect hạ cấp khỏi HTTPS.
- Giới hạn direct proxy target bằng `PROXY_ALLOWED_HOSTS`.
- Hỗ trợ lọc quốc gia tùy chọn bằng `ALLOW_COUNTRIES`.
- Trả về CORS header và loại bỏ upstream `Set-Cookie` header.
- Cung cấp các route favicon tùy chọn với credential được giới hạn riêng.
- Forward `/assets/*` tới một R2 Worker tùy chọn qua Cloudflare Service
  Binding.

## Mô hình bảo mật

Hugging Face Resolver URL thường redirect tới signed Xet hoặc CDN URL. Việc tự
động follow redirect có thể chuyển tiếp sensitive header sang một hostname
khác, vì vậy Worker dùng `redirect: "manual"` và dựng lại upstream header tại
mỗi hop.

```text
huggingface.co      -> Authorization: Bearer <HF_TOKEN>
redirect cùng host  -> Authorization: Bearer <HF_TOKEN>
Xet/CDN/host khác   -> không có Authorization header
```

`Authorization` và `Cookie` do client gửi không được copy vào Hugging Face
upstream request. Worker chỉ forward một allow-list nhỏ gồm các download và
cache header. Redirect phải tiếp tục sử dụng HTTPS và không được vượt quá
`MAX_REDIRECTS`.

`PROXY_ALLOWED_HOSTS` kiểm soát direct target ban đầu. Cách này cho phép signed
redirect sang host khác nhưng ngăn public endpoint trở thành một direct proxy
không giới hạn theo mặc định.

## Cấu trúc dự án

```text
src/worker.js               Mã nguồn Worker
wrangler.toml.example       Cấu hình mẫu
test/worker.test.js         Tests với mocked upstream requests
package.json                Scripts kiểm thử và syntax check
CHANGELOG.md                Lịch sử phát hành
README.md                 Tài liệu tiếng Anh
README.vi.md              Tài liệu tiếng Việt
```

## Yêu cầu

- Tài khoản Cloudflare đã bật Workers.
- Hugging Face access token loại `fine-grained` hoặc `read`.
- Node.js 20 trở lên để chạy kiểm tra local.
- Wrangler 4 để deploy; các ví dụ sử dụng `npx wrangler`.
- Dự án R2 companion chỉ cần thiết khi sử dụng `/assets/*`.

Clone repository:

```bash
git clone https://github.com/dangkhoa2016/Huggingface-Stream-Proxy-Cloudflare-Worker.git
cd Huggingface-Stream-Proxy-Cloudflare-Worker
```

## Cấu hình

Trước khi chạy Wrangler, hãy tạo file cấu hình deploy local:

```bash
cp wrangler.toml.example wrangler.toml
```

Sau đó chỉnh `wrangler.toml` để đặt `name` thành tên Cloudflare Worker bạn
muốn deploy và điều chỉnh các giá trị riêng cho môi trường nếu cần.

Các biến không chứa secret:

```toml
[vars]
ALLOW_COUNTRIES = "*"
PROXY_ALLOWED_HOSTS = "huggingface.co"
MAX_REDIRECTS = "8"
```

- `ALLOW_COUNTRIES`: `*` cho phép mọi quốc gia. Danh sách phân tách bằng dấu
  phẩy như `VN, US, SG` sẽ giới hạn truy cập theo `request.cf.country`.
- `MAX_REDIRECTS`: số redirect hop tối đa, được Worker giới hạn không quá 20.


### `PROXY_ALLOWED_HOSTS`

Cấu hình bảo mật mặc định chỉ cho phép direct request tới Hugging Face:

```toml
PROXY_ALLOWED_HOSTS = "huggingface.co"
```

Có thể allow-list nhiều direct host:

```toml
PROXY_ALLOWED_HOSTS = "huggingface.co,example.com"
```

Có thể bật direct proxy không giới hạn một cách tường minh:

```toml
PROXY_ALLOWED_HOSTS = "*"
```

Bất kể cấu hình này, `HF_TOKEN` luôn chỉ được gửi tới hostname chính xác
`huggingface.co`.

## Cloudflare secrets

`wrangler.toml.example` trong repository khai báo `HF_TOKEN` là bắt buộc.
Xem phần Triển khai bên dưới để biết workflow khởi tạo lần đầu. Không lưu
giá trị token trong mã nguồn, `wrangler.toml`, command history hoặc log.

Các route favicon `/favicon.ico` và `/favicon.png` sử dụng một secret tùy chọn
riêng (`USER_TOKEN`). Secret này không bắt buộc để core proxy hoạt động.

`USER_TOKEN` là secret tùy chọn và chỉ cần cho các route favicon. Core proxy
Hugging Face không yêu cầu `USER_TOKEN`. Không thêm `USER_TOKEN` vào danh
sách production required-secret trong `wrangler.toml.example`.

Vì production config chỉ liệt kê `HF_TOKEN` trong `[secrets].required`, các
khóa secret local bổ sung như `USER_TOKEN` có thể không được inject tự động
qua cùng đường dẫn nạp secret local. Để test favicon local:

1. Copy `wrangler.toml.example` thành `wrangler.toml` ignored local.
2. Thêm `USER_TOKEN` vào danh sách local `[secrets].required` chỉ cho test.
3. Tạo file secret ignored local (ví dụ `.env`) chứa
   `USER_TOKEN=<your-token>`.
4. Chạy `npx wrangler dev` với config local.
5. Giữ template production checked-in không thay đổi.

## Triển khai

Chọn triển khai core proxy hoặc tích hợp R2 tùy chọn
trước khi deploy.

### Chỉ triển khai core proxy

Xóa block `[[services]]` khỏi `wrangler.toml` đã tạo ở trên nếu không sử dụng
`/assets/*`:

```toml
[[services]]
binding = "ASSET_SERVICE"
service = "huggingface-models-assets-worker"
```

Sau đó xác minh local, cấu hình và deploy:

```bash
npm install

npm run check
npm test
npm run deploy:dry-run

npx wrangler deploy --secrets-file <secure-secret-file>
```

Secrets file có thể ở định dạng JSON hoặc `.env`. Giữ file ngoài repository
và không commit nó. Ví dụ định dạng `.env`:

```text
HF_TOKEN=<your-token-value>
```

`wrangler secret put` cũng được hỗ trợ nhưng là thao tác có ảnh hưởng tới
deployment và tạo Worker version mới. Ưu tiên `--secrets-file` cho deployment
lần đầu để tránh intermediate draft deployment.

Hugging Face proxy và các route favicon tùy chọn không phụ thuộc vào R2.
Request tới `/assets/*` sẽ trả `503 Service Unavailable` khi không có
`ASSET_SERVICE`.

### Tích hợp R2 asset tùy chọn

Deploy
[Huggingface Models Assets Cloudflare Worker](https://github.com/dangkhoa2016/Huggingface-Models-Assets-Cloudflare-Worker)
trước và làm theo README của dự án đó để tạo R2 bucket cùng secret
`PUBLISH_TOKEN`. Companion Worker sau khi deploy phải sử dụng service name
`huggingface-models-assets-worker`.

Giữ binding sau trong cấu hình stream proxy:

```toml
[[services]]
binding = "ASSET_SERVICE"
service = "huggingface-models-assets-worker"
```

Sau đó deploy stream proxy với secret:

```bash
npx wrangler deploy --secrets-file <secure-secret-file>
```

Secrets file có thể ở định dạng JSON hoặc `.env`:

```text
HF_TOKEN=<your-token-value>
```

Giữ file ngoài repository và không commit nó.

Cloudflare yêu cầu target Worker tồn tại trước khi deploy một caller có Service
Binding.

### Cloudflare dashboard

Khi deploy qua dashboard, tạo ES module Worker từ
`src/worker.js` và cấu hình:

```text
HF_TOKEN secret
ALLOW_COUNTRIES variable
PROXY_ALLOWED_HOSTS variable
MAX_REDIRECTS variable
USER_TOKEN secret (chỉ dành cho các route favicon)
ASSET_SERVICE binding (chỉ dành cho tích hợp R2)
```

## Cách sử dụng

### Proxy URL

Truyền upstream URL qua query parameter `url`. Có thể bỏ scheme vì Worker mặc
định sử dụng HTTPS:

```text
https://<worker-domain>/?url=huggingface.co/<repo>/resolve/<commit>/<path>
```

Nên pin commit hash để download có thể tái tạo.

### HEAD request

```bash
curl -I \
  'https://<worker-domain>/?url=huggingface.co/zai-org/GLM-4-9B-0414/resolve/645b8482494e31b6b752272bf7f7f273ef0f3caf/config.json'
```

Metadata request thành công trả HTTP 200 cùng upstream header và không có
response body.

### Range request

Download MiB đầu tiên của một file:

```bash
curl -fL \
  -H 'Range: bytes=0-1048575' \
  -o first-1MiB.bin \
  'https://<worker-domain>/?url=huggingface.co/zai-org/GLM-4-9B-0414/resolve/645b8482494e31b6b752272bf7f7f273ef0f3caf/model-00001-of-00004.safetensors'
```

Xem response header:

```bash
curl -sS -D headers.txt \
  -H 'Range: bytes=0-1048575' \
  -o first-1MiB.bin \
  'https://<worker-domain>/?url=huggingface.co/zai-org/GLM-4-9B-0414/resolve/645b8482494e31b6b752272bf7f7f273ef0f3caf/model-00001-of-00004.safetensors'
```

Nếu upstream hỗ trợ Range, kết quả mong đợi là:

```text
HTTP/2 206
Content-Range: bytes ...
Accept-Ranges: bytes
```

### Public assets

Khi đã cấu hình `ASSET_SERVICE`, README snapshot và các asset liên quan được
phục vụ qua:

```text
https://<worker-domain>/assets/hf/<owner>/<repo>/<commit>/<path>
```

Public request `GET` và `HEAD` không cần token. Việc publish asset sử dụng
`PUBLISH_TOKEN` và được mô tả trong companion repository.

## Kiểm thử local

Test suite không cần thêm runtime dependency:

```bash
npm test
npm run check
```

Tests bao phủ authentication scoping, lọc header, redirect, Range và HEAD
request, CORS, country và target allow-list, xác thực favicon, loại bỏ cookie,
cùng việc forward và xử lý lỗi `ASSET_SERVICE`.

## Tài liệu tham khảo

- [Cloudflare Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Hugging Face Hub rate limits](https://huggingface.co/docs/hub/en/rate-limits)
- [Hugging Face User Access Tokens](https://huggingface.co/docs/hub/security-tokens)

## Giấy phép

[MIT](LICENSE)
