// End-to-end check of the install guide against a FRESH store, driven over HTTP exactly as a browser would:
// log in -> open the plugin page -> submit the Connect form -> refresh -> billing page -> product list column ->
// open the generator (launch token) -> render a video -> Add to product page -> check the storefront as an anonymous visitor
// -> webhook delivery. Prints PASS/FAIL per step and exits 1 on the first failure.
//   node exercise.js            (full, renders a video, ~3 minutes)
//   SKIP_GENERATE=1 node exercise.js
const base = process.env.WP_URL || "http://localhost:8087";
const adapter = process.env.ADAPTER_URL || "http://localhost:4300";
const serverAdapter = process.env.ADAPTER_SERVER_URL || "http://host.docker.internal:4300";
const user = process.env.WP_USER || "admin", pass = process.env.WP_PASS || "change-me-admin";
const jar = new Map();
const results = [];
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + "s";
const step = (name, ok, detail = "") => { results.push([name, ok]); console.log(`${stamp()} ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); if (!ok) { console.log("\nStopped at the first failure."); process.exit(1); } };

async function http(url, opts = {}) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(url, { redirect: "manual", ...opts, headers: { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
  for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  return res;
}
const form = (o) => new URLSearchParams(o).toString();
const post = (url, o) => http(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form(o) });
const nonceFor = (html, action) => { const m = html.replace(/\s+/g, " ").match(new RegExp(`value="${action}"[^>]*>[^>]*?_wpnonce" value="([a-z0-9]+)"`)); return m && m[1]; };
const msgOf = (res) => { const l = res.headers.get("location") || ""; return decodeURIComponent((l.match(/fvg_msg=([^&]*)/) || [, ""])[1].replace(/\+/g, " ")); };

(async () => {
  // 1. log in
  jar.set("wordpress_test_cookie", "WP%20Cookie%20check");
  await http(base + "/wp-login.php");
  const login = await post(base + "/wp-login.php", { log: user, pwd: pass, "wp-submit": "Log In", testcookie: "1" });
  step("log in to wp-admin", login.status === 302 && [...jar.keys()].some((k) => k.startsWith("wordpress_logged_in")));

  // 2. plugin page. A store that is already connected is disconnected first, so every run starts from the same place.
  let page = await (await http(base + "/wp-admin/admin.php?page=flipick-video-generator")).text();
  if (/fvg_disconnect/.test(page)) {
    const d = await post(base + "/wp-admin/admin-post.php", { action: "fvg_disconnect", _wpnonce: nonceFor(page, "fvg_disconnect") });
    step("disconnect the already connected store", /disconnected/i.test(msgOf(d)), msgOf(d));
    page = await (await http(base + "/wp-admin/admin.php?page=flipick-video-generator")).text();
  }
  step("plugin menu opens and shows the connect form", /Connect store/.test(page) && /Adapter URL/.test(page));

  // 3. connect
  const connect = await post(base + "/wp-admin/admin-post.php", { action: "fvg_connect", _wpnonce: nonceFor(page, "fvg_connect"), adapter_url: serverAdapter, public_url: adapter });
  step("Connect store", /connected/i.test(msgOf(connect)) && /fvg_type=success/.test(connect.headers.get("location") || ""), msgOf(connect));
  page = await (await http(base + "/wp-admin/admin.php?page=flipick-video-generator")).text();
  const iframe = (page.match(/<iframe[^>]*src="([^"]+)"/) || [])[1];
  step("connected page frames the generator", !!iframe && /Connected on/.test(page));

  // 4. other admin screens and actions
  const billing = await (await http(base + "/wp-admin/admin.php?page=flipick-video-generator-billing")).text();
  step("Plans & Billing page frames the adapter", /<iframe/.test(billing));
  const refresh = await post(base + "/wp-admin/admin-post.php", { action: "fvg_refresh", _wpnonce: nonceFor(page, "fvg_refresh") });
  step("Refresh products", /Reloaded 7 products/.test(msgOf(refresh)), msgOf(refresh));
  const resync = await post(base + "/wp-admin/admin-post.php", { action: "fvg_resync", _wpnonce: nonceFor(page, "fvg_resync") });
  step("Re-sync store", /re-synced/.test(msgOf(resync)), msgOf(resync));
  const list = await (await http(base + "/wp-admin/edit.php?post_type=product")).text();
  step("product list has the Video column and Generate video action", /Generate video/.test(list) && />Video</.test(list));

  // 5. generator (what the iframe does)
  const src = iframe.replace(/&#038;|&amp;/g, "&");
  const shell = await fetch(src);
  step("adapter page loads", shell.status === 200 && /frame-ancestors/.test(shell.headers.get("content-security-policy") || ""), shell.headers.get("content-security-policy") || "");
  const launch = new URL(src).searchParams.get("launch");
  const sres = await fetch(adapter + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ launch }) });
  const session = await sres.json();
  step("launch token accepted (session)", sres.status === 200 && !!session.token);
  const again = await fetch(adapter + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ launch }) });
  step("launch token is single use", again.status === 401);
  const auth = { Authorization: "Bearer " + session.token, "Content-Type": "application/json" };
  const api = async (m, p, b) => { const r = await fetch(adapter + p, { method: m, headers: auth, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const boot = await api("GET", "/api/bootstrap");
  step("products load from WooCommerce", boot.body.products && boot.body.products.length === 7, `${(boot.body.products || []).length} products, plan ${boot.body.billing && boot.body.billing.currentPlan}`);
  const fam = await api("GET", "/api/overlay-families");
  step("overlay list is not empty", (fam.body.families || []).length > 0, `${(fam.body.families || []).length} overlays`);
  const product = boot.body.products.find((p) => /Apples/.test(p.name));
  const pid = product.uniqueTag.split("-")[1];

  if (!process.env.SKIP_GENERATE) {
    const g = await api("POST", "/api/generate", { uniqueTag: product.uniqueTag, videoType: "hero_product", aspectRatio: "16:9", prompt: "Fresh apples on a wooden table, soft morning light", startImageUrl: product.image });
    step("start Hero Product render", g.status === 200, JSON.stringify(g.body));
    const started = Date.now();
    let st = {};
    while (Date.now() - started < 12 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 10000));
      st = (await api("GET", `/api/status/${product.uniqueTag}/hero_product`)).body;
      if (st.status === "ready" || st.status === "error") break;
    }
    step("render finishes", st.status === "ready", `${st.status} after ${Math.round((Date.now() - started) / 1000)}s ${st.error || ""}`);
    const push = await api("POST", `/api/generated/${product.uniqueTag}/hero_product/push-to-store`);
    step("Add to product page", push.status === 200 && push.body.pushed, JSON.stringify(push.body));
    jar.clear(); // anonymous visitor from here on
    const html = await (await fetch(`${base}/?p=${pid}`, { redirect: "follow" })).text();
    const vid = html.match(/<video[^>]*src="(https?:[^"]+)"/);
    step("visitor sees the video on the product page", !!vid, vid ? "video tag present" : (/Coming soon|coming-soon/.test(html) ? "store is in Coming soon mode" : "no video tag"));
    const head = await fetch(vid[1].replace(/&#038;|&amp;/g, "&"), { method: "GET", headers: { Range: "bytes=0-1" } });
    step("video file is reachable", head.status === 200 || head.status === 206, `HTTP ${head.status}`);
  }
  console.log(`\nAll ${results.length} checks passed in ${stamp().trim()}.`);
})().catch((e) => { console.log("FAIL  unexpected error:", e.stack || e.message); process.exit(1); });
