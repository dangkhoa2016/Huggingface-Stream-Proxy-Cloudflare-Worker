# Changelog

## 1.0.0 - 2026-08-17

Initial release.

- Stream files from Hugging Face to Kaggle or any HTTP client via a Cloudflare Worker.
- Authenticate upstream requests with `HF_TOKEN` scoped to `huggingface.co`.
- Handle redirects manually with a configurable hop limit, stripping auth on Xet/CDN/other hosts.
- Preserve `Range`, `If-Range`, conditional GET headers, `GET`, and `HEAD`.
- Stream response bodies without buffering model files in Worker memory.
- Forward only an explicit allow-list of safe request headers; never forward
  client `Authorization` or `Cookie` headers upstream.
- Restrict direct proxy targets via `PROXY_ALLOWED_HOSTS`.
- Filter by country with `ALLOW_COUNTRIES`.
- Return CORS headers and strip upstream `Set-Cookie`.
- Serve optional favicon routes (`/favicon.ico`, `/favicon.png`) with separate `USER_TOKEN`.
- Forward `/assets/*` to an R2 companion Worker through `ASSET_SERVICE` binding.
- Provide Node.js unit tests for proxy security, redirects, streaming, conditional requests, CORS, favicon authentication, and Service Binding behavior.
