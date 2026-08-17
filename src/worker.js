/**
 * Cloudflare Worker - Hugging Face authenticated streaming proxy + favicon service
 * ES Modules worker.
 *
 * Secrets:
 *   HF_TOKEN   - Hugging Face access token used only for exact host huggingface.co
 *   USER_TOKEN - Existing favicon file-storage bearer token
 *
 * Optional vars:
 *   ALLOW_COUNTRIES     = "VN, US, SG" | "*"
 *   PROXY_ALLOWED_HOSTS = "huggingface.co" | comma-separated hosts | "*"
 *   MAX_REDIRECTS       = "8"
 */

const HUGGINGFACE_AUTH_HOST = 'huggingface.co';
const DEFAULT_PROXY_ALLOWED_HOSTS = 'huggingface.co';
const DEFAULT_MAX_REDIRECTS = 8;
const PROXY_USER_AGENT = 'huggingface-stream-proxy-worker/1.0';
const VERSION = '1.0.0';

const FAVICON_URLS = {
  ico: 'https://file-storage-cloudflare-worker.dangkhoa.dev/files/6deb691e-b42d-40d6-8554-8ab80a8efd88/download',
  png: 'https://file-storage-cloudflare-worker.dangkhoa.dev/files/d5a4b2eb-685c-4d5d-b21c-f44e4cf824d2/download',
};

const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-encoding',
  'cache-control',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'range',
];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isHuggingFaceAuthHost(url) {
  return url.hostname.toLowerCase() === HUGGINGFACE_AUTH_HOST;
}

export function buildUpstreamHeaders(incomingHeaders, targetUrl, env, authScope = {}) {
  const headers = new Headers();

  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = incomingHeaders.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }

  headers.set('user-agent', PROXY_USER_AGENT);

  const authHost = String(authScope.authHost || '').toLowerCase();
  const tokenEnvName = authScope.tokenEnvName;
  const token = tokenEnvName ? env?.[tokenEnvName] : undefined;

  // Authorization is rebuilt on every redirect hop. Client Authorization/Cookie
  // headers are never copied into this new Headers object.
  if (token && authHost && targetUrl.hostname.toLowerCase() === authHost) {
    headers.set('authorization', `Bearer ${token}`);
  }

  return headers;
}

export function isAllowedProxyTarget(url, env) {
  if (url.protocol !== 'https:') {
    return false;
  }

  const raw = env?.PROXY_ALLOWED_HOSTS ?? DEFAULT_PROXY_ALLOWED_HOSTS;
  if (String(raw).trim() === '*') {
    return true;
  }

  const allowed = new Set(
    String(raw)
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  return allowed.has(url.hostname.toLowerCase());
}

function maxRedirectsFromEnv(env) {
  const parsed = Number.parseInt(env?.MAX_REDIRECTS ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MAX_REDIRECTS;
  }
  return Math.min(parsed, 20);
}

export async function fetchWithScopedRedirects(
  incomingRequest,
  initialUrl,
  env,
  options = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = Number.isInteger(options.maxRedirects)
    ? options.maxRedirects
    : DEFAULT_MAX_REDIRECTS;
  const authScope = {
    authHost: options.authHost,
    tokenEnvName: options.tokenEnvName,
  };

  let currentUrl = new URL(initialUrl.toString());

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (currentUrl.protocol !== 'https:') {
      throw new Error('Upstream and redirect targets must use HTTPS.');
    }

    const headers = buildUpstreamHeaders(
      incomingRequest.headers,
      currentUrl,
      env,
      authScope,
    );

    const upstreamRequest = new Request(currentUrl.toString(), {
      method: incomingRequest.method,
      headers,
      redirect: 'manual',
    });

    const response = await fetchImpl(upstreamRequest);
    const location = response.headers.get('location');

    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return response;
    }

    if (hop === maxRedirects) {
      throw new Error(`Too many redirects (limit: ${maxRedirects}).`);
    }

    currentUrl = new URL(location, currentUrl);
    if (currentUrl.protocol !== 'https:') {
      throw new Error('Redirect target must use HTTPS.');
    }
  }

  throw new Error(`Too many redirects (limit: ${maxRedirects}).`);
}

function corsHeaders(extra = {}) {
  const headers = new Headers(extra);
  headers.set('Access-Control-Allow-Origin', '*');
  return headers;
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  const headers = corsHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  return new Response(JSON.stringify(payload), { status, headers });
}

function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, Accept-Encoding, Range, If-Range, If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since, Cache-Control',
      'Access-Control-Expose-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function countryIsAllowed(request, env) {
  if (!env?.ALLOW_COUNTRIES || env.ALLOW_COUNTRIES === '*') {
    return { allowed: true, country: request.cf?.country || 'UNKNOWN' };
  }

  const allowedCountries = String(env.ALLOW_COUNTRIES)
    .split(',')
    .map((country) => country.trim().toUpperCase())
    .filter(Boolean);

  const country = request.cf?.country || 'UNKNOWN';
  return { allowed: allowedCountries.includes(country), country };
}

function parseTargetUrl(requestUrl) {
  let targetUrlString = requestUrl.searchParams.get('url');
  if (!targetUrlString) {
    return null;
  }

  if (!/^https?:\/\//i.test(targetUrlString)) {
    targetUrlString = `https://${targetUrlString}`;
  }

  return new URL(targetUrlString);
}

