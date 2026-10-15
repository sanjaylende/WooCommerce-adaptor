// Shared helpers for the WooCommerce journey scripts (Playwright from the Magento uitest folder, Chrome headless).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('D:/Magento-Vanilla/docker/uitest/node_modules/playwright-core');

const E = { ...process.env, MSYS_NO_PATHCONV: '1' };
const WP = 'http://localhost:8085';
const DIR = __dirname;

// Reads only the two WP admin values from the local, git-ignored env file; they are never printed.
function wpCreds() {
  const txt = fs.readFileSync(path.join(DIR, '..', 'infra', 'woocommerce', '.env'), 'utf8');
  const get = (k) => (txt.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
  return { user: (get('WP_ADMIN_USER') || 'admin').trim(), pass: (get('WP_ADMIN_PASSWORD') || '').trim() };
}
// The adapter's database is its own schema in the shared PostgreSQL: query it with the local psql as the owner role (from the adapter's .env).
function adapterDb() {
  const txt = fs.readFileSync(path.join(DIR, '..', '.env'), 'utf8');
  const get = (k) => (txt.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
  // The regression harness passes the scratch database it created (QA_DB_ADMIN_URL / QA_DB_SCHEMA); otherwise the adapter's own .env.
  const u = new URL((process.env.QA_DB_ADMIN_URL || get('DATABASE_ADMIN_URL') || '').trim());
  return { host: u.hostname, port: u.port || '5432', user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1), schema: (process.env.QA_DB_SCHEMA || get('DB_SCHEMA') || 'woocommerce_adapter').trim() };
}
const sql = (q) => {
  const d = adapterDb();
  // "app.bypass" lets this staff-like session see every tenant (row-level security is forced on the tables); its "on" answer is dropped.
  const out = execFileSync('C:/Program Files/PostgreSQL/17/bin/psql.exe', ['-h', d.host, '-p', d.port, '-U', d.user, '-d', process.env.QA_DB || d.database, '-At', '-q', '-v', 'ON_ERROR_STOP=1'],
    { input: "select set_config('app.bypass','on',false);\n" + q, encoding: 'utf8', env: { ...E, PGPASSWORD: d.password, PGOPTIONS: '-c search_path=' + d.schema } });
  return out.replace(/^on\r?\n/, '').trim();
};
const maria = (q) => execFileSync('docker', ['exec', '-i', 'woocommerce-local-db-1', 'sh', '-c', 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE" -N'], { input: q, encoding: 'utf8', env: E }).trim();

function reporter() {
  const results = [];
  const ok = (l, c, x = '') => { results.push({ step: l, pass: !!c, detail: String(x).slice(0, 300) }); console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? '  [' + String(x).slice(0, 300) + ']' : ''}`); };
  return { results, ok };
}

async function launch() {
  const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  return { b, ctx, page };
}

async function login(page) {
  const { user, pass } = wpCreds();
  await page.goto(`${WP}/wp-login.php`, { waitUntil: 'domcontentloaded' });
  await page.fill('#user_login', user);
  await page.fill('#user_pass', pass);
  await page.click('#wp-submit');
  await page.waitForSelector('#wpadminbar', { timeout: 60000 });
}

module.exports = { E, WP, DIR, sql, maria, reporter, launch, login, fs, path, execFileSync };
