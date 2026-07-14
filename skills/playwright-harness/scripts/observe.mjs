// Attach to the shared headed Chromium (see keeper.mjs) over CDP, report the
// active page's URL and title, and screenshot it for vision assertion.
// Usage: node observe.mjs [outfile.png]
import { chromium } from 'playwright';

const CDP_PORT = process.env.CDP_PORT || '9222';
const OUT = process.argv[2] || new URL('./observed.png', import.meta.url).pathname;

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
const context = browser.contexts()[0];
const pages = context.pages().filter((p) => !p.url().startsWith('devtools://'));
const page = pages[pages.length - 1]; // most recently opened non-devtools tab
if (!page) {
  console.error('no page found');
  process.exit(1);
}

console.log(`url: ${page.url()}`);
console.log(`title: ${await page.title()}`);
await page.screenshot({ path: OUT });
console.log(`screenshot: ${OUT}`);
await browser.close(); // detaches CDP only; the headed browser stays up
