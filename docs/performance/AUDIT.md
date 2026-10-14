# Performance audit: WooCommerce adapter

Phase 1 of the performance work (2026-10-13). Method: read the code paths of the main requests, turned on `pg_stat_statements` and per-request statement counting, CPU-profiled the status route, measured WordPress/Magento page costs with the component on and off. Findings are ranked by measured impact. Only findings with a measured cost were changed; each change is one commit `perf(<ID>): ...` on the branch `perf-optimization` (tag `pre-perf` marks the start). Items that are not performance changes are listed at the end and reported, not fixed.

### O1  (fixed)

- **Where:** src/services/videoUrlService.js, called by the product list and bootstrap routes
- **What:** Every request for the product list or bootstrap asked the video engine's signing logic for new links for EVERY ready video and wrote them back to the database (one UPDATE of the same row per video per request), although a link stays valid for days.
- **Evidence:** bootstrap 31 database statements per request and 22 requests per second; products 25 statements and 25 requests per second (10 workers, 3 videos)
- **Decision:** FIXED (O1): only links that are about to expire are re-signed, and only changed values are written
- **Risk:** low: the links handed to the browser are the same; a test covers "expiring link is refreshed, fresh link is not rewritten"

### P2  (fixed)

- **Where:** includes/class-fvg-admin.php, includes/class-fvg-adapter-client.php
- **What:** The admin product list asked the adapter for video states with the general 20 s timeout and asked again on every page load when it failed, so a hung adapter made every product list page take 20 s.
- **Evidence:** adapter hangs: first list 20.9 s -> 4.1 s, following loads 21.0 s -> 1.4 s (failure remembered for a minute)
- **Decision:** FIXED (P2): 3 s timeout for this call, failure remembered for 60 s; all other calls keep their timeouts
- **Risk:** low: signed request unchanged

### O2  (fixed)

- **Where:** src/db/connection.js (tenant context for row-level security)
- **What:** Every database statement was preceded by a second statement that set the tenant context on the pooled connection, even when the connection already carried that context.
- **Evidence:** status route 10 statements per request; 232 -> 306 requests per second at 50 connections after the change
- **Decision:** FIXED (O2): a connection that already carries the context is not told again; the context is still re-set on every connection that carries another tenant, so isolation is unchanged
- **Risk:** medium: touches isolation code, therefore six new tests (different tenant, system mode, error paths, released connection) and the full security journey were run

### P4  (fixed)

- **Where:** flipick-video-generator.php (HPOS compatibility declaration)
- **What:** The declaration of compatibility with WooCommerce's custom order tables was made on every request, with its feature-registry lookups, although only the WooCommerce admin reads it.
- **Evidence:** before_woocommerce_init 17.0 ms; front-end init +15 ms
- **Decision:** FIXED (P4): declared only in admin and WP-CLI requests (0.9 ms; +5 ms on the front end)
- **Risk:** low: WooCommerce reads the declaration only in the admin and when listing plugins

### O6  (fixed)