function upstreamResponse(response, requestMethod, extraHeaders = {}) {
  const headers = new Headers(response.headers);
  // Do not turn upstream cookies into cookies for the proxy hostname.
  headers.delete('set-cookie');
  headers.delete('set-cookie2');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers', '*');

  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }

  // HEAD responses must not expose a body to the caller. GET responses preserve
  // the upstream ReadableStream directly; no arrayBuffer()/text() buffering.
  const body = requestMethod === 'HEAD' ? null : response.body;

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function serveFavicon(request, env, type, fetchImpl) {
  const targetUrl = new URL(FAVICON_URLS[type]);

  if (!env?.USER_TOKEN) {
    return jsonResponse(
      {
        error: 'Server Configuration Error',
        message: 'USER_TOKEN is not set in Worker secrets/environment.',
      },
      500,
    );
  }

  try {
    const response = await fetchWithScopedRedirects(
      new Request(request.url, { method: 'GET', headers: request.headers }),
      targetUrl,
      env,
      {
        authHost: targetUrl.hostname,
        tokenEnvName: 'USER_TOKEN',
        fetchImpl,
        maxRedirects: maxRedirectsFromEnv(env),
      },
    );

    if (!response.ok) {
      return jsonResponse(
        {
          error: 'Upstream Error',
          message: `Failed to fetch favicon: ${response.status} ${response.statusText}`,
        },
        response.status,
      );
    }

    const fallbackType = type === 'ico' ? 'image/x-icon' : 'image/png';
    return upstreamResponse(response, 'GET', {
      'Cache-Control': 'public, max-age=3600',
      ...(response.headers.has('content-type') ? {} : { 'Content-Type': fallbackType }),
    });
  } catch (error) {
    return jsonResponse(
      { error: 'Bad Gateway', message: `Failed to fetch favicon: ${error.message}` },
      502,
    );
  }
}

async function handleProxy(request, env, fetchImpl) {
  if (request.method === 'OPTIONS') {
    return handleCORS();
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse(
      { error: 'Method Not Allowed', message: 'Proxy supports GET, HEAD, and OPTIONS only.' },
      405,
      { Allow: 'GET, HEAD, OPTIONS' },
    );
  }

  const countryCheck = countryIsAllowed(request, env);
  if (!countryCheck.allowed) {
    return jsonResponse(
      {
        error: 'Access Forbidden',
        message: `Requests originating from country '${countryCheck.country}' are not allowed by this proxy server.`,
      },
      403,
    );
  }

  const requestUrl = new URL(request.url);
  if (!requestUrl.searchParams.has('url')) {
    return jsonResponse({
      message: '~~ Welcome ~~',
      proxy: 'huggingface-stream-proxy-worker',
      version: VERSION,
    });
  }

  let targetUrl;
  try {
    targetUrl = parseTargetUrl(requestUrl);
  } catch {
    return jsonResponse(
      { error: 'Bad Request', message: 'The provided URL is invalid or malformed.' },
      400,
    );
  }

  if (!targetUrl || !isAllowedProxyTarget(targetUrl, env)) {
    return jsonResponse(
      {
        error: 'Target Forbidden',
        message: 'The target host or protocol is not allowed by PROXY_ALLOWED_HOSTS.',
      },
      403,
    );
  }

  const useHfAuth = isHuggingFaceAuthHost(targetUrl);
  if (useHfAuth && !env?.HF_TOKEN) {
    return jsonResponse(
      {
        error: 'Server Configuration Error',
        message: 'HF_TOKEN is not set in Worker secrets/environment.',
      },
      500,
    );
  }

  try {
    const response = await fetchWithScopedRedirects(
      request,
      targetUrl,
      env,
      {
        authHost: useHfAuth ? HUGGINGFACE_AUTH_HOST : undefined,
        tokenEnvName: useHfAuth ? 'HF_TOKEN' : undefined,
        fetchImpl,
        maxRedirects: maxRedirectsFromEnv(env),
      },
    );

    return upstreamResponse(response, request.method);
  } catch (error) {
    return jsonResponse(
      {
        error: 'Bad Gateway',
        message: `Failed to fetch the target URL: ${error.message}`,
      },
      502,
    );
  }
}

async function handleAssetService(request, env) {
  if (!env?.ASSET_SERVICE || typeof env.ASSET_SERVICE.fetch !== 'function') {
    return jsonResponse(
      {
        error: 'Service Unavailable',
        message: 'ASSET_SERVICE is not configured for this Worker.',
      },
      503,
    );
  }

  try {
    return await env.ASSET_SERVICE.fetch(request);
  } catch {
    return jsonResponse(
      {
        error: 'Bad Gateway',
        message: 'The asset storage service is temporarily unavailable.',
      },
      502,
    );
  }
}

export function createWorker(fetchImpl = fetch) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);

      if (url.pathname.startsWith('/assets/')) {
        return handleAssetService(request, env);
      }

      if (url.pathname === '/favicon.ico') {
        return serveFavicon(request, env, 'ico', fetchImpl);
      }

      if (url.pathname === '/favicon.png') {
        return serveFavicon(request, env, 'png', fetchImpl);
      }

      return handleProxy(request, env, fetchImpl);
    },
  };
}

export default createWorker();
