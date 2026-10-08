'use strict';
/*
 * Regenerates docs/images/app.png from the real UI. The page shows only the
 * bundled fictional sample records. Run: npm run screenshot
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { launchBrowser } = require('../tests/browser.cjs');

(async () => {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(pathToFileURL(path.join(__dirname, '..', 'index.html')).href);
    await page.waitForTimeout(200);
    const target = path.join(__dirname, '..', 'docs', 'images', 'app.png');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await page.screenshot({ path: target, fullPage: true });
    console.log(`Wrote ${target}`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
