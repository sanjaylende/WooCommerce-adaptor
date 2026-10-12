// WooCommerce product catalog: fetches products through the REST API and shapes them for the UI; also builds the per-product
// attribute options the modal's Custom overlay picker offers.
const { fetchAllProducts, fetchVariations } = require("../integrations/wooClient");
const { normalizeProducts } = require("../utils/normalize");
const { formatMoney } = require("../utils/money");
const logger = require("../utils/logger");

const VARIATION_CONCURRENCY = 5; // parallel /variations calls: fast on big catalogs without hammering a small shared host

// Runs `worker` over `items` with at most `limit` in flight; never rejects (a failure is returned as null for that item).
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length).fill(null);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await worker(items[i]);
      } catch (err) {
        results[i] = null;
        logger.warn("Catalog worker failed", { index: i, error: err.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

// The cheapest in-stock variation ("from $X", which is how a shopper meets a variable product); when everything is out of
// stock, the cheapest overall. Ties go to the lowest id so the choice is stable between refreshes.
function pickVariation(variations) {
  const price = (v) => Number(v.sale_price !== "" && v.sale_price != null ? v.sale_price : v.regular_price !== "" ? v.regular_price : v.price);
  const priced = (variations || []).filter((v) => v && Number.isFinite(price(v)));
  const cheapest = (list) => [...list].sort((a, b) => price(a) - price(b) || a.id - b.id)[0] || null;
  return cheapest(priced.filter((v) => v.stock_status !== "outofstock")) || cheapest(priced);
}

async function fetchProducts(baseUrl, credentials, options = {}) {
  const startedAt = Date.now();
  const raw = await fetchAllProducts(baseUrl, credentials, options);

  const variable = raw.filter((p) => p && p.type === "variable" && p.status === "publish");
  const fetched = await mapWithConcurrency(variable, VARIATION_CONCURRENCY, (p) => fetchVariations(baseUrl, credentials, p.id, options));
  const variationByProduct = new Map(variable.map((p, i) => [p.id, { variation: pickVariation(fetched[i]), variations: fetched[i] || [] }]));

  const products = await normalizeProducts(raw, (p) => variationByProduct.get(p.id) || null, {
    currencyCode: options.currencyCode,
    onSkip: (p, err) => logger.warn("Skipped a product while normalising the catalog", { productId: p && p.id, error: err.message }),
  });
  logger.info("Catalog refreshed", { fetched: raw.length, eligible: products.length, variable: variable.length, ms: Date.now() - startedAt });
  return products;
}

// The built-in attribute catalog the modal's per-variable value picker always offers, on top of the product's own attributes.
const CUSTOM_ATTRIBUTE_OPTIONS = [
  { key: "productName", label: "Product Name" },
  { key: "category", label: "Category" },
  { key: "price", label: "Price" },
  { key: "mrp", label: "MRP" },
  { key: "offer", label: "Offer" },
];

function customAttributeValue(product, key) {
  switch (key) {
    case "productName": return product.name;
    case "category": return product.category;
    case "price": return formatMoney(product.price, product.currencyCode);
    case "mrp": return product.offer ? formatMoney(product.offer.originalPrice, product.currencyCode) : "";
    case "offer": return product.offer ? `${product.offer.discountPercent}% off` : "";
    default: return "";
  }
}

// Fixed catalog plus the product's own attributes (Size, Color ...). They were captured during the catalog refresh, so this
// needs no extra request to the store.
// One Price (and MRP, if it is on sale) option per variation, e.g. "S - Price" / "L - Price", so the Variables picker can map more than one
// variable to more than one variant's price in the same overlay. Only offered when the product really has more than one variation.
function variantAttributeOptions(product) {
  if (!Array.isArray(product.variants) || product.variants.length < 2) return [];
  return product.variants.flatMap((variant) => {
    const label = variant.title || `Variant ${variant.id}`;
    const options = [];
    if (variant.price != null) options.push({ key: `variant:${variant.id}:price`, label: `${label} - Price`, value: formatMoney(variant.price, product.currencyCode) });
    if (variant.compareAtPrice != null && variant.price != null && variant.compareAtPrice > variant.price) {
      options.push({ key: `variant:${variant.id}:mrp`, label: `${label} - MRP`, value: formatMoney(variant.compareAtPrice, product.currencyCode) });
    }
    return options;
  });
}

// The first variation is the generic "Price"/"MRP" value; once a product has several, each is offered under its own name, so the generic
// pair would only show the same number twice.
const GENERIC_PRICE_KEYS = ["price", "mrp"];

async function getProductAttributeOptions(product) {
  const isMultiVariant = Array.isArray(product.variants) && product.variants.length > 1;
  const fixed = CUSTOM_ATTRIBUTE_OPTIONS
    .filter((opt) => !(isMultiVariant && GENERIC_PRICE_KEYS.includes(opt.key)))
    .map((opt) => ({ key: opt.key, label: opt.label, value: customAttributeValue(product, opt.key) }))
    .filter((opt) => opt.value !== "");
  const own = (product.attributes || []).map((a) => ({ key: `attribute:${a.name}`, label: a.name, value: a.value }));
  return [...fixed, ...variantAttributeOptions(product), ...own];
}

module.exports = { fetchProducts, getProductAttributeOptions, pickVariation };
