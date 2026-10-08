# WooCommerce adapter

Supported: WooCommerce 8.0+ on WordPress 6.2+, PHP 7.4+ (plugin) and Node 22+ (adapter). Developed and tested against WooCommerce 9.9.5 / WordPress 6.7.

## How it fits

The Shopify and Magento adapters do not share a code-level interface; each is a standalone service with a platform client. The
WooCommerce adapter follows the **Magento adapter** (multi-tenant, PostgreSQL with row-level security, signed requests from the
platform extension, launch-token sessions). Only these pieces are WooCommerce-specific:

| Concern | Shopify | Magento | WooCommerce |
|---|---|---|---|
| Platform client | `shopifyClient.js` (GraphQL) | `magentoClient.js` (REST, bearer) | `wooClient.js` (REST `wc/v3`) |
| Credential | expiring offline token | integration token | consumer key + secret (one encrypted string) |
| Product / variants | Product / Variant | simple / configurable child | `products` / `products/{id}/variations` |
| Category | product type | EAV attribute option | `categories[0]` |
| Sale price | compare-at price | `special_price` | `sale_price` |
| Where the video lives | product media | 2 custom attributes | 2 product meta keys: `_flipick_video_url`, `_flipick_video_thumb` |
| Platform extension | — | Flipick_VideoGenerator (PHP module) | Flipick Video Generator (WordPress plugin) |
| Stores per install | 1 shop | 1 per Magento website | 1 (multisite is not supported yet) |

## Authentication to WooCommerce (`WOO_AUTH_MODE`)

| Mode | Used when | Notes |
|---|---|---|
| `auto` (default) | always | `basic` for `https://` stores, `oauth` for `http://` |
| `basic` | production | HTTP Basic with the key pair. WooCommerce only honours it over HTTPS |
| `oauth` | plain-HTTP development stores | OAuth 1.0a one-legged, HMAC-SHA256, signed per request with a fresh nonce; the secret is never sent |
| `query` | hosts that strip the `Authorization` header | key and secret as query parameters (HTTPS only). The secret reaches server access logs; the adapter never logs query strings |

The REST key the plugin creates has **Read/Write** permission (it reads products and writes the video meta) and belongs to the admin
who clicked Connect. Revoke it under WooCommerce → Settings → Advanced → REST API, or by pressing Disconnect.

## Catalog sync

- `GET /products?status=publish&per_page=100&page=N`, following `X-WP-TotalPages`. `modified_after` is supported by the client for incremental sync.
- Only published, shop-visible `simple` and `variable` products with a price are listed (drafts, hidden, grouped and external products are skipped).
- A variable product costs one extra call (`/products/{id}/variations`), run five at a time. The **cheapest in-stock variation** supplies the price; if everything is out of stock, the cheapest overall.
- Names are HTML-decoded (`Dairy &amp; Eggs` → `Dairy & Eggs`).
- The list is cached per store in memory; the plugin's webhooks (`product.created/updated/deleted`) drop that cache.

## Publishing a video

`PUT /products/{id}` with `meta_data` for the two keys. WooCommerce merges by key, so nothing else on the product changes. A product holds
one video: publishing another type replaces it. The plugin renders `<video>` after the product summary and offers `[flipick_video id="123"]`.
`batchUpdateProducts()` (up to 100 per request) exists in the client for bulk publishing; the UI publishes one product at a time.

## Webhooks

The plugin registers three webhooks (`product.created`, `product.updated`, `product.deleted`) pointing at
`{adapter}/api/webhooks/woocommerce/{installKey}`, signed with the installation secret. The adapter:

1. verifies `X-WC-Webhook-Signature` (base64 HMAC-SHA256 of the raw body) with a constant-time compare, else `401`;
2. records `X-WC-Webhook-Delivery-ID` per installation (`webhook_deliveries`, kept 7 days) and answers `200 {duplicate:true}` to a redelivery without processing it again;
3. answers WooCommerce's unsigned registration ping (`webhook_id=N`) so the webhook is not marked failed;
4. returns `5xx` only for its own failures, so WooCommerce retries those.

## Errors and retries

| Situation | Behaviour |
|---|---|
| 429, 502, 503, 504 on a read | up to `WOO_MAX_RETRIES` (4) retries, honouring `Retry-After`, else 1 s, 2 s, 4 s… with jitter, capped at 30 s |
| Network error / timeout on a read | same retries; `WOO_TIMEOUT_MS` (20 s) per attempt |
| 429 on a write | retried; any other failure on a write is **not** (it may have run) |
| 401 / 403 | registration says the keys were rejected; publishing tells the merchant to reconnect |
| 404 | registration says to enable pretty permalinks; publishing says the product is gone |
| HTML instead of JSON | explained as permalinks off / REST blocked |

Every error is a `WooApiError` (`status`, `wooCode`, `retriable`). Logs never contain keys, secrets, tokens or query strings.

## Logging

Adapter: `LOG_LEVEL` (debug/info/warn/error), `LOG_FORMAT=json` for log shippers; each request logs one line with a request id (also sent back as `X-Request-Id`); secrets are redacted.
Plugin: `wp-content/uploads/flipick-video-generator-logs/`, listed under WooCommerce → Video Generator → Logs.

Rotation (adapter and plugin alike): every day at **00:05:00** and **at once when a file passes 10 MB**, the file is zipped and a new one is started. Adapter files: `logs/app.log` and `logs/error.log`, settings `LOG_MAX_BYTES`, `LOG_ROTATE_AT`, `LOG_RETENTION_DAYS`.

## Known gaps versus Shopify / Magento

- No WordPress **multisite** (one WooCommerce site = one store).
- Orders, customers, coupons, inventory and refunds are not read: the video product does not need them. The seeded store contains them for realism.
- Multi-currency plugins: prices are read in the store's base currency (`system_status.settings.currency`); a plugin that rewrites prices on the front end is not reflected.
- HPOS (custom order tables) only affects orders, which the adapter never touches; the plugin declares itself compatible.
- A product's video is one URL: no per-variation videos.
- The grid column in the product list shows "Published" from the product meta, not live render status (that is in the adapter UI).
- Product-updated webhooks refresh the catalog cache; they do not mark a published video stale (WooCommerce edits to price or images do not invalidate a rendered video).

## Performance and rate limits

WooCommerce has no fixed rate limit; shared hosts throttle. The client reads 100 products per request and runs five variation fetches at once.
A 1,000-product catalog with 200 variable products is about 10 + 200 requests on refresh. The refresh endpoint is limited to 6 per minute per store.
