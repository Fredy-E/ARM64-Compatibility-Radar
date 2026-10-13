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

test('preview shell: revision tag, honest notice, tokens, no body overflow', async (context) => {
  const page = await context.newPage();
  await page.goto(FILE_URL);
  assert.equal(await page.getAttribute('[data-ui-revision]', 'data-ui-revision'), 'portfolio-preview-1');
  const notice = page.locator('#prototype-notice');
  assert.ok(await notice.isVisible(), 'prototype notice visible');
  const text = await notice.textContent();
  assert.ok(text.includes('Experimental concept prototype — idea exploration only.'), 'exact experimental sentence');
  assert.match(text, /not a finished|not finished/i);
  assert.match(text, /production-ready/i);
  const box = await notice.boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height <= 900, 'notice within first 900px desktop');
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return ['--ui-bg', '--ui-surface', '--ui-ink', '--ui-muted', '--ui-accent', '--ui-border', '--ui-radius'].map((k) => style.getPropertyValue(k).trim());
  });
  assert.ok(tokens.every(Boolean), 'family tokens resolve');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no desktop body overflow (got ${overflow})`);
  assert.match(await page.locator('#count').textContent(), /^2 of 2 records · 2 fictional samples$/);
});

test('preview shell: narrow viewport keeps controls reachable without body overflow', async (context) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(FILE_URL);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no 390px body overflow (got ${overflow})`);
  assert.ok(await page.locator('#q').isVisible() && await page.locator('#export').isVisible(), 'key actions reachable');
  await page.fill('#q', 'usb');
  assert.equal(await page.locator('#rows tr').count(), 1);
});

test('round2: populated 300/320/390/desktop containment with long boundary-legal fields', async (context) => {
  const page = await context.newPage();
  for (const width of [300, 320, 390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(FILE_URL);
    await page.fill('#name', 'A'.repeat(200));
    await page.fill('#arch', 'B'.repeat(200));
    await page.fill('#notes', 'C'.repeat(500));
    await page.fill('#version', 'V'.repeat(100));
    await page.selectOption('#entry-status', 'tested');
    await page.fill('#source', 'https://example.invalid/' + 'x'.repeat(80));
    await page.fill('#date', '2026-01-15');
    await page.click('#add button');
    assert.match(await page.locator('#message').textContent(), /Record added locally/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `no body overflow at ${width}px (got ${overflow})`);
    const wrap = await page.evaluate(() => {
      const el = document.querySelector('.table-wrap');
      return { sw: el.scrollWidth, cw: el.clientWidth };
    });
    if (width <= 390) assert.ok(wrap.sw >= wrap.cw - 1, `table region contains wide table at ${width}px`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.badge')).whiteSpace), 'nowrap');
    assert.ok(await page.locator('#q').isVisible(), `search reachable at ${width}px`);
    assert.ok(await page.locator('#export').isVisible(), `export reachable at ${width}px`);
    assert.ok(await page.locator('#add button').isVisible(), `add reachable at ${width}px`);
    await page.fill('#q', 'AAAAA');
    assert.ok((await page.locator('#rows tr').count()) >= 1, `filter works with long token at ${width}px`);
    await page.fill('#q', '');
  }
});

test('round2: light and dark schemes meet AA for body/muted/accent/badge/small/placeholder', async (context) => {
  const page = await context.newPage();
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(FILE_URL);
    // Add one tested record so the HTTPS evidence link exists for accent measurement.
    await page.fill('#name', 'Contrast probe app');
    await page.fill('#source', 'https://example.invalid/evidence');
    await page.fill('#date', '2026-01-15');
    await page.selectOption('#entry-status', 'tested');
    await page.click('#add button');
    const ratios = await page.evaluate(() => {
      const lum = (rgb) => {
        const v = rgb.slice(0, 3).map((n) => n / 255).map((n) => (n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4)));
        return v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
      };
      const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
      const pair = (sel, pseudo) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const parse = (v) => (v.match(/[\d.]+/g) || []).map(Number);
        const fg = parse(pseudo ? getComputedStyle(el, pseudo).color : getComputedStyle(el).color).slice(0, 3);
        let n = el, bg = null;
        while (n) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c.length >= 3 && (c.length === 3 || c[3] === 1)) { bg = c.slice(0, 3); break; }
          n = n.parentElement;
        }
        if (!bg) bg = [255, 255, 255];
        return Number(contrast(fg, bg).toFixed(3));
      };
      return {
        body: pair('body'),
        muted_subtitle: pair('.subtitle'),
        muted_hint: pair('.hint'),
        small: pair('#rows small'),
        accent_evidence: pair('#rows a'),
        accent_eyebrow: pair('.eyebrow'),
        badge: pair('.badge'),
        placeholder: pair('#q', '::placeholder'),
      };
    });
    for (const [label, ratio] of Object.entries(ratios)) {
      assert.ok(ratio !== null && ratio >= 4.5, `${scheme} AA ${label} >= 4.5 (got ${ratio})`);
    }
  }
  await page.emulateMedia({ colorScheme: 'dark' });
});

test('round2: keyboard focus, reduced-motion and print stay usable', async (context) => {
  const page = await context.newPage();
  await page.goto(FILE_URL);
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => ({ cls: document.activeElement.className, text: document.activeElement.textContent.slice(0, 40) }));
  assert.ok(String(focused.cls).includes('skip'), `Tab lands on skip link (got ${JSON.stringify(focused)})`);
  const outline = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement);
    return { w: s.outlineWidth, c: s.outlineColor, style: s.outlineStyle };
  });
  assert.equal(outline.w, '3px');
  assert.match(outline.c, /211,\s*172,\s*99/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(FILE_URL);
  assert.equal(await page.locator('#rows tr').count(), 2);
  await page.emulateMedia({ media: 'print' });
  const printInfo = await page.evaluate(() => ({
    skipHidden: getComputedStyle(document.querySelector('.skip')).display === 'none',
    tableMin: getComputedStyle(document.querySelector('table')).minWidth,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  }));
  assert.ok(printInfo.skipHidden, 'print hides skip link');
  assert.equal(printInfo.tableMin, '0px');
  assert.ok(printInfo.overflow <= 1, `no print overflow (got ${printInfo.overflow})`);
  await page.emulateMedia({ media: 'screen' });
});

test('round2: narrow-width filter/import/export actions stay reachable', async (context) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(FILE_URL);
  await page.fill('#q', 'usb');
  assert.equal(await page.locator('#rows tr').count(), 1);
  await page.fill('#q', '');
  await page.setInputFiles('#import', path.join(FIXTURES, 'radar-import.json'));
  await waitForMessage(page, /Imported local catalog\. No data was uploaded\./);
  assert.equal(await page.locator('#rows tr').count(), 3);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  assert.equal(download.suggestedFilename(), 'arm64-catalog.json');
  const body = JSON.parse((await readDownload(download)).toString('utf8'));
  assert.equal(body.length, 3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no 320px overflow after import/export (got ${overflow})`);
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
