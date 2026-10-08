# End-to-end check of the install guide

Drives a **fresh** store exactly like a browser (log in, Connect form, Refresh, Billing, generator launch, render, Add to product page,
visitor view of the product page) and fails on the first problem.

```bash
cd infra/woocommerce            # store running, plugin installed from the zip, adapter + video engine running
WP_URL=http://localhost:8085 node e2e/exercise.js       # full run, renders one video (~3 min, uses one free video)
SKIP_GENERATE=1 node e2e/exercise.js                    # everything except the render
node e2e/negative.js                                     # wrong adapter URL, forged/anonymous requests, no leftover keys or webhooks
```

Defaults: `WP_URL=http://localhost:8087`, `WP_USER=admin`, `WP_PASS=change-me-admin`, `ADAPTER_URL=http://localhost:4300`,
`ADAPTER_SERVER_URL=http://host.docker.internal:4300`. `negative.js` disconnects the store; run `exercise.js` again to reconnect.
Run both from the folder that holds the store's `docker-compose.yml` and `.env`.
