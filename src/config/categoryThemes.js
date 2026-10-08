// Mirrors LTX's backend/src/api/video-engine/category-registry.js pattern —
// a plain, hardcoded, category-keyed config object, not a DB table. This is
// the WooCommerce port of the Shopify adapter's categoryThemeRegistry.js: same
// mechanism, keys are WooCommerce product category names.
//
// WooCommerce categories are merchant-defined, so an unmapped category falls back to a neutral theme (and is logged).

const logger = require("../utils/logger");

const DEFAULT_THEME = "General Retail";

const CATEGORY_THEME_REGISTRY = {
  // Keys are WooCommerce product category names.
  "Fruits": "Fresh Produce",
  "Vegetables": "Fresh Produce",
  "Dairy & Eggs": "Dairy Fresh",
  "Bakery": "Bakery Fresh",
  "Pantry": "Pantry Staples",
  "Beverages": "Refreshing Beverages",
  "Snacks": "General Retail",
  // Apparel
  "T-Shirts": "Apparel Fashion",
  "Hoodies & Sweatshirts": "Apparel Fashion",
  "Jeans & Trousers": "Apparel Fashion",
  "Jackets": "Apparel Fashion",
  "Activewear": "Apparel Fashion",
  "Footwear": "Footwear Fashion",
  "Accessories": "Apparel Fashion",
  // Jewellery
  "Rings": "Luxury Jewellery",
  "Necklaces": "Luxury Jewellery",
  "Earrings": "Luxury Jewellery",
  "Bracelets": "Luxury Jewellery",
  "Pendants": "Luxury Jewellery",
  "Watches": "Luxury Watches",
  "Uncategorized": "General Retail",
};

function getThemeForCategory(category) {
  const theme = CATEGORY_THEME_REGISTRY[category];
  if (!theme) {
    logger.warn(`No video theme registered for WooCommerce category "${category}" -- using "${DEFAULT_THEME}". Add it to CATEGORY_THEME_REGISTRY.`);
    return DEFAULT_THEME;
  }
  return theme;
}

module.exports = { CATEGORY_THEME_REGISTRY, getThemeForCategory };
