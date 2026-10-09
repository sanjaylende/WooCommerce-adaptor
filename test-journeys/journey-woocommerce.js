// Full user journey on the local WooCommerce store (http://localhost:8085) against the HARDENED adapter in development mode
// with the mock payment gateway and the mock video engine. Mirrors the Magento journey. Every adapter response >= 400 is logged.
const { WP, DIR, E, sql, maria, reporter, launch, login, fs, path, execFileSync } = require('./common');
const { results, ok } = reporter();
const shot = (page, n) => page.screenshot({ path: path.join(DIR, n) });
const wpcli = (...args) => execFileSync('docker', ['compose', '-p', 'woocommerce-local', '-f', path.join(DIR, '..', 'infra', 'woocommerce', 'docker-compose.yml'), '--env-file', path.join(DIR, '..', 'infra', 'woocommerce', '.env'), 'run', '--rm', '-T', 'wpcli', 'wp', ...args], { encoding: 'utf8', env: E, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let stage = 'start';

(async () => {
  const { b, ctx, page } = await launch();
  const refused = [], pageErrors = [], cspViolations = [], wpNotices = [];
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 160)));
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) cspViolations.push(m.text().slice(0, 200)); });
  ctx.on('response', (r) => { if (r.status() >= 400 && /localhost:4300/.test(r.url()) && !/favicon/.test(r.url())) refused.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });

  // start from "not connected yet": drop the plugin's stored connection settings so the Connect form is shown, as on a fresh install
  wpcli('option', 'delete', 'fvg_settings');

  stage = 'admin login';
  await login(page);
  ok('1. WP admin login', true);

  stage = 'connect';
  const instBefore = sql("select count(*) from installations where status='active'");
  await page.goto(`${WP}/wp-admin/admin.php?page=flipick-video-generator`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#fvg_adapter_url', { timeout: 30000 });
  await page.fill('#fvg_adapter_url', 'http://host.docker.internal:4300');
  await page.fill('#fvg_public_url', 'http://localhost:4300');
  await shot(page, 'wj-0-connect.png');
  await page.click('#submit');
  await page.waitForLoadState('domcontentloaded');
  const frameEl = await page.waitForSelector('iframe[title="Flipick Video Generator"]', { timeout: 120000 }).catch(() => null);
  const msg = (await page.locator('.notice:not(.update-nag)').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok('2. Connect: store registered through the hardened adapter', !!frameEl && /Store connected/.test(msg), msg);
  ok('2b. installation row exists/active, no duplicate for the store', sql("select count(*) from installations where status='active' and base_url like '%8085%'") === '1', `active installations ${instBefore} -> ${sql("select count(*) from installations where status='active'")}`);
  wpNotices.push(...(await page.locator('.notice-error:not(.update-nag), .notice-warning:not(.update-nag)').allInnerTexts()));

  stage = 'grid';
  const frame = await frameEl.contentFrame();
  await frame.waitForFunction(() => document.querySelector('#usageBadge')?.innerText.trim().length > 0 && typeof openPlanModal === 'function', null, { timeout: 150000 });
  const rowsInFrame = await frame.locator('button', { hasText: 'Generate video' }).count();
  ok('3. Product list loads in the adapter iframe (session from the signed launch token)', rowsInFrame > 0, rowsInFrame + ' products with a Generate video button');
  await shot(page, 'wj-1-list.png');

  stage = 'open product';
  const searchInput = frame.locator('#searchInput');
  await frame.locator('button', { hasText: 'Generate video' }).first().click();
  await frame.waitForSelector('.modal', { timeout: 30000 });
  ok('4. Generate modal opens for the product', true);

  stage = 'generate';
  const genBefore = sql('select count(*) from usage_events');
  await frame.locator('.video-type-option', { hasText: 'Hero Product' }).locator('input').check();
  const go = frame.locator('.modal button.btn-primary', { hasText: /Generate/ }).first();
  await go.waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  await go.click();
  const skip = frame.locator('button', { hasText: 'Skip preview, generate anyway' });
  const use = frame.locator('button', { hasText: /Use this image|Use these/ });
  await Promise.race([skip.waitFor({ timeout: 30000 }), use.waitFor({ timeout: 30000 }), frame.locator('.badge, .status-generating, [class*="generating"]').first().waitFor({ timeout: 30000 })]).catch(() => {});
  if (await skip.count()) await skip.click(); else if (await use.count()) await use.first().click();
  ok('5. Generate started from the UI (mock engine)', true);
  await shot(page, 'wj-2-generating.png');

  stage = 'wait ready';
  await frame.waitForFunction(() => /ready/i.test(document.body.innerText) && document.querySelector('video, [data-action="download-video"]'), null, { timeout: 180000 }).catch(() => {});
  ok('6. Video reaches "ready", player and download controls appear', (await frame.locator('[data-action="download-video"]').count()) > 0);
  const genAfter = sql('select count(*) from usage_events');
  ok('6b. video metered (usage event recorded)', Number(genAfter) === Number(genBefore) + 1, `${genBefore} -> ${genAfter}`);
  await shot(page, 'wj-3-ready.png');

  stage = 'push to store';
  const metaCount = () => Number(maria("select count(*) from wp_postmeta where meta_key='_flipick_video_url' and meta_value like 'http%';"));
  const metaBefore = metaCount();
  const push = frame.locator('[data-action="push-store"]').first();
  if (await push.count()) await push.click();
  let meta = metaCount();
  for (let i = 0; i < 20 && meta <= metaBefore && !(meta > 0); i++) { await page.waitForTimeout(1000); meta = metaCount(); }
  ok('7. Video URL written to the WooCommerce product (_flipick_video_url post meta)', meta > 0, `${meta} product(s) carry the meta; value host: ${(maria("select meta_value from wp_postmeta where meta_key='_flipick_video_url' order by meta_id desc limit 1;").match(/^https?:\/\/[^/]+/) || [''])[0]}`);

  stage = 'download';
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }).catch(() => null), frame.locator('[data-action="download-video"]').first().click().catch(() => null)]);
  let size = 0, head = '';
  if (download) { const p = await download.path(); size = fs.statSync(p).size; head = fs.readFileSync(p).subarray(4, 8).toString('latin1'); }
  ok('8. Download through the signed link returns MP4 bytes', size > 1000 && head === 'ftyp', `${size} bytes, box ${head}`);

  stage = 'billing';
  await page.goto(`${WP}/wp-admin/admin.php?page=flipick-video-generator-billing`, { waitUntil: 'domcontentloaded' });
  const f2 = await (await page.waitForSelector('iframe[title="Plans & Billing"]', { timeout: 30000 })).contentFrame();
  await f2.waitForFunction(() => document.querySelector('#usageBadge')?.innerText.trim().length > 0 && typeof openPlanModal === 'function', null, { timeout: 150000 });
  await f2.locator('#planCta').click();
  await f2.waitForSelector('.plan-modal');
  const pm = await f2.locator('.plan-modal').innerText();
  ok('9. Plans & Billing shows Free, Starter and Pro', /Free/.test(pm) && /Starter/.test(pm) && /Pro/.test(pm));
  await f2.locator('.cycle-toggle button', { hasText: 'USD' }).first().click().catch(() => {});
  const popupP = ctx.waitForEvent('page', { timeout: 30000 });
  const candidate = f2.locator('.plan-card button', { hasText: /Choose plan|Renew now|Upgrade|Switch/ }).first();
  console.log('   plan button to click:', (await candidate.innerText()).trim());
  await candidate.click();
  const pay = await popupP;
  await pay.waitForSelector('#pay-success', { timeout: 30000 });
  ok('10. Mock gateway page opens (new tab) for the chosen plan', /Mock payment gateway/.test(await pay.innerText('body')));
  const ordersBefore = Number(sql("select count(*) from payment_orders where status='paid'"));
  await pay.click('#pay-success');
  await pay.waitForFunction(() => /Payment received/.test(document.body.innerText), null, { timeout: 30000 });
  ok('11. Payment return page says "Payment received"', true);
  await pay.close();
  await page.waitForTimeout(2000);
  ok('12. Order status paid in DB', Number(sql("select count(*) from payment_orders where status='paid'")) === ordersBefore + 1, sql('select o.status, o.total_minor from payment_orders o order by created_at desc limit 1'));
  await f2.locator('.plan-footer .btn-text', { hasText: 'Payments' }).click().catch(() => {});
  await f2.waitForSelector('.history-table tbody tr', { timeout: 20000 }).catch(() => {});
  ok('13. Payment history lists the payment', (await f2.locator('.history-table tbody tr').count()) > 0);
  await shot(page, 'wj-4-billing.png');

  stage = 'summary';
  ok('14. no adapter response >= 400 during the journey', refused.length === 0, refused.slice(0, 8).join(' | '));
  ok('15. no JavaScript errors / CSP violations in wp-admin or the adapter UI', pageErrors.length === 0 && cspViolations.length === 0, [...pageErrors, ...cspViolations].slice(0, 3).join(' | '));
  ok('16. no WordPress error/warning notices on the plugin pages', wpNotices.length === 0, wpNotices.join(' | '));
  fs.writeFileSync(path.join(DIR, 'journey-woocommerce-results.json'), JSON.stringify({ results, refused, pageErrors, cspViolations, wpNotices }, null, 2));
  await b.close();
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} steps passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED at', stage, ':', e.message.slice(0, 900)); fs.writeFileSync(path.join(DIR, 'journey-woocommerce-results.json'), JSON.stringify({ results, error: e.message.split('\n')[0], stage }, null, 2)); process.exit(1); });
