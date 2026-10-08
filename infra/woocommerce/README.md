# Local WooCommerce

A reproducible WordPress + WooCommerce store for developing and testing the adapter and the plugin. Images and WooCommerce are pinned
(`wordpress:6.7-php8.3-apache`, `mariadb:11.4`, WooCommerce 9.9.5).

| Service | Address |
|---|---|
| Store + wp-admin | http://localhost:8085 (`admin` / `WP_ADMIN_PASSWORD` from `.env`) |
| REST API | http://localhost:8085/wp-json/wc/v3/ |
| phpMyAdmin (optional) | `docker compose --env-file .env --profile tools up -d phpmyadmin` → http://localhost:8086 |

## Start

```bash
cp .env.example .env      # review passwords and ports
./setup.sh                # idempotent: installs WordPress + WooCommerce, configures, seeds, creates REST keys
node verify.js            # prints system_status and the product list through the adapter's own client
```

`setup.sh` does, in order: starts the database and WordPress; installs WordPress; sets pretty permalinks (the REST API needs them);
installs and activates WooCommerce; sets currency, country, tax off, stock management on; creates a shipping zone with flat rate and free
shipping; enables cash on delivery and bank transfer; activates the Flipick plugin; seeds data; creates a Read/Write REST key into
`.env.local`; registers three paused test webhooks. Running it again only does what is missing.

Seed data: 5 simple products (one on sale, one out of stock with backorders, one without stock management), 2 variable products with 3
variations each (different prices, stock and one sale), categories, tags, 3 customers, and 7 orders (pending, processing, on-hold,
completed, cancelled, refunded, failed). Product images are generated locally, so no internet is needed for them.

## Connect it to the adapter

Start the adapter (`../../README.md`), then in wp-admin: WooCommerce → **Video Generator** → Adapter URL `http://host.docker.internal:4300`,
Browser URL `http://localhost:4300` → Connect. The plugin creates its own REST key, registers the store and creates signed webhooks.
Scripted:

```bash
docker compose --env-file .env run --rm -T wpcli wp eval \
  'var_dump(FVG_Connection::connect("http://host.docker.internal:4300", "http://localhost:4300"));' --user=admin
```

Webhook deliveries run through WooCommerce's Action Scheduler (WP-Cron, triggered by page loads). To flush them now:
`docker compose --env-file .env run --rm -T wpcli wp action-scheduler run --force`.

## Stop, reset

```bash
docker compose --env-file .env down          # stop, keep data
docker compose --env-file .env down -v       # stop and DELETE the store (database + WordPress files)
rm .env.local                                # then ./setup.sh creates fresh keys
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `rest_no_route` / 404 on `/wp-json/...` | Pretty permalinks off: `docker compose --env-file .env run --rm -T wpcli wp rewrite structure '/%postname%/' --hard` |
| 401 `woocommerce_rest_cannot_view` over http | WooCommerce accepts Basic / query keys only over HTTPS. Use OAuth 1.0a (the adapter does automatically for `http://`) |
| HTML instead of JSON | A security plugin or host rule is intercepting `/wp-json`; test `curl -I http://localhost:8085/wp-json/` |
| Webhooks never arrive | Run `wp action-scheduler run --force`; from inside Docker the adapter is `host.docker.internal:4300`, not `localhost`. Check WooCommerce → Status → Logs → `webhooks-delivery` |
| "A valid URL was not provided" on delivery | WordPress blocks private hosts and odd ports; the plugin allows the adapter host only when `WP_ENVIRONMENT_TYPE=local` (set by this compose file) |
| Port already in use | Change `WP_PORT` / `PMA_PORT` in `.env` and `WP_SITE_URL` to match, then `docker compose --env-file .env up -d` |
| Site URL changed | Update `WP_SITE_URL` in `.env`, run `./setup.sh` (it rewrites `home` / `siteurl`) |
| Plugin install says WordPress is too old | WooCommerce moves on; keep `WC_VERSION` pinned or raise the `wordpress` image tag |
| `docker compose` warns about unset variables | Always pass `--env-file .env` from this folder |

Never reuse these passwords or keys anywhere real. `.env` and `.env.local` are git-ignored.
