// Failure-path checks on the live second store: every mistake must produce a readable message and leave no debris.
const base = process.env.WP_URL || "http://localhost:8087";
const jar = new Map();
async function http(url, o = {}) { const c = [...jar].map(([k, v]) => `${k}=${v}`).join("; "); const r = await fetch(url, { redirect: "manual", ...o, headers: { ...(o.headers || {}), ...(c ? { Cookie: c } : {}) } }); for (const s of r.headers.getSetCookie?.() || []) { const [kv] = s.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); } return r; }
const post = (u, o) => http(u, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const nonce = (h, a) => { const m = h.replace(/\s+/g, " ").match(new RegExp(`value="${a}"[^>]*>[^>]*?_wpnonce" value="([a-z0-9]+)"`)); return m && m[1]; };
const msg = (r) => decodeURIComponent(((r.headers.get("location") || "").match(/fvg_msg=([^&]*)/) || [, ""])[1].replace(/\+/g, " "));
let bad = 0; const check = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -- " + d : ""}`); if (!ok) bad++; };
(async () => {
  jar.set("wordpress_test_cookie", "WP%20Cookie%20check");
  await http(base + "/wp-login.php"); await post(base + "/wp-login.php", { log: "admin", pwd: "change-me-admin", "wp-submit": "Log In", testcookie: "1" });
  const page = async () => (await http(base + "/wp-admin/admin.php?page=flipick-video-generator")).text();
  let h = await page();
  // connected now: disconnect to test connect failures
  await post(base + "/wp-admin/admin-post.php", { action: "fvg_disconnect", _wpnonce: nonce(h, "fvg_disconnect") });
  h = await page();
  const tryConnect = async (adapter_url) => { h = await page(); return post(base + "/wp-admin/admin-post.php", { action: "fvg_connect", _wpnonce: nonce(h, "fvg_connect"), adapter_url, public_url: "" }); };
  let r = await tryConnect("http://host.docker.internal:4999");
  check("adapter not running -> readable error", /Could not connect/.test(msg(r)) && /reach/.test(msg(r)), msg(r));
  r = await tryConnect("not a url");
  check("garbage URL -> readable error", /valid adapter URL|Could not connect/.test(msg(r)), msg(r));
  r = await tryConnect("ftp://host.docker.internal:4300");
  check("non-http URL refused", /valid adapter URL/.test(msg(r)), msg(r));
  r = await tryConnect("http://host.docker.internal:80");
  check("something that is not the adapter -> readable error", /Could not connect/.test(msg(r)), msg(r));
  h = await page();
  check("still shows the connect form (nothing half-connected)", /Connect store/.test(h) && !/Connected on/.test(h));
  const { execSync } = require("child_process");
  const dbg = execSync("docker compose --env-file .env run --rm -T wpcli wp eval-file /seed/debris.php", { env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).toString().split(/\r?\n/).find((l) => l.startsWith("DEBRIS")).slice(7).trim();
  check("failed attempts left no webhooks or API keys behind", dbg === "0 0", `webhooks/keys = ${dbg}`);
  // an unauthenticated visitor / wrong nonce
  r = await post(base + "/wp-admin/admin-post.php", { action: "fvg_connect", _wpnonce: "bad", adapter_url: "http://host.docker.internal:4300" });
  check("forged request (bad nonce) is refused", r.status === 403 || r.status === 302 && !/connected/i.test(msg(r)), `HTTP ${r.status}`);
  jar.clear();
  r = await http(base + "/wp-admin/admin-post.php", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "action=fvg_connect&adapter_url=http://x" });
  check("logged-out visitor cannot connect", r.status === 400 || r.status === 302 && /wp-login/.test(r.headers.get("location") || "") || r.status === 403, `HTTP ${r.status}`);
  console.log(bad ? `\n${bad} FAILED` : "\nAll failure-path checks passed.");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log("FAIL", e.stack); process.exit(1); });