- **Where:** src/db/connection.js
- **What:** Found while testing O2: statements started together inside one transaction overlapped on the single connection (pg warns, order is not guaranteed).
- **Evidence:** 40 end-to-end tests failed after the first version of O2 (a property name collided with the driver's own queue); fixed and re-run: 195 (Magento) and 231 (WooCommerce) tests pass
- **Decision:** FIXED (O6): such statements are queued on the connection in the order issued
- **Risk:** low

### P1  (fixed)

- **Where:** flipick-video-generator.php
- **What:** The plugin loaded all of its class files and registered admin and storefront hooks on every request, including storefront requests that never use them.
- **Evidence:** plugin load 6.5 ms per request, 9 files; after: 3.1 ms, only what is needed
- **Decision:** FIXED (P1): autoloader; hooks registered only where used
- **Risk:** low: lazy-load test asserts what is (not) loaded on front-end and admin requests

### O3  (fixed)

- **Where:** src/middleware/rateLimit.js
- **What:** The Postgres-backed rate limiter ran two UPSERT statements for each request (one per bucket check).
- **Evidence:** status route 6.3 -> 4.6 statements per request, 306 -> 389 requests per second at 50 connections
- **Decision:** FIXED (O3): one statement; limits, window and response headers are unchanged
- **Risk:** low: limit values untouched, tests for the combined limiter added

### P3  (fixed)

- **Where:** includes/class-fvg-storefront.php
- **What:** Rendering the video on a product page validated the video address with wp_http_validate_url(), which does a DNS lookup on every page view.
- **Evidence:** 5.5-6 ms per product-page view
- **Decision:** FIXED (P3): plain scheme and syntax check (the address comes from the adapter and is only echoed into a video tag as an escaped URL); 0.02 ms
- **Risk:** low: still only http and https addresses are accepted

### O5  (fixed)

- **Where:** src/services/tenantService.js
- **What:** Every installation lookup decrypted its stored secrets (AES key set-up) even when the request never used them.
- **Evidence:** CPU profile: key set-up 11.9 % of CPU on the status route; 312 -> 346 requests per second in an A/B run
- **Decision:** FIXED (O5): secrets are decrypted when first used (lazy getter); never logged
- **Risk:** low: a test checks that the values are identical and that they are decrypted only on use

### O7  (fixed)

- **Where:** src/middleware/tenantAuth.js
- **What:** A browser session needed two sequential lookups (installation, then store).
- **Evidence:** status route 347 -> 374 requests per second (mean of five alternating runs); one round trip fewer per request
- **Decision:** FIXED (O7): one statement that returns both
- **Risk:** low

### O4  (tried, reverted)

- **Where:** src/utils/crypto.js
- **What:** The secret key was parsed for every HMAC (about 100 microseconds each).
- **Evidence:** measured: no change outside the noise (status 387 vs 389 requests per second at 50 connections)
- **Decision:** TRIED AND REVERTED (no measurable gain, as the rules require)
- **Risk:** none: not in the branch

### F-USAGE-RACE  (not fixed, reported)

- **Where:** src/services/generationService.js, src/services/billingService.js (recordVideoCompleted)
- **What:** A video is shown as ready first and counted against the plan a moment later. A generation request made in that moment is still judged against the old count, so on a loaded machine a sixth Free video was accepted once.
- **Evidence:** full run under load: 6 videos allowed on Free (once); 3 of 3 later runs on a quiet machine allowed exactly 5; the code order is unchanged by the performance work
- **Decision:** NOT FIXED: billing behaviour (count before the ready status is published, or check the limit with in-flight videos); needs a decision
- **Risk:** medium: could let a merchant exceed the Free allowance by one by clicking twice quickly

### F-FRAME  (not fixed, reported)

- **Where:** src/middleware (frameAncestors cache)
- **What:** The adapter remembers the list of store addresses allowed to show its app in a frame for 60 s. A store connected less than a minute ago can show a blocked frame ("refused to connect") until the cache expires.
- **Evidence:** seen on both platforms when a new store connects; the store scripts wait 65 s
- **Decision:** NOT FIXED: behaviour change outside the performance task (cache invalidation on register); needs a decision
- **Risk:** low impact (first minute only)

### F-RATIO  (not fixed, reported)

- **Where:** src/integrations/videoEngineClient.js (generateHeroProductVideo, generateImageTransitionVideo: aspect_ratio)
- **What:** Asking for 5:4 sends 16:9 to the engine (only 9:16, 16:9 and 1:1 are passed on), so the video comes out 16:9. The merchant app offers 5:4.
- **Evidence:** case T5: engine asked for 16:9, video is 16:9, both video types, both adapters
- **Decision:** NOT FIXED: merchant-visible behaviour; confirm with the engine team whether 5:4 is supported for generation
- **Risk:** n/a

### FND-UI-1  (not fixed, reported)

- **Where:** public/css and public/js/app.js
- **What:** On a 390 px phone the product list (filter row, table, search echo) is wider than the screen; a 300-character search term makes the page about 1300 px wide.
- **Evidence:** case T11 on Chrome and Firefox, both adapters, and on the build before the performance work
- **Decision:** NOT FIXED: design change outside the performance task
- **Risk:** n/a

### F-PROGRESS  (not fixed, reported)

- **Where:** status route
- **What:** A ready video can report progressPct 90 (seen with the mock engine, whose progress caps at 90).
- **Evidence:** status JSON of a ready video in the exploration run
- **Decision:** NOT FIXED: cosmetic; check against the real engine before touching
- **Risk:** n/a
