'use strict';
/*
 * End-to-end browser checks for ARM64 Compatibility Radar.
 *
 * Run:
 *   npm ci
 *   npm run test:browser
 *
 * Browser selection (optional env):
 *   PW_CHANNEL=chrome    use the locally installed Chrome (default on dev machines)
 *   PW_CHANNEL=msedge    use the locally installed Edge
 *   PW_CHANNEL=bundled   force the Playwright-bundled Chromium
 *   unset + CI=true      bundled Chromium (CI: npx playwright install chromium)
 *
 * Every check runs in its own isolated browser context. The app is opened both
 * via file:// (primary usage) and through a loopback-only static server that
 * serves a fixed allowlist of files (hosted-compatibility check). Each context
 * asserts that no request leaves file:// or the loopback origin.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const ARTIFACTS = path.join(ROOT, 'test-results');
const FILE_URL = pathToFileURL(path.join(ROOT, 'index.html')).href;
const SERVE_ALLOWLIST = ['index.html', 'style.css', 'catalog.js'];
const TEST_TIMEOUT_MS = 60_000;

function launchOptions() {
  const channel = process.env.PW_CHANNEL;
  if (channel === 'bundled' || channel === '') return {};
  if (channel) return { channel };
  return process.env.CI ? {} : { channel: 'chrome' };
}

async function launchBrowser() {
  const { chromium } = require('playwright');
  return chromium.launch(launchOptions());
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
    };
    const server = http.createServer((req, res) => {
      let name;
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        name = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      } catch {
        res.writeHead(400); res.end('bad request'); return;
      }
      if (name === 'favicon.ico') { res.writeHead(204); res.end(); return; } // browsers auto-request this; the app ships none
      if (!SERVE_ALLOWLIST.includes(name)) { res.writeHead(404); res.end('not found'); return; }
      try {
        const body = fs.readFileSync(path.join(ROOT, name));
        res.writeHead(200, {
          'content-type': types[path.extname(name)] || 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(body);
      } catch {
        res.writeHead(500); res.end('error');
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function trackOffsiteRequests(context, allowedPrefixes) {
  const offsite = [];
  context.on('request', (request) => {
    const url = request.url();
    if (!allowedPrefixes.some((prefix) => url.startsWith(prefix))) offsite.push(url);
  });
  return offsite;
}

function trackPageErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  return errors;
}

async function readDownload(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${TEST_TIMEOUT_MS} ms`)), TEST_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/*
 * setInputFiles dispatches change without waiting for async handlers, so wait
 * for the app's own end state before asserting (no arbitrary sleeps).
 */
const waitForMessage = (page, pattern) =>
  page.waitForFunction(
    ([source, flags]) => new RegExp(source, flags).test(document.getElementById('message').textContent),
    [pattern.source, pattern.flags],
    { timeout: 10_000 },
  );

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('file:// load renders bundled fictional samples without off-site requests', async (context) => {
  const offsite = trackOffsiteRequests(context, ['file://', 'blob:', 'data:']);
  const page = await context.newPage();
  const errors = trackPageErrors(page);
  await page.goto(FILE_URL);
  assert.equal(await page.locator('#rows tr').count(), 2);
  assert.match(await page.locator('#count').textContent(), /^2 of 2 records · 2 fictional samples$/);
  assert.match(await page.locator('#message').textContent(), /fictional sample records/);
  const rowText = await page.locator('#rows').textContent();
  assert.ok(rowText.includes('SAMPLE'), 'sample rows are tagged SAMPLE');
  await page.screenshot({ path: path.join(ARTIFACTS, 'radar-file.png'), fullPage: true });
  assert.deepEqual(offsite, [], 'no requests outside file://');
  assert.deepEqual(errors, [], 'no page or console errors');
});

