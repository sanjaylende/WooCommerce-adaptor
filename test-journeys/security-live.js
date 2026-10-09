// Live security behaviour of the RUNNING hardened adapter (http://localhost:4300, development mode, real PostgreSQL).
// A fake WooCommerce (from test/helpers.js, on 127.0.0.1:45224) is used to register two throwaway installations.
// Throwaway staff users are created directly in the database and deleted at the end; the throwaway installations are
// soft-disabled (status 'uninstalled'). The real test installation (the Docker store on :8085) is never touched.
const crypto = require('crypto');
const h = require('../test/helpers');
const { sql, reporter } = require('./common');
const { results, ok } = reporter();
const BASE = 'http://localhost:4300';
const FAKE = `http://127.0.0.1:${h.WOO_PORT}`;
const RUN = crypto.randomBytes(3).toString('hex');
const scrypt = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return `scrypt:${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`; };
const post = (p, body, headers = {}) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });
const form = (p, f, cookie) => fetch(BASE + p, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(f) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const fake = await h.startFakeWooCommerce();
  const staff = [`lock-${RUN}@throwaway.test`, `csrf-${RUN}@throwaway.test`];
  let A, B;
  try {
    // ---- two throwaway installations (store A = site root, store B = /shop2) ----
    const reg = (suffix, name) => post('/api/v1/register', { baseUrl: FAKE + suffix, consumerKey: 'good-key', consumerSecret: 'good-secret', merchantName: `${name} ${RUN}`, contactEmail: `t-${RUN}@throwaway.test`, countryCode: 'IN' });
    const ra = await reg('', 'Throwaway A'), rb = await reg('/shop2', 'Throwaway B');
    A = await ra.json(); B = await rb.json();
    ok('0. register two throwaway installations through the fake store', ra.status === 201 && rb.status === 201, `${ra.status}/${rb.status}`);
    const callA = h.signedClient({ installKey: A.installKey, secret: A.secret, websiteId: 1, baseUrl: BASE });
    const callB = h.signedClient({ installKey: B.installKey, secret: B.secret, websiteId: 1, baseUrl: BASE });

    // ---- signature, replay, expiry ----
    const bad = await callA('GET', '/api/products', undefined, { badSignature: true });
    ok('1. bad signature -> 401', bad.status === 401, bad.status);
    const nonce = crypto.randomUUID();
    const first = await callA('GET', '/api/bootstrap', undefined, { nonce });
    const again = await callA('GET', '/api/bootstrap', undefined, { nonce });
    ok('2. replayed nonce -> 401 (first use accepted)', first.status === 200 && again.status === 401, `${first.status} then ${again.status}`);
    const old = await callA('GET', '/api/bootstrap', undefined, { ts: Math.floor(Date.now() / 1000) - 3600 });
    const future = await callA('GET', '/api/bootstrap', undefined, { ts: Math.floor(Date.now() / 1000) + 3600 });
    ok('3. expired (and far-future) timestamp -> 401', old.status === 401 && future.status === 401, `${old.status}/${future.status}`);

    // ---- body limits ----
    const r1 = await post('/api/session', { launch: 'x'.repeat(10 * 1024) });
    const r2 = await callA('POST', '/api/generate', { uniqueTag: 'woo-1-novariant', videoType: 'hero_product', prompt: 'x'.repeat(200 * 1024) });
    const r3 = await post('/api/session', { launch: 'x'.repeat(2 * 1024 * 1024) });
    ok('4. body above the route limit -> 413 (session 10 KB, generate 200 KB, 2 MB)', r1.status === 413 && r2.status === 413 && r3.status === 413, `${r1.status}/${r2.status}/${r3.status}`);

    // ---- validation ----
    const u1 = await callA('POST', '/api/v1/ping', { extensionVersion: '1', role: 'admin' });
    ok('5. unknown JSON field -> 400', u1.status === 400, u1.status);
    const pol = await callA('POST', '/api/prompt-default', JSON.parse('{"uniqueTag":"woo-1-novariant","videoType":"hero_product","__proto__":{"isAdmin":true}}'));
    const pol2 = await callA('POST', '/api/prompt-default', JSON.parse('{"uniqueTag":"woo-1-novariant","videoType":"hero_product","constructor":{"prototype":{"x":1}}}'));
    ok('6. prototype-pollution body (__proto__, constructor) -> 400', pol.status === 400 && pol2.status === 400, `${pol.status}/${pol2.status}`);
    const rawPolluted = await fetch(BASE + '/api/v1/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"baseUrl":"http://x.test","consumerKey":"k","consumerSecret":"s","__proto__":{"admin":true}}' });
    ok('6b. same on the unauthenticated register route (raw JSON with __proto__) -> 400', rawPolluted.status === 400, rawPolluted.status);

    // ---- SSRF-looking registration URLs ----
    const ssrf = {};
    for (const u of ['http://169.254.169.254', 'http://127.0.0.1:22', 'file:///etc/passwd', 'ftp://x.example.com']) {
      const r = await post('/api/v1/register', { baseUrl: u, consumerKey: 'k', consumerSecret: 's' });
      ssrf[u] = r.status;
    }
    ok('7. non-http(s) registration URLs (file://, ftp://) -> 400', ssrf['file:///etc/passwd'] === 400 && ssrf['ftp://x.example.com'] === 400, JSON.stringify(ssrf));
    ok('7b. link-local / loopback:22 in DEVELOPMENT mode: allowed by design to be attempted, but never produce a registration (no 201)', ssrf['http://169.254.169.254'] !== 201 && ssrf['http://127.0.0.1:22'] !== 201, `observed ${ssrf['http://169.254.169.254']} / ${ssrf['http://127.0.0.1:22']} (production-mode refusal is covered by test/ssrf.test.js)`);

    // ---- cross-store (RLS) ----
    const tokOf = async (X) => (await (await post('/api/session', { launch: h.launchToken({ installKey: X.installKey, secret: X.secret, websiteId: 1 }) })).json()).token;
    const tA = await tokOf(A), tB = await tokOf(B);
    ok('8. both stores obtain browser sessions from signed launch tokens', !!tA && !!tB);
    const order = await post('/api/billing/checkout', { kind: 'plan', tier: 'starter', cycle: 'monthly', currency: 'USD' }, { Authorization: `Bearer ${tA}` });
    const orderId = (await order.json()).orderId;
    const own = await fetch(`${BASE}/api/billing/orders/${orderId}`, { headers: { Authorization: `Bearer ${tA}` } });
    const other = await fetch(`${BASE}/api/billing/orders/${orderId}`, { headers: { Authorization: `Bearer ${tB}` } });
    ok('9. store B cannot read store A\'s order (own 200, other 404)', order.status === 201 && own.status === 200 && other.status === 404, `${own.status}/${other.status}`);
    const gen = await callA('POST', '/api/generate', { uniqueTag: 'woo-1-novariant', videoType: 'hero_product', aspectRatio: '16:9' });
    let stA;
    for (let i = 0; i < 60; i++) { stA = await callA('GET', '/api/status/woo-1-novariant/hero_product'); if (/"status":"ready"/.test(JSON.stringify(stA.body))) break; await sleep(2000); }
    const _unused = await callA('GET', '/api/status/woo-1-novariant/hero_product');
    const stB = await callB('GET', '/api/status/woo-1-novariant/hero_product');
    const linkB = (await callB('GET', '/api/generated/woo-1-novariant/hero_product/download-link')).body.url;
    const linkA = (await callA('GET', '/api/generated/woo-1-novariant/hero_product/download-link')).body.url;
    const dlA = await fetch(BASE + linkA);
    const dlB = await fetch(BASE + linkB);
    const aBytes = (await dlA.arrayBuffer()).byteLength;
    await dlB.arrayBuffer();
    const verB = await callB('GET', '/api/generated/woo-1-novariant/hero_product/versions');
    const vid = (x) => JSON.stringify(x.body).slice(0, 90);
    const aSees = stA.status === 200 && /"status":"ready"/.test(JSON.stringify(stA.body)) && dlA.status === 200 && aBytes > 1000;
    ok('10. store B cannot see/download/list store A\'s video of the same tag', gen.status < 300 && aSees && !/"ready"|generating|processing|queued/.test(JSON.stringify(stB.body)) && dlB.status >= 400 && !/"id"/.test(JSON.stringify(verB.body)), `gen ${gen.status}; A status ${stA.status} ${vid(stA)}; B status ${stB.status} ${vid(stB)}; A download ${dlA.status} (${aBytes} bytes) vs B download via B-signed link ${dlB.status}; B versions ${verB.status} ${vid(verB)}`);

    // ---- staff lock-out and CSRF ----
    for (const e of staff) sql(`insert into admin_users (email, password_hash, role) values ('${e}', '${scrypt('Right-pass-9')}', 'admin') on conflict (email) do update set failed_attempts=0, locked_until=null`);
    let statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await form('/admin/login', { email: staff[0], password: 'wrong-' + i })).status);
    const lockedRight = await form('/admin/login', { email: staff[0], password: 'Right-pass-9' });
    const cookieLocked = lockedRight.headers.getSetCookie().find((c) => c.startsWith('fl_admin='));
    const lockRow = sql(`select failed_attempts, (locked_until > now()) from admin_users where email='${staff[0]}'`);
    ok('11. 6 wrong passwords -> account locked; the correct password is still refused (401, no session cookie)', statuses.every((s) => s === 401) && lockedRight.status === 401 && !cookieLocked && /\|t$/.test(lockRow), `wrong=${statuses.join(',')} right=${lockedRight.status} row=${lockRow}`);
    const instId = sql(`select id from installations where install_key='${A.installKey}'`);
    const login = await form('/admin/login', { email: staff[1], password: 'Right-pass-9' });
    const cookie = (login.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('fl_admin=')) || '');
    const noCsrf = await form(`/admin/installations/${instId}/status`, { status: 'suspended' }, cookie);
    const badCsrf = await form(`/admin/installations/${instId}/status`, { status: 'suspended', _csrf: 'deadbeef' }, cookie);
    ok('12. admin POST with missing / invalid CSRF token -> 403 (signed in as staff)', login.status === 302 && !!cookie && noCsrf.status === 403 && badCsrf.status === 403, `login ${login.status}; ${noCsrf.status}/${badCsrf.status}`);
    ok('12b. installation status untouched by the refused POSTs', sql(`select count(*) from installations where install_key='${A.installKey}' and status='active'`) === '1');

    // ---- rate limit ----
    let first429 = null, n = 0;
    for (; n < 80; n++) { const r = await post('/api/session', { launch: 'x' }); if (r.status === 429) { first429 = r; break; } }
    ok('13. hammering /api/session from one IP -> 429 with Retry-After', !!first429 && Number(first429.headers.get('retry-after')) >= 1, first429 ? `429 after ${n} more requests, Retry-After ${first429.headers.get('retry-after')}` : 'no 429 in 80 requests');
  } finally {
    // cleanup: throwaway staff deleted, throwaway installations soft-disabled
    try { for (const e of staff) sql(`delete from admin_users where email='${e}'`); } catch (e) { console.log('cleanup staff failed', e.message); }
    try { sql(`update installations set status='uninstalled', uninstalled_at=now() where base_url like '${FAKE}%'`); } catch (e) { console.log('cleanup installations failed', e.message); }
    console.log('cleanup: staff left =', sql(`select count(*) from admin_users where email like '%@throwaway.test'`), '; throwaway installations still active =', sql(`select count(*) from installations where base_url like '${FAKE}%' and status='active'`));
    fake.close();
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
