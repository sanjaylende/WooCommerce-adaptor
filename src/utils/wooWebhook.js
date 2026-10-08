// WooCommerce webhook signature: X-WC-Webhook-Signature = base64( HMAC-SHA256( secret, rawBody ) ).
const crypto = require("crypto");

function signBody(rawBody, secret) {
  return crypto.createHmac("sha256", String(secret)).update(String(rawBody == null ? "" : rawBody), "utf8").digest("base64");
}

// Constant-time comparison; false for a missing or malformed signature (never throws).
function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = Buffer.from(signBody(rawBody, secret));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { signBody, verifyWebhookSignature };
