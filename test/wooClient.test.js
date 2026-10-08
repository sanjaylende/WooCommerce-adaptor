// Unit tests for the WooCommerce REST client, normaliser and webhook signature: no network, no database.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const client = require("../src/integrations/wooClient");
const { normalizeProduct, normalizeProducts } = require("../src/utils/normalize");
const { pickVariation } = require("../src/services/catalogService");
const { signBody, verifyWebhookSignature } = require("../src/utils/wooWebhook");

const CREDS = "ck_abc:cs_def";
const noSleep = async () => {};
const respond = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status, statusText: "x",
  headers: new Headers(headers),
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  arrayBuffer: async () => new ArrayBuffer(0),
});
const sequence = (...responses) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
};

test("https stores authenticate with HTTP Basic, http stores with a signed OAuth 1.0a request", async () => {
  const https = sequence(respond(200, []));
  await client.wooRequest("https://shop.test/wp-json/wc/v3/products", CREDS, { fetchImpl: https.fetchImpl });
  assert.equal(https.calls[0].init.headers.Authorization, `Basic ${Buffer.from(CREDS).toString("base64")}`);
  assert.ok(!https.calls[0].url.includes("consumer_key"));

  const http = sequence(respond(200, []));
  await client.wooRequest("http://shop.test/wp-json/wc/v3/products", CREDS, { fetchImpl: http.fetchImpl });
  assert.equal(http.calls[0].init.headers.Authorization, undefined);
  assert.match(http.calls[0].url, /oauth_consumer_key=ck_abc/);
  assert.match(http.calls[0].url, /oauth_signature_method=HMAC-SHA256/);
  assert.ok(!http.calls[0].url.includes("cs_def"), "the secret itself is never sent");
});

test("every retry is signed with a fresh OAuth nonce", async () => {
  const s = sequence(respond(503, {}), respond(200, []));
  await client.wooRequest("http://shop.test/wp-json/wc/v3/products", CREDS, { fetchImpl: s.fetchImpl, sleepImpl: noSleep });
  const nonce = (u) => new URL(u).searchParams.get("oauth_nonce");
  assert.notEqual(nonce(s.calls[0].url), nonce(s.calls[1].url));
});

test("OAuth signature matches the WooCommerce reference algorithm (known vector)", () => {
  const url = client.signOAuth(new URL("http://shop.test/wp-json/wc/v3/products?per_page=100&page=2"), "GET", { key: "ck", secret: "cs" }, "abc123", 1700000000);
  const base = "GET&http%3A%2F%2Fshop.test%2Fwp-json%2Fwc%2Fv3%2Fproducts&" + encodeURIComponent("oauth_consumer_key=ck&oauth_nonce=abc123&oauth_signature_method=HMAC-SHA256&oauth_timestamp=1700000000&page=2&per_page=100");
  const expected = crypto.createHmac("sha256", "cs&").update(base).digest("base64");
  assert.equal(url.searchParams.get("oauth_signature"), expected);
});

test("explicit query mode sends the key pair as query parameters", async () => {
  const config = require("../src/config");
  config.woo.authMode = "query";
  try {
    const s = sequence(respond(200, []));
    await client.wooRequest("https://shop.test/x", CREDS, { fetchImpl: s.fetchImpl });
    assert.match(s.calls[0].url, /consumer_key=ck_abc&consumer_secret=cs_def/);
  } finally { config.woo.authMode = "auto"; }
});

test("malformed credentials fail before any request is made", async () => {
  const s = sequence(respond(200, []));
  await assert.rejects(() => client.wooRequest("https://shop.test/x", "nocolon", { fetchImpl: s.fetchImpl }), /malformed/);
  assert.equal(s.calls.length, 0);
});

test("pagination follows X-WP-TotalPages and stops there", async () => {
  const s = sequence(
    respond(200, [{ id: 1 }, { id: 2 }], { "x-wp-totalpages": "2" }),
    respond(200, [{ id: 3 }], { "x-wp-totalpages": "2" })
  );
  const items = await client.fetchAllProducts("https://shop.test", CREDS, { fetchImpl: s.fetchImpl });
  assert.deepEqual(items.map((i) => i.id), [1, 2, 3]);
  assert.equal(s.calls.length, 2);
  assert.match(s.calls[1].url, /page=2/);
  assert.match(s.calls[0].url, /per_page=100/);
  assert.match(s.calls[0].url, /status=publish/);
});

test("an empty catalog is an empty list", async () => {
  const s = sequence(respond(200, [], { "x-wp-totalpages": "0" }));
  assert.deepEqual(await client.fetchAllProducts("https://shop.test", CREDS, { fetchImpl: s.fetchImpl }), []);
});

