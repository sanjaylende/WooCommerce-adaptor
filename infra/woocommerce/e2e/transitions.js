// Image Transitions end to end with the REAL video engine, using photos uploaded to the adapter: the product's own photo plus three
// uploads (each hosted by the adapter behind a signed /up link that the engine fetches). Renders one 8 second clip (uses one video).
//   WP_URL=http://localhost:8085 node e2e/transitions.js
const fs = require('fs');
const path = require('path');
const base = process.env.WP_URL || 'http://localhost:8085';
const adapter = process.env.ADAPTER_URL || 'http://localhost:4300';
const user = process.env.WP_USER || 'admin';
const pass = process.env.WP_PASS || (() => { const t = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8'); return (t.match(/^WP_ADMIN_PASSWORD=(.*)$/m) || [])[1].trim(); })();
const jar = new Map();
const t0 = Date.now();
const log = (ok, name, d = '') => { console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s ${ok ? 'PASS' : 'FAIL'}  ${name}${d ? '  -- ' + d : ''}`); if (!ok) process.exit(1); };
async function http(url, o = {}) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch(url, { redirect: 'manual', ...o, headers: { ...(o.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
  for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  return r;
}
(async () => {
  jar.set('wordpress_test_cookie', 'WP%20Cookie%20check');
  await http(base + '/wp-login.php');
  await http(base + '/wp-login.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ log: user, pwd: pass, 'wp-submit': 'Log In', testcookie: '1' }).toString() });
  const page = await (await http(base + '/wp-admin/admin.php?page=flipick-video-generator')).text();
  const src = (page.match(/<iframe[^>]*src="([^"]+)"/) || [])[1].replace(/&#038;|&amp;/g, '&');
  const session = await (await fetch(adapter + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ launch: new URL(src).searchParams.get('launch') }) })).json();
  const auth = { Authorization: 'Bearer ' + session.token };
  const api = async (m, p, b) => { const r = await fetch(adapter + p, { method: m, headers: { ...auth, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const boot = await api('GET', '/api/bootstrap');
  const product = boot.body.products.find((p) => /Apples/.test(p.name));
  log(!!product, 'product found', product.uniqueTag);
  const photos = await api('GET', `/api/product-images/${product.uniqueTag}`);
  log(photos.status === 200 && photos.body.images.length >= 1, 'product photos listed', photos.body.images.map((i) => i.displayUrl.slice(0, 12)).join(','));
  const urls = [photos.body.images[0].url];
  for (const f of ['DAI-MLK-001.jpg', 'BAK-BRD-001.jpg', 'FRU-BAN-001.jpg']) {
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'seed', 'images', f));
    const r = await fetch(`${adapter}/api/upload-still-image?uniqueTag=${encodeURIComponent(product.uniqueTag)}&filename=${f}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'image/jpeg' }, body: bytes });
    const body = await r.json();
    log(r.status === 200 && /\/up\//.test(body.url), `upload ${f}`, `${bytes.length} bytes -> ${body.url ? body.url.slice(0, 50) : JSON.stringify(body)}`);
    const back = await fetch(body.url);
    log(back.status === 200 && back.headers.get('content-type') === 'image/jpeg', 'the engine-facing link serves the image', `HTTP ${back.status}`);
    urls.push(body.url);
  }
  const g = await api('POST', '/api/generate', { uniqueTag: product.uniqueTag, videoType: 'image_transition', aspectRatio: '16:9', startImageUrls: urls, prompt: 'Slow, smooth transitions between the four product photos' });
  log(g.status === 200, 'start Image Transitions render', JSON.stringify(g.body));
  const started = Date.now();
  let st = {};
  while (Date.now() - started < 12 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 10000));
    st = (await api('GET', `/api/status/${product.uniqueTag}/image_transition`)).body;
    if (st.status === 'ready' || st.status === 'error') break;
  }
  log(st.status === 'ready', 'render finishes', `${st.status} after ${Math.round((Date.now() - started) / 1000)}s ${st.error || ''}`);
  const video = await fetch(st.videoUrl, { headers: { Range: 'bytes=0-1' } });
  log(video.status === 200 || video.status === 206, 'the video file is reachable', `HTTP ${video.status}`);
  console.log('\nImage Transitions with adapter-hosted uploads works end to end.');
})().catch((e) => { console.log('FAIL unexpected:', e.stack || e.message); process.exit(1); });
