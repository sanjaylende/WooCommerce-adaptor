// Onboarding of a WooCommerce installation: the WordPress plugin presents a working consumer key + secret, which proves the
// caller controls that store; the adapter reads the store's facts, creates the merchant / installation / store and hands back
// the install key and secret (shown once).
//
// A WordPress site is one store (multisite is out of scope for v1), so every installation has exactly one store whose
// external id is "1".
const dns = require("dns").promises;
const net = require("net");
const config = require("../config");
const logger = require("../utils/logger");
const tenants = require("./tenantService");
const { fetchStoreInfo, WooApiError } = require("../integrations/wooClient");

const STORE_EXTERNAL_ID = "1";
const httpError = (status, message) => Object.assign(new Error(message), { status, userMessage: message });

function normaliseBaseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw httpError(400, "baseUrl is not a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw httpError(400, "baseUrl must be http or https");
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

const isPrivateAddress = (ip) =>
  net.isIP(ip) === 4
    ? /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(ip)
    : /^(::1$|fc|fd|fe80)/i.test(ip);

// In production the adapter must not be usable to probe internal networks (the store URL is caller-supplied).
async function assertPublicHost(baseUrl) {
  if (!config.isProduction) return;
  const { hostname } = new URL(baseUrl);
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (addresses.some((a) => isPrivateAddress(a.address))) throw httpError(400, "Store URL must be publicly reachable");
}

// The credentials are validated by calling the store with them. Failures become precise, merchant-readable messages.
async function readStore(baseUrl, credentials, fallbackName) {
  try {
    const info = await fetchStoreInfo(baseUrl, credentials);
    return { id: STORE_EXTERNAL_ID, code: "default", name: fallbackName || new URL(baseUrl).hostname, baseCurrency: info.currency, info };
  } catch (err) {
    if (!(err instanceof WooApiError)) throw err;
    if (err.status === 401 || err.status === 403) throw httpError(400, "WooCommerce rejected the API keys. Create a key with Read/Write permission and try again.");
    if (err.status === 404) throw httpError(400, "WooCommerce REST API not found. Enable pretty permalinks (Settings > Permalinks) and make sure WooCommerce is active.");
    throw httpError(400, `Could not read the WooCommerce store: ${err.message}`);
  }
}

async function register({ baseUrl, wooCredentials, consumerKey, consumerSecret, merchantName, contactEmail, countryCode, wooVersion, extensionVersion }) {
  const credentials = wooCredentials || (consumerKey && consumerSecret ? `${consumerKey}:${consumerSecret}` : "");
  if (!baseUrl || !credentials) throw httpError(400, "baseUrl, consumerKey and consumerSecret are required");
  const url = normaliseBaseUrl(baseUrl);
  await assertPublicHost(url);

  const store = await readStore(url, credentials, merchantName);
  const creds = await tenants.registerInstallation({ baseUrl: url, wooCredentials: credentials, merchantName, contactEmail, countryCode, wooVersion: wooVersion || store.info.wooVersion, extensionVersion });
  const stores = await tenants.syncStores(creds.installationId, [store]);
  logger.info("WooCommerce installation registered", { baseUrl: url, installationId: creds.installationId, wooVersion: store.info.wooVersion, currency: store.baseCurrency });
  return { installKey: creds.installKey, secret: creds.secret, stores: stores.map((s) => ({ websiteId: s.externalId, code: s.code, name: s.name })) };
}

async function resync(installation) {
  // Keep the name the store already has; only currency and reachability are re-read.
  const [existing] = await tenants.listStores(installation.id);
  const store = await readStore(installation.baseUrl, installation.wooCredentials, existing && existing.name);
  const stores = await tenants.syncStores(installation.id, [store]);
  return stores.map((s) => ({ websiteId: s.externalId, code: s.code, name: s.name }));
}

module.exports = { register, resync, normaliseBaseUrl, STORE_EXTERNAL_ID };
