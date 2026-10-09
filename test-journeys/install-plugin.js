// Installs the plugin through wp-admin: Plugins > Add New > Upload Plugin (zip) > Install > (Replace current) > Activate.
const { WP, DIR, reporter, launch, login, path } = require('./common');
const { ok } = reporter();
(async () => {
  const { b, page } = await launch();
  const notices = [];
  page.on('pageerror', (e) => notices.push('pageerror ' + e.message.slice(0, 160)));
  await login(page);
  await page.goto(`${WP}/wp-admin/plugin-install.php?tab=upload`, { waitUntil: 'domcontentloaded' });
  if (!(await page.locator('#pluginzip').count())) await page.click('.upload-view-toggle').catch(() => {});
  await page.setInputFiles('#pluginzip', path.join(DIR, 'flipick-video-generator.zip'));
  await page.click('#install-plugin-submit');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);
  let body = (await page.locator('#wpbody-content').innerText()).replace(/\n+/g, ' | ');
  console.log('AFTER UPLOAD:', body.slice(0, 1500));
  await page.screenshot({ path: path.join(DIR, 'install-1-upload.png') });
  const replace = page.locator('a.update-from-upload-overwrite');
  if (await replace.count()) {
    console.log('Replace-current offered');
    await replace.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    body = (await page.locator('#wpbody-content').innerText()).replace(/\n+/g, ' | ');
    console.log('AFTER REPLACE:', body.slice(0, 1500));
    await page.screenshot({ path: path.join(DIR, 'install-2-replace.png') });
  }
  const act = page.locator('a.button-primary', { hasText: /Activate/i });
  if (await act.count()) { await act.first().click(); await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(2000); console.log('ACTIVATE:', (await page.locator('#wpbody-content').innerText()).replace(/\n+/g, ' | ').slice(0, 600)); }
  await page.goto(`${WP}/wp-admin/plugins.php`, { waitUntil: 'domcontentloaded' });
  const row = await page.locator('tr[data-slug="flipick-video-generator"], tr[data-plugin^="flipick-video-generator"]').innerText();
  console.log('PLUGIN ROW:', row.replace(/\n+/g, ' | '));
  ok('plugin active after UI install', /Deactivate/.test(row));
  await page.screenshot({ path: path.join(DIR, 'install-3-plugins.png') });
  console.log('notices', notices);
  await b.close();
})().catch((e) => { console.error('FAILED', e.message.slice(0, 800)); process.exit(1); });
