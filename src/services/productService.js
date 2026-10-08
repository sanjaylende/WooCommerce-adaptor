// In-memory product cache over each store's WooCommerce catalog (cheap to refetch with the Refresh button).
const { currentStoreId } = require("../db/connection");
const { tenant } = require("../context");
const { fetchProducts } = require("./catalogService");

const byStore = new Map(); // storeId -> { products, syncedAt }

const entry = () => {
  const id = currentStoreId();
  if (!byStore.has(id)) byStore.set(id, { products: [], syncedAt: null });
  return byStore.get(id);
};

async function refreshProducts() {
  const { woo } = tenant();
  const e = entry();
  e.products = await fetchProducts(woo.baseUrl, woo.accessToken, woo);
  e.syncedAt = new Date().toISOString();
  return e.products;
}

const list = () => entry().products;
const syncedAt = () => entry().syncedAt;
const findProduct = (uniqueTag) => entry().products.find((p) => p.uniqueTag === uniqueTag);

// Drops a store's cached catalog (a WooCommerce product webhook says it changed); the next refresh refetches it.
const invalidate = (storeId) => byStore.delete(storeId);

module.exports = { invalidate, refreshProducts, list, syncedAt, findProduct };
