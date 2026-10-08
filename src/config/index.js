// Single place where environment variables are read.
require("dotenv").config();


module.exports = {
  port: process.env.PORT || 4300,
  // Public address of this service: used in payment return URLs and links in invoices.
  publicBaseUrl: String(process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4300}`).replace(/\/+$/, ""),
  isProduction: process.env.NODE_ENV === "production",
  database: {
    // The running service connects as a role without BYPASSRLS; migrations use the owner role.
    url: process.env.DATABASE_URL || "postgresql://adapter_app:adapter_app_local@127.0.0.1:5435/woocommerce_adapter",
    adminUrl: process.env.DATABASE_ADMIN_URL || "postgresql://adapter_owner:adapter_owner_local@127.0.0.1:5435/woocommerce_adapter",
    ssl: process.env.DB_SSL === "require",
  },
  // 32-byte hex key: encrypts installation secrets and WooCommerce tokens at rest, and signs UI session tokens.
  secretKey: process.env.ADAPTER_SECRET_KEY || "",
  admin: {
    bootstrapEmail: process.env.ADMIN_BOOTSTRAP_EMAIL || "",
    bootstrapPassword: process.env.ADMIN_BOOTSTRAP_PASSWORD || "",
  },
  billing: {
    graceDays: Number(process.env.BILLING_GRACE_DAYS || 3),
    reminderDays: Number(process.env.BILLING_REMINDER_DAYS || 5),
    // GST on INR invoices to Indian merchants, in basis points. PLACEHOLDER: confirm with your accountant.
    gstRateBp: Number(process.env.GST_RATE_BP || 1800),
    sellerGstNumber: process.env.SELLER_GST_NUMBER || "",
    sellerName: process.env.SELLER_NAME || "Flipick",
    sellerAddress: process.env.SELLER_ADDRESS || "",
    topupPacksUsd: [1000, 2500, 5000], // credit packs in USD cents ($10, $25, $50)
    inrPerUsd: Number(process.env.INR_PER_USD || 83), // PLACEHOLDER rate for INR top-up packs; set the real one before launch
  },
  payment: {
    gateway: process.env.PAYMENT_GATEWAY || "mock", // mock | icici
    icici: {
      baseUrl: process.env.ICICI_PG_BASE_URL || "https://pgpayuat.icicibank.com",
      merchantId: process.env.ICICI_PG_MERCHANT_ID || "",
      aggregatorId: process.env.ICICI_PG_AGGREGATOR_ID || "",
      secretKey: process.env.ICICI_PG_SECRET_KEY || "",
    },
  },
  // Flipick video engine / VVP backend.
  flipick: {
    baseUrl: process.env.FLIPICK_SPONSORED_ADS_BASE_URL,
    videoEngineBaseUrl: process.env.FLIPICK_VIDEO_ENGINE_BASE_URL,
    videoEngineApiKey: process.env.FLIPICK_VIDEO_ENGINE_API_KEY,
    vvpApiKey: process.env.FLIPICK_VVP_API_KEY,
    sponsoredApiKey: process.env.FLIPICK_SPONSORED_ADS_API_KEY,
    tenantId: process.env.FLIPICK_TENANT_ID,
    retailerName: process.env.RETAILER_NAME,
  },
  // WooCommerce REST client behaviour (see src/integrations/wooClient.js).
  woo: {
    authMode: process.env.WOO_AUTH_MODE || "auto", // auto | basic | query
    timeoutMs: Number(process.env.WOO_TIMEOUT_MS || 20000),
    maxRetries: Number(process.env.WOO_MAX_RETRIES || 4),
  },
};
