// Long-lived HEADED Chromium with CDP debugging exposed for an agent to attach.
// The human drives the window (real address bar, real tabs); the agent connects
// over CDP (see observe.mjs) to see and drive the same pages.
//
// Run it as a BACKGROUND process from a scratch dir where `playwright` resolves:
//   node keeper.mjs
// It stays alive until the browser window is closed (or its parent process dies;
// relaunching is idempotent — the persistent ./profile keeps cookies and logins).
import { chromium } from 'playwright';

const CDP_PORT = process.env.CDP_PORT || '9222';

const context = await chromium.launchPersistentContext(
  new URL('./profile', import.meta.url).pathname,
  {
    headless: false,
    viewport: null, // let the window size the page naturally
    args: [
      `--remote-debugging-port=${CDP_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  },
);

const page = context.pages()[0] ?? (await context.newPage());
await page.goto('about:blank');
console.log(`headed chromium up; CDP on http://127.0.0.1:${CDP_PORT}`);

// Keep the process alive until the window is closed by the user.
await new Promise((resolve) => context.on('close', resolve));
console.log('browser window closed; keeper exiting');
