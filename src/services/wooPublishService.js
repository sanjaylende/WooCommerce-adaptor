// Publishes a generated video to a WooCommerce product by writing two product meta fields; the WordPress plugin's storefront
// hook reads them back and renders a <video> element on the product page.
const { updateProductMeta } = require("../integrations/wooClient");
const { VIDEO_URL_META_KEY, VIDEO_THUMBNAIL_META_KEY } = require("../config/constants");
const logger = require("../utils/logger");

// One plain meta write on the parent product (the page a shopper visits). WooCommerce merges meta by key, so no other
// field of the product is disturbed. Errors propagate to the controller, which turns them into a user message.
async function pushVideoToProduct({ baseUrl, accessToken, wooProductId, videoUrl, thumbnailUrl }) {
  await updateProductMeta(baseUrl, accessToken, wooProductId, {
    [VIDEO_URL_META_KEY]: videoUrl,
    [VIDEO_THUMBNAIL_META_KEY]: thumbnailUrl || "",
  });
  logger.info("Video published to WooCommerce product", { wooProductId });
  return { pushed: true };
}

// Clears both meta fields when a published video is deleted, so the storefront stops showing it.
async function clearVideoFromProduct({ baseUrl, accessToken, wooProductId }) {
  await updateProductMeta(baseUrl, accessToken, wooProductId, { [VIDEO_URL_META_KEY]: "", [VIDEO_THUMBNAIL_META_KEY]: "" });
  logger.info("Video cleared from WooCommerce product", { wooProductId });
}

module.exports = { pushVideoToProduct, clearVideoFromProduct };
