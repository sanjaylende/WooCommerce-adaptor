// Talks to the WooCommerce REST API (`{baseUrl}/wp-json/wc/v3/...`) with a consumer key + secret.
//
// Credentials travel through the adapter as ONE opaque string, "consumerKey:consumerSecret" (stored AES-256-GCM encrypted).
// Auth mode (WOO_AUTH_MODE):
//   basic  HTTP Basic with the key pair. WooCommerce only accepts it over HTTPS.
//   oauth  OAuth 1.0a one-legged (HMAC-SHA256), signed per request. WooCommerce's documented method for plain-HTTP stores,
//          so the secret never travels. Used automatically for http:// URLs.
//   query  consumer_key / consumer_secret as query parameters. HTTPS only, and the secret lands in access logs:
//          a last resort for hosts that strip the Authorization header.
//   auto   basic for https, oauth for http (default)
//
// Every failure is thrown as a WooApiError (status, wooCode, retriable) so callers can map it to a user message.
const crypto = require("crypto");
const config = require("../config");
const logger = require("../utils/logger");

const API_PREFIX = "/wp-json/wc/v3";
const PER_PAGE = 100; // WooCommerce's hard maximum
const MAX_PAGES = 500; // runaway guard: 50,000 products
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

class WooApiError extends Error {
  constructor(message, { status = 0, wooCode = null, retriable = false, cause } = {}) {
    super(message);
    this.name = "WooApiError";
    this.status = status;
    this.wooCode = wooCode;
    this.retriable = retriable;
    if (cause) this.cause = cause;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseCredentials(credentials) {
  const raw = String(credentials || "");
  const i = raw.indexOf(":");
  if (i < 1 || i === raw.length - 1) throw new WooApiError("WooCommerce credentials are missing or malformed", { status: 400 });
  return { key: raw.slice(0, i), secret: raw.slice(i + 1) };
}

function resolveAuthMode(url) {
  const mode = String(config.woo.authMode || "auto").toLowerCase();
  if (mode === "basic" || mode === "query" || mode === "oauth") return mode;
  return String(url).startsWith("https:") ? "basic" : "oauth";
}

// Backoff: honour Retry-After when WooCommerce or a proxy sends it, else 1s, 2s, 4s... capped at 30s, with jitter.
function backoffMs(attempt, retryAfterHeader) {
  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 60) * 1000;
  return Math.min(2 ** attempt * 1000, 30000) * (0.75 + Math.random() * 0.5);
}

const rfc3986 = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// OAuth 1.0a one-legged signature (what WooCommerce verifies for http:// stores). Adds the oauth_* parameters to `url`.
// The JSON body is not part of the signature (only form bodies are), exactly as WooCommerce expects.
function signOAuth(url, method, { key, secret }, nonce = crypto.randomBytes(12).toString("hex"), timestamp = Math.floor(Date.now() / 1000)) {
  const params = new Map([...url.searchParams.entries()]);
  params.set("oauth_consumer_key", key);
  params.set("oauth_nonce", nonce);
  params.set("oauth_signature_method", "HMAC-SHA256");
  params.set("oauth_timestamp", String(timestamp));
  const normalized = [...params.entries()].map(([k, v]) => [rfc3986(k), rfc3986(v)]).sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join("&");
  const base = [method.toUpperCase(), rfc3986(`${url.origin}${url.pathname}`), rfc3986(normalized)].join("&");
  params.set("oauth_signature", crypto.createHmac("sha256", `${rfc3986(secret)}&`).update(base).digest("base64"));
  for (const [k, v] of params) if (k.startsWith("oauth_")) url.searchParams.set(k, v);
  return url;
}

// The one place a request leaves the process. Returns { data, headers, status }.
async function wooRequestRaw(url, credentials, options = {}) {
  const {
    method = "GET", body, maxRetries = config.woo.maxRetries, timeoutMs = config.woo.timeoutMs, fetchImpl = fetch, sleepImpl = sleep,
  } = options;
  const { key, secret } = parseCredentials(credentials);
  const mode = resolveAuthMode(url);
  const baseHeaders = { Accept: "application/json", "User-Agent": "Flipick-WooCommerce-Adapter/1.0" };
  if (body !== undefined) baseHeaders["Content-Type"] = "application/json";
  const parsed = new URL(url);
  const safeUrl = `${parsed.origin}${parsed.pathname}`; // never log the query string: it may carry credentials

  // A write is only retried on 429 (rejected before it ran); reads also retry network failures and 502/503/504.
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    // Built per attempt: an OAuth nonce must never be reused, so a retry is signed afresh.
    const target = new URL(url);
    const headers = { ...baseHeaders };
    if (mode === "basic") headers.Authorization = `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;
    else if (mode === "oauth") signOAuth(target, method, { key, secret });
    else { target.searchParams.set("consumer_key", key); target.searchParams.set("consumer_secret", secret); }
    let res;
    try {
      res = await fetchImpl(target, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
      const retry = method === "GET" && attempt < maxRetries;
      logger.warn(`WooCommerce ${method} ${safeUrl} ${timedOut ? "timed out" : "network error"}`, { attempt, willRetry: retry, error: err.message });
      if (retry) { await sleepImpl(backoffMs(attempt)); continue; }
      throw new WooApiError(`WooCommerce API request failed (${timedOut ? "timeout" : "network error"}): ${err.cause?.message || err.message}`, { retriable: true, cause: err });
    }

    const elapsed = Date.now() - startedAt;
    const retryable = RETRY_STATUSES.has(res.status) && (res.status === 429 || method === "GET");
    if (retryable && attempt < maxRetries) {
      const wait = backoffMs(attempt, res.headers.get("retry-after"));
      logger.warn(`WooCommerce ${method} ${safeUrl} -> ${res.status}, retrying`, { attempt: attempt + 1, waitMs: Math.round(wait), elapsedMs: elapsed });
      await res.arrayBuffer().catch(() => {});
      await sleepImpl(wait);
      continue;
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const message = errBody.message || res.statusText || "request failed";
      logger.error(`WooCommerce ${method} ${safeUrl} -> ${res.status}`, { wooCode: errBody.code, message, elapsedMs: elapsed });
      throw new WooApiError(`WooCommerce API request failed (${res.status}): ${message}`, { status: res.status, wooCode: errBody.code || null, retriable: RETRY_STATUSES.has(res.status) });
    }

    logger.debug(`WooCommerce ${method} ${safeUrl} -> ${res.status}`, { elapsedMs: elapsed, attempt });
    const text = res.status === 204 ? "" : await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        // A 200 with HTML usually means pretty permalinks are off or a security plugin is intercepting /wp-json.
        throw new WooApiError("WooCommerce returned a non-JSON response. Check that pretty permalinks are enabled and the REST API is reachable.", { status: res.status, cause: err });
      }
    }
    return { data, headers: res.headers, status: res.status };
  }
}

// Convenience: the JSON body only.
async function wooRequest(url, credentials, options) {
  return (await wooRequestRaw(url, credentials, options)).data;
}

const apiUrl = (baseUrl, path, params = {}) => {
  const url = new URL(`${baseUrl}${API_PREFIX}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  return url.toString();
};

// Page-number pagination. Reads X-WP-TotalPages so it stops exactly at the end. `modified_after` (ISO 8601) makes it an
// incremental sync.
async function fetchAllPages(baseUrl, credentials, path, params, options = {}) {
  const items = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    if (page > MAX_PAGES) { logger.warn(`WooCommerce ${path}: stopped at ${MAX_PAGES} pages`); break; }
    const { data, headers } = await wooRequestRaw(apiUrl(baseUrl, path, { ...params, per_page: PER_PAGE, page }), credentials, options);
    const list = Array.isArray(data) ? data : [];
    items.push(...list);
    totalPages = Number(headers.get("x-wp-totalpages")) || (list.length === PER_PAGE ? page + 1 : page);
  }
  return items;
}

