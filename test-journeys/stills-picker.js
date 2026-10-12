// Real-browser check of the stills picker (Hero Product single pick, Image Transitions four picks), photo upload, and the Lifestyle
// default prompt, in the adapter's iframe inside the WooCommerce admin. Nothing is generated (no credit is used): the modal is
// cancelled before the render step.   node test-journeys/stills-picker.js   (store connected, adapter + engine running)
const { WP, DIR, reporter, launch, login, path, fs } = require('./common');
const { results, ok } = reporter();
const shot = (page, n) => page.screenshot({ path: path.join(DIR, n) });

(async () => {
  const { b, page } = await launch();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)));
  const refused = [];
  page.on('response', (r) => { if (r.status() >= 400 && /localhost:4300/.test(r.url())) refused.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
  try {
    await login(page);
    await page.goto(`${WP}/wp-admin/admin.php?page=flipick-video-generator`, { waitUntil: 'domcontentloaded' });
    const frameEl = await page.waitForSelector('iframe[title="Flipick Video Generator"]', { timeout: 60000 });
    const frame = await frameEl.contentFrame();
    await frame.waitForFunction(() => typeof openPlanModal === 'function' && document.querySelectorAll('button').length > 3, null, { timeout: 120000 });
    ok('1. Generator loads in the admin iframe', true);

    // ---- Hero Product: a single pick from the product's own photos
    await frame.locator('button', { hasText: 'Generate video' }).first().click();
    await frame.waitForSelector('.modal', { timeout: 30000 });
    await frame.locator('.video-type-option', { hasText: 'Hero Product' }).locator('input').check();
    const go = frame.locator('.modal button.btn-primary', { hasText: /Generate/ }).first();
    await page.waitForTimeout(1500);
    await go.click();
    await frame.waitForSelector('#productImagesRoot .preview-tile', { timeout: 30000 });
    const tiles = frame.locator('#productImagesRoot .preview-tile');
    ok('2. Hero Product shows the product\'s own photos as tiles', (await tiles.count()) >= 1, (await tiles.count()) + ' tile(s)');
    await frame.waitForFunction(() => [...document.querySelectorAll('#productImagesRoot .preview-tile img')].every((i) => i.complete), null, { timeout: 20000 }).catch(() => {});
    const loaded = await frame.evaluate(() => [...document.querySelectorAll('#productImagesRoot .preview-tile img')].map((i) => i.complete && i.naturalWidth > 0));
    ok('3. Every photo tile actually loads (shown through the /img proxy)', loaded.length > 0 && loaded.every(Boolean), JSON.stringify(loaded));
    await shot(page, 'sp-1-hero-photos.png');
    await tiles.first().click();
    const badge = (await frame.locator('#productImagesRoot .preview-tile.selected .still-badge').first().innerText().catch(() => '')).trim();
    ok('4. Clicking a tile selects it with a check mark (single pick, no order number)', badge === '✓', JSON.stringify(badge));
    if ((await tiles.count()) > 1) {
      await tiles.nth(1).click();
      ok('5. Clicking another tile swaps the selection instead of refusing', (await frame.locator('#productImagesRoot .preview-tile.selected').count()) === 1);
    } else ok('5. Clicking another tile swaps the selection (single photo on this product: skipped)', true);

    // ---- upload a photo from the computer
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const before = await tiles.count();
    await frame.locator('#stillUploadInput').setInputFiles({ name: 'my photo.png', mimeType: 'image/png', buffer: png });
    await frame.waitForFunction((n) => document.querySelectorAll('#productImagesRoot .preview-tile:not(.uploading-tile)').length > n, before, { timeout: 30000 });
    const uploadedSrc = await frame.evaluate(() => [...document.querySelectorAll('#productImagesRoot .preview-tile img')].pop().getAttribute('src'));
    ok('6. Uploading a photo adds a tile served from the adapter (/up/<signed link>)', /^\/up\//.test(uploadedSrc), uploadedSrc.slice(0, 40));
    await frame.waitForFunction(() => { const i = [...document.querySelectorAll('#productImagesRoot .preview-tile img')].pop(); return i && i.complete; }, null, { timeout: 15000 }).catch(() => {});
    const okImg = await frame.evaluate(() => { const i = [...document.querySelectorAll('#productImagesRoot .preview-tile img')].pop(); return i.complete && i.naturalWidth === 1; });
    ok('7. The uploaded photo renders in the browser', okImg);
    // a non-image is refused with a message, no tile is left behind
    const count = await frame.locator('#productImagesRoot .preview-tile').count();
    await frame.locator('#stillUploadInput').setInputFiles({ name: 'evil.png', mimeType: 'image/png', buffer: Buffer.from('<html><script>alert(1)</script></html>') });
    await page.waitForTimeout(2500);
    ok('8. A file that is not a real image is refused and leaves no broken tile', (await frame.locator('#productImagesRoot .preview-tile').count()) === count);
    await shot(page, 'sp-2-hero-upload.png');

    // ---- Back, then Image Transitions: up to four photos in order
    await frame.locator('.modal button', { hasText: 'Back' }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    await frame.locator('.modal button', { hasText: /Cancel/ }).first().click().catch(() => {});
    await page.waitForTimeout(500);
    await frame.locator('button', { hasText: 'Generate video' }).first().click();
    await frame.waitForSelector('.modal', { timeout: 30000 });
    await frame.locator('.video-type-option', { hasText: 'Image Transitions' }).locator('input').check();
    await page.waitForTimeout(1500);
    await frame.locator('.modal button.btn-primary', { hasText: /Generate/ }).first().click();
    await frame.waitForSelector('#productImagesRoot .preview-tile', { timeout: 30000 });
    await frame.locator('#stillUploadInput').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: png });
    await frame.locator('#stillUploadInput').setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: png });
    await page.waitForTimeout(2500);
    const all = frame.locator('#productImagesRoot .preview-tile:not(.uploading-tile)');
    const n = await all.count();
    for (let i = 0; i < Math.min(n, 4); i++) await all.nth(i).click();
    const numbers = await frame.locator('#productImagesRoot .preview-tile.selected .still-badge').allInnerTexts();
    ok('9. Image Transitions numbers the selected tiles in order (up to 4)', numbers.length === Math.min(n, 4) && numbers.join(',') === ['1', '2', '3', '4'].slice(0, numbers.length).join(','), numbers.join(','));
    await shot(page, 'sp-3-transitions.png');
    await frame.locator('.modal button', { hasText: 'Back' }).first().click().catch(() => {});
    await frame.locator('.modal button', { hasText: /Cancel/ }).first().click().catch(() => {});

    // ---- Lifestyle: the Prompt field defaults to the real prompt
    await page.waitForTimeout(500);
    await frame.locator('button', { hasText: 'Generate video' }).first().click();
    await frame.waitForSelector('.modal', { timeout: 30000 });
    await frame.locator('.video-type-option', { hasText: 'Lifestyle' }).locator('input').check();
    await page.waitForTimeout(4000);
    const prompt = await frame.locator('.modal textarea').first().inputValue().catch(() => '');
    const real = prompt.split(/\s+/).length > 12;
    ok('10. Lifestyle\'s Prompt field is filled (' + (real ? 'the engine\'s real prompt' : 'old category placeholder: this engine has no /default-prompt yet') + ')', prompt.trim().length > 0, prompt.slice(0, 90).replace(/\s+/g, ' '));
    const generateEnabled = await frame.locator('.modal button.btn-primary', { hasText: /Generate/ }).first().isEnabled();
    ok('10b. The Generate button is enabled once the default prompt has loaded', generateEnabled);
    await shot(page, 'sp-4-lifestyle.png');
    // ---- a merchant who leaves the picker while the photos are still loading must not cause an error
    await frame.locator('.modal button', { hasText: /Cancel/ }).first().click().catch(() => {});
    await page.waitForTimeout(500);
    await frame.locator('button', { hasText: 'Generate video' }).first().click();
    await frame.waitForSelector('.modal', { timeout: 30000 });
    await frame.locator('.video-type-option', { hasText: 'Hero Product' }).locator('input').check();
    await page.waitForTimeout(1500);
    await frame.locator('.modal button.btn-primary', { hasText: /Generate/ }).first().click();
    await frame.locator('.modal button', { hasText: /^Back$/ }).first().click({ timeout: 5000 }).catch(() => {}); // straight away, before the photos arrive
    await page.waitForTimeout(3000);
    ok('10c. Leaving the picker while photos are still loading causes no error', pageErrors.length === 0, pageErrors.join(' | '));
    ok('11. No JavaScript errors in the page', pageErrors.length === 0, pageErrors.join(' | '));
    const unexpected = refused.filter((r) => !/^415 POST \/api\/upload-still-image/.test(r)); // the one deliberate refusal: the fake image in step 8
    ok('12. The adapter refused nothing except the deliberately bad upload', unexpected.length === 0 && refused.length === 1, refused.join(' | '));
  } catch (err) {
    ok('UNEXPECTED: ' + err.message.split('\n')[0], false);
    await shot(page, 'sp-error.png').catch(() => {});
  } finally {
    await b.close();
    fs.writeFileSync(path.join(DIR, 'stills-picker-results.json'), JSON.stringify(results, null, 2));
    const bad = results.filter((r) => !r.pass).length;
    console.log(bad ? `\n${bad} FAILED` : '\nAll stills-picker checks passed.');
    process.exit(bad ? 1 : 0);
  }
})();
