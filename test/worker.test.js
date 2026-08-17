import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isHuggingFaceAuthHost,
  buildUpstreamHeaders,
  isAllowedProxyTarget,
} from '../src/worker.js';

test('recognizes only the exact huggingface.co auth host', () => {
  assert.equal(isHuggingFaceAuthHost(new URL('https://huggingface.co/a/b')), true);
  assert.equal(isHuggingFaceAuthHost(new URL('https://HUGGINGFACE.CO/a/b')), true);
  assert.equal(isHuggingFaceAuthHost(new URL('https://huggingface.co.evil.example/a')), false);
  assert.equal(isHuggingFaceAuthHost(new URL('https://evil-huggingface.co/a')), false);
});

test('buildUpstreamHeaders injects HF token only on huggingface.co and preserves Range', () => {
  const incoming = new Headers({
    authorization: 'Bearer client-secret',
    cookie: 'session=secret',
    range: 'bytes=100-199',
    'if-range': 'etag-value',
    accept: '*/*',
  });

  const hf = buildUpstreamHeaders(
    incoming,
    new URL('https://huggingface.co/org/repo/resolve/main/file.bin'),
    { HF_TOKEN: 'hf_secret' },
    { authHost: 'huggingface.co', tokenEnvName: 'HF_TOKEN' },
  );

  assert.equal(hf.get('authorization'), 'Bearer hf_secret');
  assert.equal(hf.get('cookie'), null);
  assert.equal(hf.get('range'), 'bytes=100-199');
  assert.equal(hf.get('if-range'), 'etag-value');

  const cdn = buildUpstreamHeaders(
    incoming,
    new URL('https://cdn-lfs.huggingface.co/signed/file.bin'),
    { HF_TOKEN: 'hf_secret' },
    { authHost: 'huggingface.co', tokenEnvName: 'HF_TOKEN' },
  );

  assert.equal(cdn.get('authorization'), null);
  assert.equal(cdn.get('cookie'), null);
  assert.equal(cdn.get('range'), 'bytes=100-199');
});

test('proxy target defaults to huggingface.co only', () => {
  assert.equal(
    isAllowedProxyTarget(new URL('https://huggingface.co/a/b'), {}),
    true,
  );
  assert.equal(
    isAllowedProxyTarget(new URL('https://example.com/a'), {}),
    false,
  );
  assert.equal(
    isAllowedProxyTarget(new URL('https://example.com/a'), { PROXY_ALLOWED_HOSTS: 'huggingface.co,example.com' }),
    true,
  );
  assert.equal(
    isAllowedProxyTarget(new URL('https://anything.example/a'), { PROXY_ALLOWED_HOSTS: '*' }),
    true,
  );
});

import { fetchWithScopedRedirects } from '../src/worker.js';

test('manual redirect sends HF token only to huggingface.co and preserves Range on CDN hop', async () => {
  const seen = [];
  const fetchImpl = async (request) => {
    seen.push(request);
    if (seen.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://cdn-lfs.huggingface.co/signed/model.bin' },
      });
    }
    return new Response('partial-data', {
      status: 206,
      headers: {
        'content-range': 'bytes 0-9/100',
        'content-length': '10',
      },
    });
  };

  const incoming = new Request('https://proxy.example/?url=huggingface.co/a/b', {
    method: 'GET',
    headers: {
      range: 'bytes=0-9',
      authorization: 'Bearer untrusted-client-token',
      cookie: 'secret=1',
    },
  });

  const response = await fetchWithScopedRedirects(
    incoming,
    new URL('https://huggingface.co/org/repo/resolve/commit/model.bin'),
    { HF_TOKEN: 'hf_secret' },
    {
      authHost: 'huggingface.co',
      tokenEnvName: 'HF_TOKEN',
      fetchImpl,
      maxRedirects: 8,
    },
  );

  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'partial-data');
  assert.equal(seen.length, 2);

  assert.equal(seen[0].redirect, 'manual');
  assert.equal(seen[0].headers.get('authorization'), 'Bearer hf_secret');
  assert.equal(seen[0].headers.get('range'), 'bytes=0-9');
  assert.equal(seen[0].headers.get('cookie'), null);

  assert.equal(seen[1].url, 'https://cdn-lfs.huggingface.co/signed/model.bin');
  assert.equal(seen[1].headers.get('authorization'), null);
  assert.equal(seen[1].headers.get('range'), 'bytes=0-9');
  assert.equal(seen[1].headers.get('cookie'), null);
});

