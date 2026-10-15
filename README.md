# WooCommerce → Flipick adapter

One central, multi-tenant service for many WooCommerce stores. Merchants install the **Flipick Video Generator** WordPress
plugin; every store talks to this service, which holds the video logic, plans, usage, payments, refunds and invoices. Built
on the same architecture as the Magento adapter (`../magento-adaptor`); only the platform-facing parts differ.

```
WordPress admin (plugin)  --signed HTTPS-->  this adapter  --> Flipick video engine (LTX)
        |  iframe: one-time launch token       |   PostgreSQL (EAV + billing tables)
        '--------------------------------------'   --> payment gateway (ICICI)
WooCommerce  <-- REST wc/v3 (consumer key/secret) --'   --> staff console at /admin
WooCommerce  --- signed product webhooks ---------->     (catalog cache invalidation)
```

Feature notes, auth modes and known gaps: [docs/adapters/woocommerce.md](docs/adapters/woocommerce.md).

## Run locally

```bash
# 1. adapter database: its own schema "woocommerce_adapter" in the shared PostgreSQL database ltx_1jnl (127.0.0.1:5432),
#    created once by a database administrator (see "Database" below)
DATABASE_SUPERUSER_URL=postgresql://<admin>@127.0.0.1:5432/ltx_1jnl node scripts/db/provision.js

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

## Logs

Written to the console and to `logs/app.log` (everything) and `logs/error.log` (warnings and errors). **Rotation:** every day at
**00:05:00** (server local time) and **at once whenever a file passes 10 MB**, the file is zipped (`app-2026-10-08.zip`, or
`app-2026-10-08-153012.zip` for a size rotation) and a new file is started. The rename is atomic, so no line is lost or split; if the
process was down at 00:05 the old file is rotated at the next start. Settings: `LOG_TO_FILE`, `LOG_DIR`, `LOG_MAX_BYTES`, `LOG_ROTATE_AT`,
`LOG_RETENTION_DAYS` (0 = keep all archives), `LOG_LEVEL`, `LOG_FORMAT`. Secrets are redacted.

## Database

The adapter keeps its data in its **own schema** (`DB_SCHEMA`, default `woocommerce_adapter`) of the PostgreSQL database `ltx_1jnl`,
next to `shopify_adapter` and the other applications' schemas, which it never reads or changes. Every connection is opened with
`search_path` set to that schema, so nothing can fall back to `public`; the migration history (`schema_migrations`) is inside the schema.

- `scripts/db/provision.js`: run once by a database administrator (`DATABASE_SUPERUSER_URL`, never stored in `.env`). Creates the schema and two
  dedicated least-privilege roles (owner for migrations, service role for the app; no superuser, no BYPASSRLS, no access to other schemas). Idempotent.
- `scripts/db/migrate.js`: applies pending migrations (the service also does so at start-up).
- `scripts/db/move-data.js`: one-off, repeatable move from the old database (`SOURCE_DATABASE_URL`, read only): copies every table in one
  snapshot with primary keys and sequences preserved, refuses a non-empty target, then prints row counts and md5 checksums per table.
  `--verify-only` just compares. Stop the adapter while it runs.
- `DB_POOL_MAX` (default 8) keeps the service's share of the shared server's connections small. `DB_SSL=require` for any non-local server.
- Rollback: set `DATABASE_URL` / `DATABASE_ADMIN_URL` back to the old database (`docker compose up -d db`, port 5435) and `DB_SCHEMA=public`.

## Deploying

Needs a public HTTPS address (`PUBLIC_BASE_URL`), managed PostgreSQL (create the schema and roles with `scripts/db/provision.js`, set `DB_SSL=require`), `ADAPTER_SECRET_KEY` and the other secrets from the environment, and `NODE_ENV=production`
(which also blocks private-network store URLs at registration). It scales out: sessions, rate limits, nonces, idempotency keys and
webhook de-duplication all live in PostgreSQL, not process memory; the only per-process state is the product-list cache, rebuilt on
demand. Back up the database; the secret key is needed to read stored credentials.
