# Hugging Face Stream Proxy for Cloudflare Workers

> 🌐 Language / Ngôn ngữ: **English** | [Tiếng Việt](README.vi.md)

A Cloudflare Worker that securely streams files from Hugging Face to Kaggle or
any HTTP client. It supports authenticated Resolver requests, byte ranges,
conditional requests, bounded redirects, and response streaming without
buffering model files in Worker memory.

Core streaming flow:

```text
Client
  -> Stream Proxy Worker
  -> huggingface.co/resolve/<commit>/<file> + HF_TOKEN
  -> Xet/CDN signed URL without HF_TOKEN
  -> streamed response
```

Optional persistent asset flow:

```text
Client
  -> /assets/*
  -> ASSET_SERVICE
  -> R2 Assets Worker
  -> Cloudflare R2
```

The asset flow uses the companion project
[Huggingface Models Assets Cloudflare Worker](https://github.com/dangkhoa2016/Huggingface-Models-Assets-Cloudflare-Worker).

## Features

- Streams upstream response bodies without loading complete model files into
  Worker memory.
- Supports `GET`, `HEAD`, and `OPTIONS` requests.
- Preserves `Range` and conditional-request headers, and returns upstream
  metadata such as ETag.
- Adds `HF_TOKEN` only for the exact hostname `huggingface.co`.
- Follows redirects manually with a configurable hop limit.
- Removes authentication when a request moves to Xet, a CDN, or another host.
- Rejects direct non-HTTPS targets and HTTPS downgrade redirects.
- Restricts direct proxy targets through `PROXY_ALLOWED_HOSTS`.
- Supports optional country filtering through `ALLOW_COUNTRIES`.
- Returns CORS headers and removes upstream `Set-Cookie` headers.
- Provides optional favicon routes with separately scoped credentials.
- Forwards `/assets/*` to an optional R2 Worker through a Cloudflare Service
  Binding.

## Security model

Hugging Face Resolver URLs commonly redirect to signed Xet or CDN URLs.
Automatically following redirects can forward sensitive headers to a different
hostname, so this Worker uses `redirect: "manual"` and rebuilds the upstream
headers at every hop.

```text
huggingface.co      -> Authorization: Bearer <HF_TOKEN>
same-host redirect  -> Authorization: Bearer <HF_TOKEN>
Xet/CDN/other host  -> no Authorization header
```

Client-provided `Authorization` and `Cookie` headers are never copied into
Hugging Face upstream requests. Only a small allow-list of download and cache
headers is forwarded. Redirects must remain on HTTPS and cannot exceed
`MAX_REDIRECTS`.

`PROXY_ALLOWED_HOSTS` controls the initial direct target. This allows signed
cross-host redirects while preventing the public endpoint from becoming an
unrestricted direct proxy by default.

## Project structure

```text
src/worker.js               Worker source
wrangler.toml.example       Configuration template
test/worker.test.js         Tests with mocked upstream requests
package.json                Test and syntax-check scripts
CHANGELOG.md                Release history
README.md                 English documentation
README.vi.md              Vietnamese documentation
```

## Requirements

- A Cloudflare account with Workers enabled.
- A Hugging Face `fine-grained` or `read` access token.
- Node.js 20 or newer for local checks.
- Wrangler 4 for deployment; the examples use `npx wrangler`.
- The companion R2 project only when `/assets/*` is required.

Clone the repository:

```bash
git clone https://github.com/dangkhoa2016/Huggingface-Stream-Proxy-Cloudflare-Worker.git
cd Huggingface-Stream-Proxy-Cloudflare-Worker
```

## Configuration

Create your local deployment configuration before running Wrangler:

```bash
cp wrangler.toml.example wrangler.toml
```

Then edit `wrangler.toml` to set `name` to your Cloudflare Worker name and
adjust environment-specific values if needed.

Available non-secret variables:

```toml
[vars]
ALLOW_COUNTRIES = "*"
PROXY_ALLOWED_HOSTS = "huggingface.co"
MAX_REDIRECTS = "8"
```

- `ALLOW_COUNTRIES`: `*` permits every country. A comma-separated list such as
  `VN, US, SG` restricts access using `request.cf.country`.
- `MAX_REDIRECTS`: maximum redirect hops, capped by the Worker at 20.

### `PROXY_ALLOWED_HOSTS`

The secure default permits direct requests only to Hugging Face:

```toml
PROXY_ALLOWED_HOSTS = "huggingface.co"
```

Multiple direct hosts can be allow-listed:

```toml
PROXY_ALLOWED_HOSTS = "huggingface.co,example.com"
```

An unrestricted direct proxy can be enabled explicitly:

```toml
PROXY_ALLOWED_HOSTS = "*"
```

`HF_TOKEN` remains scoped to the exact hostname `huggingface.co` regardless of
this setting.

## Cloudflare secrets

The checked-in `wrangler.toml.example` declares `HF_TOKEN` as required.
See the Deployment section below for the recommended first-time
provisioning workflow. Do not store token values in source code,
`wrangler.toml`, command history, or logs.

The favicon routes `/favicon.ico` and `/favicon.png` use a separate optional
secret (`USER_TOKEN`). It is not required for the core proxy to function.

`USER_TOKEN` is optional and only needed for the favicon routes. Core Hugging
Face proxy functionality does not require `USER_TOKEN`. Do not add
`USER_TOKEN` to the production required-secret list in `wrangler.toml.example`.

Because the production config only lists `HF_TOKEN` in `[secrets].required`,
additional local secret keys like `USER_TOKEN` may not be injected
automatically through the same local secret-loading path. For local favicon
testing:

1. Copy `wrangler.toml.example` to an ignored local `wrangler.toml`.
2. Add `USER_TOKEN` to the local `[secrets].required` list for local tests
   only.
3. Create an ignored local secret file (e.g. `.env`) containing
   `USER_TOKEN=<your-token>`.
4. Run `npx wrangler dev` with the local config.
5. Keep the checked-in production template unchanged.

## Deployment

Choose either the core proxy deployment or the optional R2 integration before
deploying.

### Core proxy only

Remove the `[[services]]` block from the already-created `wrangler.toml`
if `/assets/*` is not needed:

```toml
[[services]]
binding = "ASSET_SERVICE"
service = "huggingface-models-assets-worker"
```

Then verify locally, configure and deploy:

```bash
npm install

npm run check
npm test
npm run deploy:dry-run

npx wrangler deploy --secrets-file <secure-secret-file>
```

The secrets file can be JSON or `.env` format. Keep it outside the
repository and do not commit it. Example `.env` format:

```text
HF_TOKEN=<your-token-value>
```

`wrangler secret put` is also supported but is a deployment-affecting
operation that creates a new Worker version. Prefer `--secrets-file` for
first-time deployment to avoid an intermediate draft deployment.

The Hugging Face proxy and optional favicon routes do not depend on R2.
Requests to `/assets/*` return `503 Service Unavailable` without
`ASSET_SERVICE`.

### Optional R2 asset integration

Deploy
[Huggingface Models Assets Cloudflare Worker](https://github.com/dangkhoa2016/Huggingface-Models-Assets-Cloudflare-Worker)
first and follow its README to create the R2 bucket and `PUBLISH_TOKEN` secret.
The deployed companion Worker must use the service name
`huggingface-models-assets-worker`.

Keep this binding in the stream proxy configuration:

```toml
[[services]]
binding = "ASSET_SERVICE"
service = "huggingface-models-assets-worker"
```

Then deploy the stream proxy with its secret:

```bash
npx wrangler deploy --secrets-file <secure-secret-file>
```

The secrets file can be JSON or `.env` format:

```text
HF_TOKEN=<your-token-value>
```

Keep it outside the repository and do not commit it.

Cloudflare requires the target Worker to exist before deploying a caller with a
Service Binding.

### Cloudflare dashboard

When deploying through the dashboard, create an ES module Worker from
`src/worker.js` and configure:

```text
HF_TOKEN secret
ALLOW_COUNTRIES variable
PROXY_ALLOWED_HOSTS variable
MAX_REDIRECTS variable
USER_TOKEN secret (only for favicon routes)
ASSET_SERVICE binding (only for the R2 integration)
```

## Usage

### Proxy URL

Pass the upstream URL through the `url` query parameter. The scheme may be
omitted because the Worker defaults it to HTTPS:

```text
https://<worker-domain>/?url=huggingface.co/<repo>/resolve/<commit>/<path>
```

Pin a commit hash for reproducible downloads.

### HEAD request

```bash
curl -I \
  'https://<worker-domain>/?url=huggingface.co/zai-org/GLM-4-9B-0414/resolve/645b8482494e31b6b752272bf7f7f273ef0f3caf/config.json'
```

A successful metadata request returns HTTP 200 with the upstream headers and no
response body.

### Range request

Download the first MiB of a file:

```bash
curl -fL \
  -H 'Range: bytes=0-1048575' \
  -o first-1MiB.bin \
  'https://<worker-domain>/?url=huggingface.co/zai-org/GLM-4-9B-0414/resolve/645b8482494e31b6b752272bf7f7f273ef0f3caf/model-00001-of-00004.safetensors'
```

Inspect response headers:

```bash
curl -sS -D headers.txt \
  -H 'Range: bytes=0-1048575' \
  -o first-1MiB.bin \
  'https://<worker-domain>/?url=huggingface.co/zai-org/GLM-4-9B-0414/resolve/645b8482494e31b6b752272bf7f7f273ef0f3caf/model-00001-of-00004.safetensors'
```

When supported by the upstream, expect:

```text
HTTP/2 206
Content-Range: bytes ...
Accept-Ranges: bytes
```

### Public assets

With `ASSET_SERVICE` configured, uploaded README snapshots and related assets
are available through:

```text
https://<worker-domain>/assets/hf/<owner>/<repo>/<commit>/<path>
```

Public `GET` and `HEAD` requests do not require a token. Asset publication uses
`PUBLISH_TOKEN` and is documented in the companion repository.

## Local tests

The test suite has no additional runtime dependency:

```bash
npm test
npm run check
```

The tests cover authentication scoping, header filtering, redirects, Range and
HEAD requests, CORS, country and target allow-lists, favicon authentication,
cookie stripping, and `ASSET_SERVICE` forwarding and failure responses.

## References

- [Cloudflare Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Hugging Face Hub rate limits](https://huggingface.co/docs/hub/en/rate-limits)
- [Hugging Face User Access Tokens](https://huggingface.co/docs/hub/security-tokens)

## License

[MIT](LICENSE)
