# WooCommerce → Flipick adapter

One central, multi-tenant service for many WooCommerce stores. Merchants install the **Flipick Video Generator** WordPress
plugin; every store talks to this service, which holds the video logic, plans, usage, payments, refunds and invoices. Built
on the same architecture as the Magento adapter (`../magento-adaptor`); only the platform-facing parts differ.

```
WordPress admin (plugin)  --signed HTTPS-->  this adapter  --> Flipick video engine (LTX)
        |  iframe: one-time launch token       |   PostgreSQL (EAV + billing tables)
        '--------------------------------------'   --> payment gateway (ICICI / mock)
WooCommerce  <-- REST wc/v3 (consumer key/secret) --'   --> staff console at /admin
WooCommerce  --- signed product webhooks ---------->     (catalog cache invalidation)
```

Feature notes, auth modes and known gaps: [docs/adapters/woocommerce.md](docs/adapters/woocommerce.md).

## Run locally

```bash
# 1. adapter database (PostgreSQL on 127.0.0.1:5435)
docker compose up -d db

# 2. a WooCommerce store to test against (WordPress on http://localhost:8085), seeded, with API keys
cd infra/woocommerce && cp .env.example .env && ./setup.sh && node verify.js && cd ../..

# 3. the adapter itself (http://localhost:4300)
cp .env.example .env     # set ADAPTER_SECRET_KEY (64 hex chars), ADMIN_BOOTSTRAP_EMAIL / _PASSWORD, video engine keys
npm install
npm start                # migrations run automatically
```

Connect the store: wp-admin (`admin` / password from `infra/woocommerce/.env`) → WooCommerce → **Video Generator** →
Adapter URL `http://host.docker.internal:4300`, Browser URL `http://localhost:4300` → **Connect store**
(a scripted version is in [infra/woocommerce/README.md](infra/woocommerce/README.md)). Staff console: `http://localhost:4300/admin`.

## Tests

```bash
docker compose up -d db
npm test      # unit + end-to-end (real PostgreSQL, fake WooCommerce); creates and drops woocommerce_adapter_test
```

| Suite | What it covers |
|---|---|
| `test/wooClient.test.js` | auth modes (Basic, OAuth 1.0a, query), pagination, retry/backoff, error mapping, normaliser, variation choice, webhook signature |
| `test/platform.e2e.test.js` | registration, signed requests, sessions, tenant isolation (row-level security), plans/payments/metering, webhooks (signature, replay, idempotency), publishing, staff console |
| `test/billingRules.test.js`, `test/icici.test.js` | billing rules and the ICICI gateway, unchanged from the Magento adapter |

The live store (Docker) is exercised by `node infra/woocommerce/verify.js`, which uses the adapter's own client; it is not part of `npm test`
so the suite needs only PostgreSQL.

## Layout

```
server.js, src/app.js        entry and assembly
src/routes, controllers      HTTP
src/integrations/wooClient   WooCommerce REST client: auth, paging, retry, error mapping
src/services                 catalog, publish (product meta), registration, billing, payments, scheduler
src/utils/normalize.js       WooCommerce product -> catalog row (pure)
src/middleware               tenant auth, rate limit, idempotency, request log, error handler
migrations/                  SQL, applied in order and checksummed
wordpress-plugin/            the WooCommerce counterpart of the Magento extension
infra/woocommerce/           Docker WooCommerce for development and tests
```

## Configuration

See `.env.example`. WooCommerce-specific: `WOO_AUTH_MODE` (auto | basic | oauth | query), `WOO_TIMEOUT_MS`, `WOO_MAX_RETRIES`.
Logging: `LOG_LEVEL`, `LOG_FORMAT=json` for production. Store credentials are **not** configured here: each plugin registers its own.

## Deploying

Needs a public HTTPS address (`PUBLIC_BASE_URL`), managed PostgreSQL (create the `adapter_app` role as in
`docker/db-init/01-app-role.sql`), `ADAPTER_SECRET_KEY` and the other secrets from the environment, and `NODE_ENV=production`
(which also blocks private-network store URLs at registration). It scales out: sessions, rate limits, nonces, idempotency keys and
webhook de-duplication all live in PostgreSQL, not process memory; the only per-process state is the product-list cache, rebuilt on
demand. Back up the database; the secret key is needed to read stored credentials.
