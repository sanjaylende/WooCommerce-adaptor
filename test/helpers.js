// Shared test setup: a throwaway database, a fake WooCommerce REST server, a running adapter, and a signed-request client.
const http = require("http");
const crypto = require("crypto");
const { Client } = require("pg");

const ADAPTER_PORT = 45123;
const WOO_PORT = 45124;
const DB_NAME = "woocommerce_adapter_test";
const OWNER = "postgresql://adapter_owner:adapter_owner_local@127.0.0.1:5435";

async function resetDatabase() {
  const admin = new Client({ connectionString: `${OWNER}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB_NAME} OWNER adapter_owner`);
  await admin.end();
}

function useTestEnvironment() {
  Object.assign(process.env, {
    DATABASE_URL: `postgresql://adapter_app:adapter_app_local@127.0.0.1:5435/${DB_NAME}`,
    DATABASE_ADMIN_URL: `${OWNER}/${DB_NAME}`,
    ADAPTER_SECRET_KEY: "11".repeat(32),
    PORT: String(ADAPTER_PORT),
    PUBLIC_BASE_URL: `http://127.0.0.1:${ADAPTER_PORT}`,
    PAYMENT_GATEWAY: "mock",
    ADMIN_BOOTSTRAP_EMAIL: "staff@test.local",
    ADMIN_BOOTSTRAP_PASSWORD: "staff-password-1",
    BILLING_GRACE_DAYS: "3",
    GST_RATE_BP: "1800",
    NODE_ENV: "test",
  });
}

// A minimal WooCommerce REST API. The site root is the USD store with a simple product (Apples), a variable product (Shirt),
// a draft and a hidden product; "/shop2" is a second site (EUR) with one product (Pears). Authentication accepts
// OAuth 1.0a (verified, nonce single-use), HTTP Basic and query-string keys. "/flaky" answers 503 twice, to exercise retries.
function startFakeWooCommerce() {
  const simple = (id, name, extra = {}) => ({
    id, sku: `SKU-${id}`, name, status: "publish", type: "simple", catalog_visibility: "visible",
    price: String(10 + id), regular_price: String(10 + id), sale_price: "",
    categories: [{ id: 5, name: "Fruits", slug: "fruits" }], images: [{ id: 1, src: `https://img.test/${id}.jpg` }],
    attributes: [{ name: "Origin", options: ["Kashmir"] }], meta_data: [], date_modified_gmt: "2026-10-01T10:00:00", ...extra,
  });
  const variable = simple(3, "Shirt", { type: "variable", price: "", regular_price: "", categories: [{ id: 6, name: "T-Shirts", slug: "t-shirts" }] });
  const variations = [
    { id: 31, regular_price: "30", sale_price: "24", price: "24", stock_status: "outofstock", image: { src: "https://img.test/31.jpg" } },
    { id: 32, regular_price: "32", sale_price: "", price: "32", stock_status: "instock", image: { src: "https://img.test/32.jpg" } },
  ];
  const state = { flakyHits: 0, puts: [] };
  const seenNonces = new Set();
  const server = http.createServer((req, res) => {
    const send = (code, body, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    const u = new URL(req.url, `http://${req.headers.host}`);
    const basic = req.headers.authorization === `Basic ${Buffer.from("good-key:good-secret").toString("base64")}`;
    const query = u.searchParams.get("consumer_key") === "good-key" && u.searchParams.get("consumer_secret") === "good-secret";
    // OAuth 1.0a: recompute the signature exactly as WooCommerce does and refuse a reused nonce.
    let oauth = false;
    if (u.searchParams.get("oauth_consumer_key") === "good-key") {
      const given = u.searchParams.get("oauth_signature");
      const probe = new URL(u.toString());
      for (const k of [...probe.searchParams.keys()]) if (k.startsWith("oauth_")) probe.searchParams.delete(k);
      const { signOAuth } = require("../src/integrations/wooClient");
      const expected = signOAuth(probe, req.method, { key: "good-key", secret: "good-secret" }, u.searchParams.get("oauth_nonce"), Number(u.searchParams.get("oauth_timestamp"))).searchParams.get("oauth_signature");
      const nonce = u.searchParams.get("oauth_nonce");
      if (given === expected && !seenNonces.has(nonce)) { seenNonces.add(nonce); oauth = true; }
    }
    if (!basic && !query && !oauth) return send(401, { code: "woocommerce_rest_cannot_view", message: "Sorry, you cannot list resources.", data: { status: 401 } });
    let path = u.pathname;
    const site2 = path.startsWith("/shop2");
    if (site2) path = path.slice(6);
    const api = "/wp-json/wc/v3";
    if (path === `${api}/system_status`) return send(200, { environment: { version: "9.4.1", wp_version: "6.7", site_url: "x" }, settings: { currency: site2 ? "EUR" : "USD" } });
    if (path === `${api}/products` && req.method === "GET") {
      const list = site2 ? [simple(2, "Pears")] : [simple(1, "Apples"), variable, simple(4, "Draft", { status: "draft" }), simple(5, "Hidden", { catalog_visibility: "hidden" })];
      const page = Number(u.searchParams.get("page") || 1);
      return send(200, page === 1 ? list : [], { "X-WP-Total": String(list.length), "X-WP-TotalPages": "1" });
    }
    if (path === `${api}/products/3/variations`) return send(200, variations, { "X-WP-TotalPages": "1" });
    const one = path.match(/^\/wp-json\/wc\/v3\/products\/(\d+)$/);
    if (one && req.method === "PUT") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => { state.puts.push({ id: one[1], body: JSON.parse(raw) }); send(200, { id: Number(one[1]) }); });
      return;
    }
    if (path === "/flaky/wp-json/wc/v3/products") { state.flakyHits += 1; return state.flakyHits <= 2 ? send(503, { message: "busy" }) : send(200, [simple(9, "Ok")], { "X-WP-TotalPages": "1" }); }
    send(404, { code: "rest_no_route", message: `unexpected ${path}` });
  });
  server.state = state;
  return new Promise((resolve) => server.listen(WOO_PORT, "127.0.0.1", () => resolve(server)));
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (secret, s) => crypto.createHmac("sha256", secret).update(s).digest("hex");

// Calls the adapter like the extension does: signed headers, JSON body.
function signedClient({ installKey, secret, websiteId, baseUrl = `http://127.0.0.1:${ADAPTER_PORT}` }) {
  return async function call(method, path, body, { nonce = crypto.randomUUID(), ts = Math.floor(Date.now() / 1000), headers = {}, badSignature = false } = {}) {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const signature = badSignature ? "0".repeat(64) : hmac(secret, `${ts}\n${nonce}\n${method}\n${path}\n${sha256(raw)}`);
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json", "X-Flipick-Key": installKey, "X-Flipick-Timestamp": String(ts), "X-Flipick-Nonce": nonce,
        "X-Flipick-Signature": signature, ...(websiteId != null ? { "X-Flipick-Website": String(websiteId) } : {}), ...headers,
      },
      body: raw || undefined,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
}

function launchToken({ installKey, secret, websiteId, expiresInSeconds = 300 }) {
  const body = Buffer.from(JSON.stringify({ k: installKey, w: String(websiteId), e: Math.floor(Date.now() / 1000) + expiresInSeconds, n: crypto.randomUUID() })).toString("base64url");
  return `${body}.${hmac(secret, body)}`;
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${ADAPTER_PORT}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual",
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

module.exports = { ADAPTER_PORT, WOO_PORT, resetDatabase, useTestEnvironment, startFakeWooCommerce, signedClient, launchToken, api, hmac };
