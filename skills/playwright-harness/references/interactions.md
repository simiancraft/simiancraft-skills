# Browser interactions: address elements, act, wait, assert

Reference for **playwright-harness**. Same run pattern as the base: write a
`/tmp/pw-*.mjs`, run it with `playwright` resolvable. Everything here is a
pattern to inline into that script, not a library you install.

Raw `playwright` (what the base installs) gives you `chromium`, a `page`, and
`locator`. The web-first `expect` assertions live in the **separate**
`@playwright/test` package; if you want them, `npm i -D @playwright/test` and
`import { expect } from '@playwright/test'`. Everything below works with raw
`playwright` and asserts by hand, so the base's one install is enough.

## Address elements: locators, best to worst

Prefer locators that survive markup churn and double as accessibility signals:

1. `page.getByRole('button', { name: 'Sign in' })`: role plus accessible name; survives restyle and class churn, and doubles as an accessibility check. Most resilient.
2. `page.getByLabel('Email')`: form fields by their visible label.
3. `page.getByTestId('submit')`: explicit `data-testid`; stable by contract.
4. `page.getByText('Welcome back')`: visible copy.
5. `page.locator('css=...')` / `page.locator('xpath=...')`: last resort; brittle to restyling.

Locators are lazy and auto-retrying: they resolve at action time, not creation
time, so define one and reuse it. Chain to narrow:
`page.getByRole('row', { name: 'Ada' }).getByRole('button', { name: 'Edit' })`.

## Act

Playwright auto-waits for actionability (visible, enabled, stable) before each
action, so you rarely pre-wait.

- `await loc.click()` / `loc.dblclick()` / `loc.hover()`
- `await loc.fill('text')`: clears, then sets; the default for inputs
- `await loc.pressSequentially('text', { delay: 50 })`: real keystrokes (autocomplete, masked fields)
- `await loc.selectOption('value')` or `selectOption({ label: 'Visible text' })`
- `await loc.check()` / `loc.uncheck()`: checkboxes, radios
- `await loc.setInputFiles('/tmp/upload.png')`: file inputs
- `await loc.press('Enter')` / `await page.keyboard.press('Control+A')`

## Wait on conditions, never the clock

- `await loc.waitFor({ state: 'visible' })` (also `'attached'`, `'hidden'`)
- `await page.waitForURL('**/dashboard')`
- `await page.waitForLoadState('networkidle')`
- `await page.waitForResponse(r => r.url().includes('/api/me') && r.ok())`
- `await page.waitForFunction(() => window.__ready === true)`

`page.waitForTimeout(ms)` is a smell. Reserve it for a deliberate settle
(animation, shader PSO compile) and say why in a comment.

## Assert (raw playwright, no `expect`)

- presence / count: `await loc.count()`, `await loc.isVisible()`
- text: `await loc.textContent()`, `await loc.innerText()`
- attribute / state: `await loc.getAttribute('href')`, `await loc.isChecked()`, `await loc.isEnabled()`
- gate and throw: `if (!(await loc.isVisible())) throw new Error('CTA missing');`

Then the base's rule still holds: collect `pageerror` + `console` errors and
**Read the screenshot**. A passing locator check, a clean error list, and eyes
on the pixels are the three parts of the gate; none replaces the others.

## Robust patterns (inline these; they are not a shipped library)

Retry a flaky click:

```js
async function clickWithRetry(loc, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { await loc.click({ timeout: 2000 }); return; }
    catch (e) { if (i === tries - 1) throw e; }
  }
}
```

Dismiss a cookie / consent banner, best-effort, never failing the run on it:

```js
const consent = page.getByRole('button', { name: /accept|agree|got it/i });
if (await consent.count()) await consent.first().click().catch(() => {});
```

Extract a table to rows of cell text:

```js
const rows = await page.locator('table tbody tr').evaluateAll(trs =>
  trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim())));
```