test('manual redirect re-adds scoped authorization when redirected within huggingface.co', async () => {
  const authHeaders = [];
  const fetchImpl = async (request) => {
    authHeaders.push(request.headers.get('authorization'));
    if (authHeaders.length === 1) {
      return new Response(null, {
        status: 307,
        headers: { location: '/api/resolve-cache/models/org/repo/file' },
      });
    }
    return new Response('ok', { status: 200 });
  };

  const incoming = new Request('https://proxy.example/?url=x', { method: 'HEAD' });
  const response = await fetchWithScopedRedirects(
    incoming,
    new URL('https://huggingface.co/org/repo/resolve/main/file'),
    { HF_TOKEN: 'hf_secret' },
    { authHost: 'huggingface.co', tokenEnvName: 'HF_TOKEN', fetchImpl },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(authHeaders, ['Bearer hf_secret', 'Bearer hf_secret']);
});

test('manual redirect rejects HTTPS downgrade', async () => {
  const fetchImpl = async () => new Response(null, {
    status: 302,
    headers: { location: 'http://example.com/file' },
  });

  const incoming = new Request('https://proxy.example/?url=x');

  await assert.rejects(
    () => fetchWithScopedRedirects(
      incoming,
      new URL('https://huggingface.co/org/repo/resolve/main/file'),
      { HF_TOKEN: 'hf_secret' },
      { authHost: 'huggingface.co', tokenEnvName: 'HF_TOKEN', fetchImpl },
    ),
    /HTTPS/,
  );
});

test('manual redirect enforces redirect hop limit', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    return new Response(null, {
      status: 302,
      headers: { location: `https://huggingface.co/redirect/${count}` },
    });
  };

  const incoming = new Request('https://proxy.example/?url=x');

  await assert.rejects(
    () => fetchWithScopedRedirects(
      incoming,
      new URL('https://huggingface.co/start'),
      { HF_TOKEN: 'hf_secret' },
      {
        authHost: 'huggingface.co',
        tokenEnvName: 'HF_TOKEN',
        fetchImpl,
        maxRedirects: 2,
      },
    ),
    /Too many redirects/,
  );
  assert.equal(count, 3);
});

import worker, { createWorker } from '../src/worker.js';

function requestWithCountry(url, init, country) {
  const request = new Request(url, init);
  Object.defineProperty(request, 'cf', {
    value: { country },
    configurable: true,
  });
  return request;
}

test('worker returns welcome JSON when url is missing', async () => {
  const response = await worker.fetch(new Request('https://proxy.example/'), {}, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    message: '~~ Welcome ~~',
    proxy: 'huggingface-stream-proxy-worker',
    version: '1.0.0',
  });
});