test("429 and 503 are retried (Retry-After honoured) and then succeed", async () => {
  const waits = [];
  const s = sequence(respond(429, { message: "slow down" }, { "retry-after": "2" }), respond(503, {}), respond(200, [{ id: 1 }], { "x-wp-totalpages": "1" }));
  const items = await client.fetchAllProducts("https://shop.test", CREDS, { fetchImpl: s.fetchImpl, sleepImpl: async (ms) => waits.push(ms) });
  assert.equal(items.length, 1);
  assert.equal(s.calls.length, 3);
  assert.equal(waits[0], 2000, "Retry-After seconds are used as the wait");
});

test("retries stop after maxRetries and surface a retriable WooApiError", async () => {
  const s = sequence(respond(503, { message: "down" }));
  await assert.rejects(
    () => client.wooRequest("https://shop.test/x", CREDS, { fetchImpl: s.fetchImpl, sleepImpl: noSleep, maxRetries: 2 }),
    (err) => err instanceof client.WooApiError && err.status === 503 && err.retriable === true
  );
  assert.equal(s.calls.length, 3);
});

test("a write is never retried on a 5xx (it may already have run) but is on a 429", async () => {
  const boom = sequence(respond(503, { message: "x" }));
  await assert.rejects(() => client.updateProductMeta("https://shop.test", CREDS, 7, { a: "b" }, { fetchImpl: boom.fetchImpl, sleepImpl: noSleep }));
  assert.equal(boom.calls.length, 1);
  const limited = sequence(respond(429, {}), respond(200, { id: 7 }));
  await client.updateProductMeta("https://shop.test", CREDS, 7, { a: "b" }, { fetchImpl: limited.fetchImpl, sleepImpl: noSleep });
  assert.equal(limited.calls.length, 2);
});

test("401, 403 and 404 map to a WooApiError with the WooCommerce code and are not retried", async () => {
  for (const status of [401, 403, 404]) {
    const s = sequence(respond(status, { code: "woocommerce_rest_cannot_view", message: "nope", data: { status } }));
    await assert.rejects(
      () => client.wooRequest("https://shop.test/x", CREDS, { fetchImpl: s.fetchImpl, sleepImpl: noSleep }),
      (err) => err.status === status && err.wooCode === "woocommerce_rest_cannot_view" && err.retriable === false && /nope/.test(err.message)
    );
    assert.equal(s.calls.length, 1);
  }
});

test("a network failure on a read is retried, then reported as a retriable error", async () => {
  const s = sequence(new TypeError("fetch failed"));
  await assert.rejects(() => client.wooRequest("https://shop.test/x", CREDS, { fetchImpl: s.fetchImpl, sleepImpl: noSleep, maxRetries: 1 }), (e) => e.retriable === true && /network error/.test(e.message));
  assert.equal(s.calls.length, 2);
});

test("an HTML answer (permalinks off) gets an actionable message", async () => {
  const s = sequence(respond(200, "<html>Not JSON</html>"));
  await assert.rejects(() => client.wooRequest("https://shop.test/x", CREDS, { fetchImpl: s.fetchImpl }), /pretty permalinks/);
});

test("updateProductMeta sends meta_data only; batch splits into chunks of 100", async () => {
  const s = sequence(respond(200, { id: 7 }));
  await client.updateProductMeta("https://shop.test", CREDS, 7, { _flipick_video_url: "https://v/1.mp4", _flipick_video_thumb: null }, { fetchImpl: s.fetchImpl });
  assert.equal(s.calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(s.calls[0].init.body), { meta_data: [{ key: "_flipick_video_url", value: "https://v/1.mp4" }, { key: "_flipick_video_thumb", value: "" }] });

  const b = sequence(respond(200, { update: [{ id: 1 }] }));
  const updates = Array.from({ length: 250 }, (_, i) => ({ id: i + 1 }));
  await client.batchUpdateProducts("https://shop.test", CREDS, updates, { fetchImpl: b.fetchImpl });
  assert.equal(b.calls.length, 3);
  assert.equal(JSON.parse(b.calls[0].init.body).update.length, 100);
  assert.equal(JSON.parse(b.calls[2].init.body).update.length, 50);
});

