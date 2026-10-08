// Flipick tells us when a project was edited in LTX Studio after generation: flag the slot stale instead of silently
// serving an out-of-date video. The callback carries no tenant, so the owning store is found from the project id.
const logger = require("../utils/logger");
const { withStore } = require("../db/connection");
const generatedState = require("../services/generatedState");
const videoVersions = require("../repositories/VideoVersionRepository");
const tenants = require("../services/tenantService");
const productService = require("../services/productService");
const { query, asSystem } = require("../db/connection");
const { verifyWebhookSignature } = require("../utils/wooWebhook");

async function videoEngine(req, res) {
  res.json({ ok: true });
  const { project_id: projectId, event } = req.body || {};
  if (!projectId || !event) return;
  try {
    const found = await videoVersions.findVersionByProjectId(projectId);
    if (!found) {
      logger.info(`[webhooks/video-engine] no matching video for project_id=${projectId} (event=${event})`);
      return;
    }
    await withStore(found.storeId, async () => {
      await generatedState.ensureLoaded();
      const key = generatedState.genKey(found.uniqueTag, found.videoType);
      logger.info(`[webhooks/video-engine] ${event} on project ${projectId} -- flagging "${key}" as stale`);
      const updated = await videoVersions.updateVersionAndMirror(found.id, { staleFromLtxEdit: true });
      if (updated && generatedState.get(key)?.currentVersionId === updated.id) generatedState.mergeVersion(key, updated);
    });
  } catch (err) {
    logger.error("Failed to process video-engine webhook:", err.message);
  }
}

const PRODUCT_TOPICS = new Set(["product.created", "product.updated", "product.deleted", "product.restored"]);

// WooCommerce -> adapter. The plugin registers these webhooks with the installation's secret as the signing secret.
//   * 401 for a bad signature (WooCommerce will not retry a 4xx forever; a forged call is simply refused),
//   * 200 for a delivery id already seen (idempotent: a redelivery changes nothing),
//   * 5xx only for our own failures, so WooCommerce retries those.
async function woocommerce(req, res) {
  const { installKey } = req.params;
  const topic = req.get("X-WC-Webhook-Topic") || "unknown";
  const deliveryId = req.get("X-WC-Webhook-Delivery-ID") || "";
  try {
    const installation = await tenants.getInstallationByKey(installKey);
    if (!installation || installation.status !== "active") {
      logger.warn("[webhooks/woocommerce] unknown or inactive installation", { installKey, topic });
      return res.status(404).json({ error: "Unknown installation" });
    }
    // WooCommerce's registration ping is an unsigned form post ("webhook_id=N"); answer it so the webhook is not marked failed.
    if (!req.get("X-WC-Webhook-Signature") && /^webhook_id=[0-9]+$/.test(String(req.rawBody || ""))) {
      logger.debug("[webhooks/woocommerce] ping acknowledged", { installationId: installation.id });
      return res.json({ ok: true, ping: true });
    }
    if (!verifyWebhookSignature(req.rawBody, req.get("X-WC-Webhook-Signature"), installation.secret)) {
      logger.warn("[webhooks/woocommerce] invalid signature", { installationId: installation.id, topic, deliveryId });
      return res.status(401).json({ error: "Invalid signature" });
    }
    if (deliveryId) {
      const inserted = await asSystem(() => query(
        "INSERT INTO webhook_deliveries (installation_id, delivery_id, topic) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [installation.id, deliveryId, topic]
      ));
      if (!inserted.rowCount) {
        logger.info("[webhooks/woocommerce] duplicate delivery ignored", { installationId: installation.id, topic, deliveryId });
        return res.json({ ok: true, duplicate: true });
      }
    }
    if (PRODUCT_TOPICS.has(topic)) {
      const store = await tenants.getStore(installation.id, "1");
      if (store) productService.invalidate(store.id);
      logger.info("[webhooks/woocommerce] product event -- catalog cache dropped", { installationId: installation.id, topic, deliveryId });
    } else {
      // The registration ping (a form-encoded "webhook_id=N") and any other topic: acknowledged, nothing to do.
      logger.debug("[webhooks/woocommerce] acknowledged", { installationId: installation.id, topic, deliveryId });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error("[webhooks/woocommerce] processing failed", { installKey, topic, deliveryId, error: err });
    res.status(500).json({ error: "Webhook processing failed" });
  }
}

module.exports = { videoEngine, woocommerce };