test('search and filters narrow the table', async (context) => {
  const page = await context.newPage();
  await page.goto(FILE_URL);
  await page.fill('#q', 'usb');
  assert.equal(await page.locator('#rows tr').count(), 1);
  assert.match(await page.locator('#rows').textContent(), /Example USB adapter/);
  await page.fill('#q', '');
  await page.selectOption('#type', 'app');
  assert.equal(await page.locator('#rows tr').count(), 1);
  assert.match(await page.locator('#rows').textContent(), /Example native editor/);
  await page.selectOption('#type', 'all');
  await page.selectOption('#status', 'reported');
  assert.match(await page.locator('#rows').textContent(), /No matching records/);
  await page.selectOption('#status', 'all');
  await page.fill('#q', 'zzz-no-match');
  assert.match(await page.locator('#rows').textContent(), /No matching records/);
});

test('add form creates records and shows HTTPS evidence links', async (context) => {
  const page = await context.newPage();
  await page.goto(FILE_URL);
  await page.fill('#name', 'Synthetic added app');
  await page.fill('#version', 'Fixture 9.9');
  await page.fill('#arch', 'ARM64');
  await page.click('#add button');
  assert.equal(await page.locator('#rows tr').count(), 3);
  assert.match(await page.locator('#count').textContent(), /^3 of 3 records/);
  assert.match(await page.locator('#message').textContent(), /Record added locally/);
  await page.fill('#name', 'Synthetic reported device');
  await page.selectOption('#entry-type', 'device');
  await page.selectOption('#entry-status', 'reported');
  await page.fill('#source', 'https://example.invalid/synthetic-evidence');
  await page.fill('#date', '2026-01-15');
  await page.click('#add button');
  assert.equal(await page.locator('#rows tr').count(), 4);
  assert.ok((await page.locator('#rows .badge').allTextContents()).includes('reported'));
  const link = page.locator('#rows a', { hasText: 'Evidence' });
  assert.equal(await link.count(), 1);
  assert.equal(await link.getAttribute('href'), 'https://example.invalid/synthetic-evidence');
});

test('invalid records are rejected without changing state', async (context) => {
  const page = await context.newPage();
  await page.goto(FILE_URL);
  const beforeCount = await page.locator('#count').textContent();
  await page.fill('#name', 'Synthetic invalid tested record');
  await page.selectOption('#entry-status', 'tested');
  await page.click('#add button');
  assert.match(await page.locator('#message').textContent(), /require a source and date/);
  assert.equal(await page.locator('#rows tr').count(), 2);
  assert.equal(await page.locator('#count').textContent(), beforeCount);
  await page.fill('#source', 'http://example.invalid/evidence');
  await page.fill('#date', '2026-01-15');
  await page.click('#add button');
  assert.match(await page.locator('#message').textContent(), /HTTPS/);
  assert.equal(await page.locator('#rows tr').count(), 2);
  await page.fill('#source', 'https://example.invalid/evidence');
  await page.fill('#date', '');
  await page.click('#add button');
  assert.match(await page.locator('#message').textContent(), /require a source and date/);
  assert.equal(await page.locator('#rows tr').count(), 2);
});

test('import replaces records; malformed imports preserve state', async (context) => {
  const page = await context.newPage();
  await page.goto(FILE_URL);
  await page.setInputFiles('#import', path.join(FIXTURES, 'radar-import.json'));
  await waitForMessage(page, /Imported local catalog\. No data was uploaded\./);
  assert.equal(await page.locator('#rows tr').count(), 3);
  assert.match(await page.locator('#count').textContent(), /^3 of 3 records · 0 fictional samples$/);
  assert.equal(await page.locator('#rows a').count(), 1);
  await page.setInputFiles('#import', path.join(FIXTURES, 'radar-import-malformed.json'));
  await waitForMessage(page, /Unexpected|JSON|token/i);
  assert.equal(await page.locator('#rows tr').count(), 3);
  await page.setInputFiles('#import', path.join(FIXTURES, 'radar-import-bad.json'));
  await waitForMessage(page, /require a source and date/);
  assert.equal(await page.locator('#rows tr').count(), 3);
});

