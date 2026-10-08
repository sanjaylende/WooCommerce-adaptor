// Calls the live store through the ADAPTER's own WooCommerce client (so auth, paging and variation handling are the real
// code paths) and prints a summary:  node verify.js   (setup.sh must have written .env.local)
const fs = require("fs");
const path = require("path");
const envFile = path.join(__dirname, ".env.local");
if (!fs.existsSync(envFile)) { console.error(".env.local not found: run ./setup.sh first"); process.exit(1); }
const env = Object.fromEntries(fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "warn";
const client = require("../../src/integrations/wooClient");
const { fetchProducts } = require("../../src/services/catalogService");

(async () => {
  const creds = `${env.WC_CONSUMER_KEY}:${env.WC_CONSUMER_SECRET}`;
  console.log(`GET ${env.WC_SITE_URL}/wp-json/wc/v3/system_status   (auth: ${client.resolveAuthMode(env.WC_SITE_URL)})`);
  console.log(await client.fetchStoreInfo(env.WC_SITE_URL, creds));
  const raw = await client.fetchAllProducts(env.WC_SITE_URL, creds);
  console.log(`\nGET /wp-json/wc/v3/products -> ${raw.length} published products`);
  for (const p of raw) console.log(" -", String(p.id).padEnd(4), p.type.padEnd(8), (p.sku || "").padEnd(13), p.name.padEnd(28), "| price", p.price || "(variable)", "| stock", p.stock_status);
  const catalog = await fetchProducts(env.WC_SITE_URL, creds, { currencyCode: "USD" });
  console.log(`\nAdapter catalog (normalised): ${catalog.length} rows`);
  for (const p of catalog) console.log(" -", p.uniqueTag.padEnd(16), p.name.padEnd(28), p.category.padEnd(22), `${p.currencyCode} ${p.price}`, p.offer ? `(${p.offer.discountPercent}% off)` : "");
})().catch((err) => { console.error("FAILED:", err.message); process.exit(1); });
