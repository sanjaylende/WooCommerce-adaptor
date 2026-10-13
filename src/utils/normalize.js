// Pure data-shaping: a WooCommerce REST product (+ optionally its first variation) -> the catalog row the UI and the video
// engine use. No I/O here; catalogService.js does the fetching and passes the results in.
const DEFAULT_CATEGORY = "Uncategorized";

function discountPercent(price, originalPrice) {
  if (price == null || originalPrice == null || originalPrice <= 0) return null;
  return Math.round(((originalPrice - price) / originalPrice) * 10000) / 100;
}

// WooCommerce returns names HTML-encoded ("Dairy &amp; Eggs"); the UI and the video text want plain text.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(text) {
  return String(text == null ? "" : text).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
}

const toNumber = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Every gallery image of the product (WooCommerce returns absolute URLs, so no media base URL is needed).
function pickImages(product) {
  const images = Array.isArray(product.images) ? product.images : [];
  return images.map((i) => i && i.src).filter(Boolean);
}

// First real category name; WooCommerce's default "Uncategorized" is treated as none.
function pickCategory(product) {
  const cats = Array.isArray(product.categories) ? product.categories : [];
  const named = cats.find((c) => c && c.name && c.slug !== "uncategorized") || cats[0];
  return named && named.name ? decodeEntities(named.name) : DEFAULT_CATEGORY;
}

// `variation` is the first purchasable variation of a variable product (null for any other type). Price comes from it,
// but identity (id, sku, image gallery) always stays the PARENT's: the video must land on the page a shopper visits.
//
// WooCommerce prices: regular_price is the list price, sale_price (when set and lower) the selling price. A sale shows
// as an offer exactly like Magento's special_price.
// One entry per variation (all of them, not just the one that supplies the product's own price): { id, title, price, compareAtPrice }.
// Only used to offer one Price / MRP pair per variant in the overlay Variables picker.
function variantsFrom(variations) {
  return (variations || []).map((v) => {
    const regular = toNumber(v.regular_price) ?? toNumber(v.price);
    const sale = toNumber(v.sale_price);
    const onSale = sale != null && regular != null && sale < regular;
    const parts = (Array.isArray(v.attributes) ? v.attributes : []).map((a) => decodeEntities(a.option || "")).filter(Boolean);
    return { id: v.id, title: parts.join(" / ") || `Variant ${v.id}`, price: onSale ? sale : regular, compareAtPrice: onSale ? regular : null };
  });
}

function normalizeProduct(product, variation, { currencyCode, variations } = {}) {
  const priceSource = variation || product;
  const regularPrice = toNumber(priceSource.regular_price) ?? toNumber(priceSource.price);
  const salePrice = toNumber(priceSource.sale_price);
  const hasOffer = salePrice != null && regularPrice != null && salePrice < regularPrice;
  const images = pickImages(product);
  if (variation && variation.image && variation.image.src && !images.includes(variation.image.src)) images.push(variation.image.src);

  return {
    uniqueTag: `woo-${product.id}-${variation?.id ?? "novariant"}`,
    variants: variantsFrom(variations),
    wooProductId: String(product.id),
    sku: product.sku || "",
    name: decodeEntities(product.name),
    category: pickCategory(product),
    image: images[0] || null,
    images,
    price: hasOffer ? salePrice : regularPrice,
    // Stamped per product so the UI and overlay text use the store's currency symbol instead of assuming "$".
    currencyCode: currencyCode || "USD",
    // WooCommerce sends the modification time in UTC as "date_modified_gmt" (ISO without a zone suffix).
    updatedAt: product.date_modified_gmt ? new Date(`${String(product.date_modified_gmt).replace(/Z$/, "")}Z`).toISOString() : null,
    offer: hasOffer ? { originalPrice: regularPrice, discountPercent: discountPercent(salePrice, regularPrice) } : null,
    // Merchant-defined attributes (Size, Color ...) for the Custom overlay picker: [{ name, value }].
    attributes: (Array.isArray(product.attributes) ? product.attributes : [])
      .map((a) => ({ name: decodeEntities(a.name), value: Array.isArray(a.options) ? decodeEntities(a.options.join(", ")) : "" }))
      .filter((a) => a.name && a.value),
  };
}

// Only published products that are visible somewhere in the shop reach video generation. Grouped and external products
// have no price of their own, so they are skipped; a price-less row is dropped after normalisation.
//
// resolveVariation(product) is supplied by the caller and performs the I/O this module stays free of: fetching a variable
// product's variations. It returns the variation that supplies the price, or { variation, variations } to also hand over every
// variation (for the per-variant overlay options). A failure there is the caller's to handle; this function never throws for one bad product.
async function normalizeProducts(wooProducts, resolveVariation, { currencyCode, onSkip } = {}) {
  const eligible = (wooProducts || [])
    .filter((p) => p && p.status === "publish")
    .filter((p) => p.catalog_visibility !== "hidden")
    .filter((p) => p.type === "simple" || p.type === "variable");

  const normalized = [];
  for (const product of eligible) {
    try {
      const resolved = product.type === "variable" ? await resolveVariation(product) : null;
      const { variation, variations } = resolved && Object.prototype.hasOwnProperty.call(resolved, "variation") ? resolved : { variation: resolved, variations: resolved ? [resolved] : [] };
      normalized.push(normalizeProduct(product, variation, { currencyCode, variations }));
    } catch (err) {
      // One broken product must not blank the whole catalog.
      if (onSkip) onSkip(product, err);
    }
  }
  return normalized.filter((p) => p.price != null);
}

module.exports = { decodeEntities, normalizeProducts, normalizeProduct, discountPercent, pickImages, pickCategory };
