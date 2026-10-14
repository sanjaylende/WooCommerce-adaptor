# Performance baseline: WooCommerce adapter

Measured on 2026-10-13 on one Windows 11 development PC (Docker Desktop, PostgreSQL 16 in a container on the same machine, Node 24, adapter and load generator on the same CPU).
**Baseline build** = git tag `pre-perf` plus commit "perf(T0)" (it only adds the test hook `RATE_LIMIT_SCALE`). Everything is measured again after the optimisations; the optimised numbers and the commits are in `PERF-REPORT.md`.

The numbers come from the `perf` case of the regression suite (`npm run regression -- perf` with `PERF_RECORD=1`): the adapter runs in development mode with the rate limits scaled up (test-only `RATE_LIMIT_SCALE`, ignored in production), one store with a ready video on each of its three products, 10 concurrent workers, 6 seconds per route, best of 2 rounds, p95 in milliseconds. The route `GET /` (the app shell) is a **control**: no code on its path was changed, so it shows how much run-to-run noise to expect (about 5 %).

## Latency of the main routes before the optimisations

| route | requests per second | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| GET /api/bootstrap | 28.3 | 361.6 | 446.7 | 456.9 |
| GET /api/products | 31.7 | 332 | 477.2 | 492.5 |
| GET /api/billing/status | 158.2 | 61.5 | 84.8 | 99.4 |
| GET /api/billing/history | 164.2 | 59.9 | 77.5 | 86 |
| GET /api/status/:tag/:type | 211.7 | 46.2 | 61.3 | 69.8 |
| GET /api/overlay-families | 182.5 | 53.8 | 68.4 | 81.9 |
| GET / (page) | 1188.3 | 8.6 | 10.7 | 14.6 |

## Database statements per request before and after (sequential requests, deterministic, not affected by machine noise)

| route | before | after |
|---|---|---|
| GET /api/bootstrap | 29.6 | 10 |
| GET /api/products | 26.2 | 5 |
| GET /api/billing/status | 21.2 | 9.8 |
| GET /api/billing/history | 16 | 9 |
| GET /api/status/:tag/:type | 10 | 5 |
| GET /api/overlay-families | 10 | 5 |

## Process start

```
before: magento fresh start (with migrations): STARTUP_MS 747
        woo fresh start (with migrations): STARTUP_MS 743
        magento warm start: STARTUP_MS 563
        woo warm start: STARTUP_MS 567
after:  magento fresh start (with migrations): STARTUP_MS 736
        woo fresh start (with migrations): STARTUP_MS 757
        magento warm start: STARTUP_MS 418
        woo warm start: STARTUP_MS 418
```
(milliseconds from process start to listening; "fresh" runs the database migrations.)

## Video generation (mock engine that takes 12 s to render, 3 runs)

The adapter accepts a generation request in 125 ms on average and the status reaches "ready" 501 ms after the engine finished (the measuring script asks 4 times a second). This path is dominated by the engine and was not changed.

## Soak (30 minutes), optimised build
WooCommerce adapter: 319,683 requests, 0 errors, 0 non-2xx, heap growth 8.8 %, resident memory growth 1.1 %, throughput trend -7 %. No 30-minute soak was run on the baseline build (the baseline was only needed for latency); the soak is a limit check (growth below 15 %, zero errors), not a comparison.
