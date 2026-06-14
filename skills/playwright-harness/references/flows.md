# Browser flows: multi-step recipes

Reference for **playwright-harness**. Each recipe is the body of a
`/tmp/pw-*.mjs`; the base owns the launch / assert / GPU scaffolding around it,
and `references/interactions.md` owns the per-element vocabulary. Headless by
default; add `headless: false` only to watch a flow while debugging.

## Find the target without hardcoding

The base parameterizes `TARGET_URL`. For localhost work, detect a running dev
server instead of guessing the port:

```js
import net from 'node:net';
const probe = (port) => new Promise((res) => {
  const s = net.connect(port, '127.0.0.1');
  const done = (v) => { clearTimeout(t); s.destroy(); res(v); };
  const t = setTimeout(() => done(false), 300);
  s.on('connect', () => done(true));
  s.on('error', () => done(false));
});
const PORTS = [3000, 3001, 4321, 5173, 8080, 8081];
const up = (await Promise.all(PORTS.map(async (p) => (await probe(p)) && p))).filter(Boolean);
// up = the open dev ports; take the lone match, or disambiguate several by env or arg
```

Reading the project's `package.json` scripts for a `--port` flag is the other
half if the port is non-standard.

## Log in once, reuse the session

Authenticate once, then persist storage state:

```js
await page.goto(`${TARGET_URL}/login`);
await page.getByLabel('Email').fill(process.env.E2E_USER ?? 'test@example.com');
await page.getByLabel('Password').fill(process.env.E2E_PASS ?? 'password123');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL('**/dashboard**'); // trailing ** tolerates a slash: http.server and many routers 301 /dashboard to /dashboard/
await page.context().storageState({ path: '/tmp/pw-auth.json' });
```

Later runs reuse it and start authenticated, skipping the login entirely:

```js
const ctx = await browser.newContext({ storageState: '/tmp/pw-auth.json' });
const page = await ctx.newPage();
await page.goto(`${TARGET_URL}/dashboard`); // already signed in
```

Keep real credentials in env vars, never in the script.

## Fill and submit a form, verify the result

```js
await page.goto(`${TARGET_URL}/contact`);
await page.getByLabel('Name').fill('Ada Lovelace');
await page.getByLabel('Email').fill('ada@example.com');
await page.getByLabel('Message').fill('Hello.');
await page.getByRole('button', { name: /send|submit/i }).click();
await page.getByText(/thank you|received/i).waitFor(); // the success signal, not a timeout
```

## Responsive sweep

```js
for (const v of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet',  width: 768,  height: 1024 },
  { name: 'mobile',  width: 375,  height: 812 },
]) {
  await page.setViewportSize(v);
  await page.goto(TARGET_URL, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `/tmp/pw-${v.name}.png`, fullPage: true });
}
```

Read each screenshot; layout breakage is a vision call, not an assertion.

## Mobile device emulation

For touch and device-metrics fidelity, seed the context from a device
descriptor instead of just resizing. Add `devices` to the base's playwright
import:

```js
import { chromium, devices } from 'playwright';
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
```

## Crawl for broken links

```js
await page.goto(TARGET_URL, { waitUntil: 'load' });
const hrefs = [...new Set(
  await page.locator('a[href^="http"]').evaluateAll((as) => as.map((a) => a.href)),
)];
const broken = [];
for (const url of hrefs) {
  const r = await page.request.head(url).catch(() => null);
  if (!r || !r.ok()) broken.push({ url, status: r?.status() ?? 'ERR' });
}
console.log(broken.length ? broken : 'all links ok');
```

This checks absolute `http(s)` links only; root-relative (`/about`) and
protocol-relative (`//cdn...`) hrefs are skipped by the selector. Some hosts
reject `HEAD` with 405 or block bot traffic, and a 3xx redirect fails `ok()`; for
those, retry with a ranged `get` or treat 3xx as live.

## Stub the network for a deterministic UI state

Force an empty / error / loading state without touching the backend:

```js
await page.route('**/api/items', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
// then drive the page and assert the empty-state renders
```

## Tag automated traffic or inject an auth header

Playwright-native, set on the context, no env-var plumbing:

```js
const ctx = await browser.newContext({
  extraHTTPHeaders: {
    'X-Automated-By': 'playwright',
    ...(process.env.AUTH_HEADER ? { Authorization: process.env.AUTH_HEADER } : {}),
  },
});
```

When you read a header back to verify it (via `route.request().headers()` or your
own server), the key is lowercased: match against `x-automated-by`, not the
title-cased form you set.