// Published products only: drafts, private and trashed products can never show a video on the storefront.
async function fetchAllProducts(baseUrl, credentials, options = {}) {
  const items = await fetchAllPages(baseUrl, credentials, "/products", { status: "publish", orderby: "date", order: "desc", modified_after: options.modifiedAfter }, options);
  logger.info("Fetched WooCommerce products", { count: items.length, baseUrl });
  return items;
}

// A variable product keeps its price in its variations: a separate call, only made for type === "variable".
async function fetchVariations(baseUrl, credentials, productId, options = {}) {
  return fetchAllPages(baseUrl, credentials, `/products/${encodeURIComponent(productId)}/variations`, { status: "publish" }, options);
}

async function fetchProductById(baseUrl, credentials, productId, options = {}) {
  return wooRequest(apiUrl(baseUrl, `/products/${encodeURIComponent(productId)}`), credentials, options);
}

// Writes product meta_data. WooCommerce merges by key and leaves every other field untouched.
async function updateProductMeta(baseUrl, credentials, productId, meta, options = {}) {
  const meta_data = Object.entries(meta).map(([key, value]) => ({ key, value: value ?? "" }));
  return wooRequest(apiUrl(baseUrl, `/products/${encodeURIComponent(productId)}`), credentials, { ...options, method: "PUT", body: { meta_data } });
}

// Many writes in one request (WooCommerce accepts up to 100 per call).
async function batchUpdateProducts(baseUrl, credentials, updates, options = {}) {
  const results = [];
  for (let i = 0; i < updates.length; i += PER_PAGE) {
    const out = await wooRequest(apiUrl(baseUrl, "/products/batch"), credentials, { ...options, method: "POST", body: { update: updates.slice(i, i + PER_PAGE) } });
    results.push(...((out && out.update) || []));
  }
  return results;
}

// Proves the key pair works and returns what registration needs: versions and the store currency.
async function fetchStoreInfo(baseUrl, credentials, options = {}) {
  const status = (await wooRequest(apiUrl(baseUrl, "/system_status"), credentials, options)) || {};
  const env = status.environment || {};
  const settings = status.settings || {};
  return {
    wooVersion: env.version || null,
    wpVersion: env.wp_version || null,
    siteUrl: env.site_url || baseUrl,
    currency: settings.currency || "USD",
  };
}

module.exports = {
  WooApiError, wooRequest, wooRequestRaw, apiUrl, parseCredentials, resolveAuthMode, signOAuth,
  fetchAllProducts, fetchVariations, fetchProductById, updateProductMeta, batchUpdateProducts, fetchStoreInfo,
};