test("normalizeProduct: sale price becomes the price and an offer; category and images come from the product", () => {
  const p = normalizeProduct({
    id: 9, sku: "S9", name: "Tee", regular_price: "40", sale_price: "30", price: "30",
    categories: [{ name: "Uncategorized", slug: "uncategorized" }, { name: "T-Shirts", slug: "t-shirts" }],
    images: [{ src: "https://i/1.jpg" }, { src: "https://i/2.jpg" }], date_modified_gmt: "2026-10-01T10:00:00",
  }, null, { currencyCode: "EUR" });
  assert.equal(p.uniqueTag, "woo-9-novariant");
  assert.equal(p.price, 30);
  assert.deepEqual(p.offer, { originalPrice: 40, discountPercent: 25 });
  assert.equal(p.category, "T-Shirts");
  assert.equal(p.images.length, 2);
  assert.equal(p.currencyCode, "EUR");
  assert.equal(p.updatedAt, "2026-10-01T10:00:00.000Z");
});

test("normalizeProduct: a variable product takes its price from the variation but keeps the parent's identity", () => {
  const p = normalizeProduct({ id: 3, sku: "P", name: "Shirt", categories: [], images: [] }, { id: 32, regular_price: "32", sale_price: "", image: { src: "https://i/v.jpg" } });
  assert.equal(p.uniqueTag, "woo-3-32");
  assert.equal(p.wooProductId, "3");
  assert.equal(p.price, 32);
  assert.equal(p.offer, null);
  assert.equal(p.category, "Uncategorized");
  assert.deepEqual(p.images, ["https://i/v.jpg"]);
});

test("normalizeProducts keeps only published, visible simple/variable products with a price, and survives a failing variation", async () => {
  const base = { regular_price: "5", categories: [], images: [], catalog_visibility: "visible", status: "publish", type: "simple" };
  const skipped = [];
  const out = await normalizeProducts(
    [
      { ...base, id: 1, name: "ok" },
      { ...base, id: 2, name: "draft", status: "draft" },
      { ...base, id: 3, name: "hidden", catalog_visibility: "hidden" },
      { ...base, id: 4, name: "grouped", type: "grouped" },
      { ...base, id: 5, name: "free?", regular_price: "", price: "" },
      { ...base, id: 6, name: "broken variable", type: "variable" },
    ],
    () => { throw new Error("variations failed"); },
    { onSkip: (p) => skipped.push(p.id) }
  );
  assert.deepEqual(out.map((p) => p.name), ["ok"]);
  assert.deepEqual(skipped, [6]);
});

test("pickVariation takes the cheapest in-stock variation (sale price counts), else the cheapest overall", () => {
  const v = (id, regular, sale, stock) => ({ id, regular_price: String(regular), sale_price: sale === "" ? "" : String(sale), price: String(sale || regular), stock_status: stock });
  assert.equal(pickVariation([v(1, 10, "", "outofstock"), v(2, 30, "", "instock"), v(3, 40, 20, "instock")]).id, 3);
  assert.equal(pickVariation([v(1, 10, "", "outofstock"), v(2, 8, "", "outofstock")]).id, 2);
  assert.equal(pickVariation([v(5, 9, "", "instock"), v(4, 9, "", "instock")]).id, 4, "ties go to the lowest id");
  assert.equal(pickVariation([]), null);
});

test("names are decoded from WooCommerce's HTML entities", () => {
  const { decodeEntities } = require("../src/utils/normalize");
  assert.equal(decodeEntities("Dairy &amp; Eggs &#8217;s &quot;x&quot; &#x41;"), "Dairy & Eggs ’s \"x\" A");
  assert.equal(decodeEntities("&bogus; &#99999999;"), "&bogus; &#99999999;");
  const p = normalizeProduct({ id: 1, name: "Fish &amp; Chips", categories: [{ name: "Hoodies &amp; Sweatshirts" }], images: [], regular_price: "1" });
  assert.equal(p.name, "Fish & Chips");
  assert.equal(p.category, "Hoodies & Sweatshirts");
});

test("webhook signature: valid, wrong secret, tampered body, missing header", () => {
  const body = JSON.stringify({ id: 1, name: "Apples" });
  const sig = crypto.createHmac("sha256", "s3cret").update(body).digest("base64");
  assert.equal(signBody(body, "s3cret"), sig);
  assert.equal(verifyWebhookSignature(body, sig, "s3cret"), true);
  assert.equal(verifyWebhookSignature(body, sig, "other"), false);
  assert.equal(verifyWebhookSignature(body + " ", sig, "s3cret"), false);
  assert.equal(verifyWebhookSignature(body, "", "s3cret"), false);
  assert.equal(verifyWebhookSignature(body, undefined, "s3cret"), false);
  assert.equal(verifyWebhookSignature(body, "short", "s3cret"), false);
});