test('export downloads the actual catalog bytes', async (context) => {
  const page = await context.newPage();
  await page.goto(FILE_URL);
  await page.setInputFiles('#import', path.join(FIXTURES, 'radar-import.json'));
  await waitForMessage(page, /Imported local catalog/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  assert.equal(download.suggestedFilename(), 'arm64-catalog.json');
  const raw = await readDownload(download);
  const body = JSON.parse(raw.toString('utf8'));
  assert.equal(body.length, 3);
  assert.deepEqual(body.map((record) => record.id), ['fixture-arm64-app', 'fixture-arm64-device', 'fixture-arm64-tested']);
  assert.equal(body[2].source, 'https://example.invalid/synthetic-evidence');
  assert.ok(body.every((record) => record.sample === false));
  assert.equal(await page.locator('#rows tr').count(), body.length);
  // Round-trip: the exact exported bytes can be re-imported without loss.
  const roundTrip = path.join(ARTIFACTS, 'radar-export-roundtrip.json');
  fs.writeFileSync(roundTrip, raw);
  await page.setInputFiles('#import', roundTrip);
  assert.match(await page.locator('#message').textContent(), /Imported local catalog/);
  assert.equal(await page.locator('#rows tr').count(), 3);
});

test('hosted compatibility: loopback server serves only fixed files', async (context) => {
  const { server, origin } = await startStaticServer();
  try {
    const offsite = trackOffsiteRequests(context, [`${origin}/`, 'blob:', 'data:']);
    const page = await context.newPage();
    const errors = trackPageErrors(page);
    await page.goto(`${origin}/`);
    assert.equal(await page.locator('#rows tr').count(), 2);
    await page.fill('#q', 'usb');
    assert.equal(await page.locator('#rows tr').count(), 1);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
    const body = JSON.parse((await readDownload(download)).toString('utf8'));
    assert.equal(body.length, 2);
    for (const probe of ['/package.json', '/tests/catalog.test.cjs', '/%2e%2e/package.json', '/..%2fpackage.json']) {
      const response = await context.request.get(`${origin}${probe}`);
      assert.equal(response.status(), 404, `expected 404 for ${probe}`);
    }
    assert.deepEqual(offsite, [], 'no requests outside the loopback origin');
    assert.deepEqual(errors, [], 'no page or console errors');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('imported content is escaped, not executed', async (context) => {
  const page = await context.newPage();
  await page.goto(FILE_URL);
  await page.setInputFiles('#import', path.join(FIXTURES, 'radar-import-html.json'));
  await waitForMessage(page, /Imported local catalog/);
  const rowText = await page.locator('#rows').textContent();
  assert.ok(rowText.includes('<img src=x onerror=window.__xss=1>'));
  assert.equal(await page.locator('#rows img').count(), 0);
  assert.equal(await page.locator('#rows script').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await page.fill('#name', '<b>bold?</b>');
  await page.click('#add button');
  assert.equal(await page.locator('#rows b').count(), 0);
  assert.ok((await page.locator('#rows').textContent()).includes('<b>bold?</b>'));
});

test('search ignores missing fields instead of matching the literal "undefined"', async (context) => {
  const page = await context.newPage();
  await page.goto(FILE_URL);
  await page.setInputFiles('#import', path.join(FIXTURES, 'radar-import-no-type.json'));
  await waitForMessage(page, /Imported local catalog/);
  assert.equal(await page.locator('#rows tr').count(), 1);
  await page.fill('#q', 'undefined');
  assert.match(await page.locator('#rows').textContent(), /No matching records/);
});

async function runTests() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const browser = await launchBrowser();
  let failures = 0;
  for (const { name, fn } of tests) {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    try {
      await withTimeout(fn(context), name);
      console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL - ${name}`);
      console.error(error && error.stack ? error.stack : error);
    } finally {
      await context.close();
    }
  }
  await browser.close();
  console.log(`${tests.length - failures}/${tests.length} browser checks passed`);
  process.exit(failures ? 1 : 0);
}

module.exports = { launchBrowser, startStaticServer };

if (require.main === module) {
  runTests().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
