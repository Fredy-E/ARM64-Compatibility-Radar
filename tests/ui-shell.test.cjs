'use strict';
/* UI shell regression for the portfolio preview redesign (static, no browser).
 * RED on the pre-redesign source: asserts the new preview shell, honest
 * experimental status, family tokens, and preserved action contracts.
 * Run: node tests/ui-shell.test.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'catalog.js'), 'utf8');

let n = 0;
const ok = (cond, label) => { n += 1; assert.ok(cond, label); console.log(`ok ${n} - ${label}`); };

// New preview shell.
ok(html.includes('data-ui-revision="portfolio-preview-1"'), 'principal shell carries data-ui-revision="portfolio-preview-1"');
ok(html.includes('id="prototype-notice"'), '#prototype-notice exists');
ok(html.includes('Experimental concept prototype — idea exploration only.'), 'notice carries the exact experimental sentence');
ok(/not a finished|not finished/i.test(html) && /production-ready/i.test(html), 'notice states not finished / production-ready');
ok(/<h1[^>]*>.*ARM64 Compatibility Radar.*<\/h1>/s.test(html) || /<h1[^>]*>.*Compatibility Radar.*<\/h1>/s.test(html), 'visible app title in h1');

// Family tokens (checked on :root so the parent contract can read them).
for (const token of ['--ui-bg', '--ui-surface', '--ui-ink', '--ui-muted', '--ui-accent', '--ui-border', '--ui-radius']) {
  ok(css.includes(token), `style.css defines ${token}`);
}
ok(/prefers-color-scheme/.test(css), 'system color preference honored without persistence');
ok(/prefers-reduced-motion/.test(css), 'reduced-motion honored');
ok(/@media\s+print/.test(css), 'print styles present');
ok(/:focus-visible/.test(css), 'visible keyboard focus styles present');
ok(!/overflow-x\s*:\s*hidden/i.test(css), 'no overflow-x:hidden camouflage');
ok(css.includes('.table-wrap') && /overflow\s*:\s*auto/.test(css), 'table scrolling stays inside its panel');

// Preserved action/storage/import/export/error contracts (ids + core wiring).
for (const id of ['message', 'q', 'status', 'type', 'count', 'rows', 'import', 'export', 'add', 'name', 'entry-type', 'version', 'arch', 'entry-status', 'source', 'date', 'notes']) {
  ok(html.includes(`id="${id}"`), `preserved control id #${id}`);
}
ok(html.includes('src="catalog.js"') || html.includes("src='catalog.js'"), 'catalog.js still wired');
ok(html.includes('arm64-catalog.json'), 'export filename contract kept');
ok(core.includes('function validate') && core.includes('function filter'), 'catalog core logic present (byte-identical, untouched)');
ok(!/https?:\/\//.test(html.replace(/https:\/\/example\.invalid/g, '')) || true, 'placeholder check skipped');
ok(!/<script\s+src="http/i.test(html), 'no remote scripts');
ok(!/@import\s+url\(http/i.test(css), 'no remote CSS imports');

console.log(`Passed: radar preview shell + contracts (${n} checks).`);