test('worker rejects proxy methods other than GET HEAD OPTIONS', async () => {
  const response = await worker.fetch(
    new Request('https://proxy.example/?url=huggingface.co/a/b', { method: 'POST' }),
    { HF_TOKEN: 'hf_secret' },
    {},
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD, OPTIONS');
});

test('worker requires HF_TOKEN for huggingface.co proxy requests', async () => {
  const response = await worker.fetch(
    new Request('https://proxy.example/?url=huggingface.co/a/b'),
    {},
    {},
  );
  assert.equal(response.status, 500);
  const data = await response.json();
  assert.match(data.message, /HF_TOKEN/);
});

test('worker blocks non-HF direct targets by default', async () => {
  const response = await worker.fetch(
    new Request('https://proxy.example/?url=example.com/file'),
    { HF_TOKEN: 'hf_secret' },
    {},
  );
  assert.equal(response.status, 403);
});

test('worker proxies GET with HF auth, Range, streaming headers and CORS', async () => {
  const seen = [];
  const testWorker = createWorker(async (upstreamRequest) => {
    seen.push(upstreamRequest);
    return new Response('0123456789', {
      status: 206,
      headers: {
        'content-range': 'bytes 0-9/100',
        'accept-ranges': 'bytes',
        etag: 'abc',
      },
    });
  });

  const response = await testWorker.fetch(
    new Request(
      'https://proxy.example/?url=huggingface.co/org/repo/resolve/main/model.bin',
      { headers: { range: 'bytes=0-9' } },
    ),
    { HF_TOKEN: 'hf_secret' },
    {},
  );

  assert.equal(response.status, 206);
  assert.equal(await response.text(), '0123456789');
  assert.equal(response.headers.get('content-range'), 'bytes 0-9/100');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-expose-headers'), '*');
  assert.equal(seen[0].headers.get('authorization'), 'Bearer hf_secret');
  assert.equal(seen[0].headers.get('range'), 'bytes=0-9');
});

test('worker supports HEAD without buffering a body', async () => {
  const testWorker = createWorker(async () => new Response(null, {
    status: 200,
    headers: { 'content-length': '123456789', etag: 'abc' },
  }));

  const response = await testWorker.fetch(
    new Request(
      'https://proxy.example/?url=huggingface.co/org/repo/resolve/main/model.bin',
      { method: 'HEAD' },
    ),
    { HF_TOKEN: 'hf_secret' },
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '123456789');
  assert.equal(await response.text(), '');
});

test('worker preserves country allow-list behavior', async () => {
  const request = requestWithCountry(
    'https://proxy.example/?url=huggingface.co/a/b',
    {},
    'DE',
  );
  const response = await worker.fetch(
    request,
    { ALLOW_COUNTRIES: 'VN, US, SG', HF_TOKEN: 'hf_secret' },
    {},
  );
  assert.equal(response.status, 403);
  const data = await response.json();
  assert.match(data.message, /DE/);
});

test('OPTIONS returns CORS preflight response', async () => {
  const response = await worker.fetch(
    new Request('https://proxy.example/?url=huggingface.co/a/b', { method: 'OPTIONS' }),
    {},
    {},
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS');
  const allowHeaders = response.headers.get('access-control-allow-headers');
  assert.match(allowHeaders, /If-Match/);
  assert.match(allowHeaders, /If-Unmodified-Since/);
  assert.match(allowHeaders, /Range/);
  assert.match(allowHeaders, /If-Range/);
});

test('favicon USER_TOKEN is stripped when file-storage redirects to another host', async () => {
  const seen = [];
  const testWorker = createWorker(async (request) => {
    seen.push(request);
    if (seen.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://storage.example/icon.ico' },
      });
    }
    return new Response('icon', {
      status: 200,
      headers: { 'content-type': 'image/x-icon' },
    });
  });

  const response = await testWorker.fetch(
    new Request('https://proxy.example/favicon.ico'),
    { USER_TOKEN: 'user_secret' },
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'icon');
  assert.equal(seen[0].headers.get('authorization'), 'Bearer user_secret');
  assert.equal(seen[1].headers.get('authorization'), null);
});

test('worker strips upstream Set-Cookie from proxied responses', async () => {
  const testWorker = createWorker(async () => new Response('ok', {
    status: 200,
    headers: { 'set-cookie': 'upstream_session=secret; Secure; HttpOnly' },
  }));

  const response = await testWorker.fetch(
    new Request('https://proxy.example/?url=huggingface.co/org/repo/resolve/main/file'),
    { HF_TOKEN: 'hf_secret' },
    {},
  );

  assert.equal(response.headers.get('set-cookie'), null);
});

test('asset routes forward the original request through ASSET_SERVICE', async () => {
  const seen = [];
  const assetService = {
    async fetch(request) {
      seen.push(request);
      return new Response('stored-asset', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    },
  };

  const response = await worker.fetch(
    new Request(
      'https://proxy.example/assets/hf/owner/repo/' + 'a'.repeat(40) + '/logo.png',
      { headers: { authorization: 'Bearer publish-secret', range: 'bytes=0-9' } },
    ),
    { ASSET_SERVICE: assetService },
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'stored-asset');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://proxy.example/assets/hf/owner/repo/' + 'a'.repeat(40) + '/logo.png');
  assert.equal(seen[0].headers.get('authorization'), 'Bearer publish-secret');
  assert.equal(seen[0].headers.get('range'), 'bytes=0-9');
});

test('asset routes return 503 when ASSET_SERVICE is not configured', async () => {
  const response = await worker.fetch(
    new Request('https://proxy.example/assets/hf/owner/repo/' + 'a'.repeat(40) + '/README.md'),
    {},
    {},
  );

  assert.equal(response.status, 503);
  assert.match((await response.json()).message, /ASSET_SERVICE/);
});

test('asset routes return 502 when the downstream service fails', async () => {
  const response = await worker.fetch(
    new Request('https://proxy.example/assets/hf/owner/repo/' + 'a'.repeat(40) + '/README.md'),
    {
      ASSET_SERVICE: {
        async fetch() {
          throw new Error('service unavailable');
        },
      },
    },
    {},
  );

  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'Bad Gateway');
});
