# Adopting walk-the-floor

Instructions for pointing the walker at a repository's running environment, written for an agent
doing the adoption. The repository carries one file, `walk-the-floor.config.ts` at its root, and the
walker refuses to start without it. Everything about the environment lives there; nothing in the
skill is copied or edited.

## The config file

```ts
import type { WalkConfig } from '<this-skill-dir>/lib/config.ts';

export default {
  // The same shape as burn-down-github-issues' `project`; re-export it from that config when both
  // skills are adopted, so the two never disagree about the repository.
  project: {
    name: 'YourApp',
    repo: 'your-org/your-app',
    remote: 'origin',
    baseBranch: 'main',
    evidenceBranch: '__evidence_locker__',
    checkCommand: 'bun run verify',
    installCommand: 'bun install --frozen-lockfile',
    conventionDocs: ['CONTRIBUTING.md'],
    sizingScale: 'docs/sizing.md',
    sharedServices: ['the database', 'the shared staging environment'],
    portBase: 41000,
    portSpan: 1000,
    pathAliases: [{ prefix: '@/', dir: 'src' }],
    sourceExtensions: ['.ts', '.tsx', '.js', '.jsx'],
    alwaysInvalidates: ['package.json', 'bun.lock', '.github/workflows/'],
    touchPaths: { migration: ['db/migrations/'], ci: ['.github/workflows/'] },
    worktreeRoot: '../.your-app-loop',
  },

  environment: {
    kind: 'web', // 'web' | 'ios' | 'android'; picks the default driver skill the walker loads
    // driverSkill: 'expo-ios-simulator', // optional; a stack-specific driver in place of the kind's default
    baseUrl: 'https://staging.example.com',
    healthPaths: ['/', '/api/health'], // fetched by the in-process probe on every wake
    probeTimeoutMs: 10000, // one health request slower than this counts as no response
    revisionCommand: 'curl -s https://staging.example.com/version', // optional; prints a SHA
    logsCommand: 'your-host logs --tail 200', // optional; read when a walk fails
    login: {
      url: 'https://staging.example.com/login',
      userEnv: 'FLOOR_USER', // environment variable NAMES; never values
      passwordEnv: 'FLOOR_PASSWORD',
      restrictedUserEnv: 'FLOOR_RESTRICTED_USER', // optional; enables permission checks
      restrictedPasswordEnv: 'FLOOR_RESTRICTED_PASSWORD',
    },
    safeEndpoints: [], // paths the walker may POST to; default none
    graceMinutes: 15, // with no revisionCommand, how long after a merge an item stays `unverified`
    postFixProbeDelaySeconds: 60, // after a fix for a `down` merges, how long before re-probing
    quietWindows: [{ start: '02:00', end: '02:30' }], // UTC; a nightly copy or deploy is not an incident
  },

  // Standing sanity walks, keyed to the paths a change touches. Prose for the agent, not scripts.
  walks: [
    {
      name: 'search returns records',
      paths: ['src/search/', 'src/api/search/'],
      steps: 'Log in. Open the search box, search for a term you know has results, and confirm at least one record renders with a title.',
    },
    {
      name: 'a record opens',
      paths: ['src/records/'],
      steps: 'From any list, open one record and confirm its detail view renders with its fields populated.',
    },
  ],

  cadenceMinutes: 10, // the wake cadence for `--every` with no value
  notifyCommand: undefined, // optional; receives the on-fail ledger entry on stdin
  notifyCooldownMinutes: 60, // while the environment stays down, one notification per this many minutes

  // Incident repair goes through fix-github-issue with these boundaries; any seat left out keeps its default.
  maxPoints: 5, // the size ceiling an incident's fix may attempt
  autoMerge: 'code-only', // what a repair may merge on its own; 'never' parks every fix for a person
  maxReviewRounds: 3, // review rounds an incident's fix gets before the dead-letter queue
  checksTimeoutMinutes: 45, // how long a repair waits on its pull request's checks
  smokeTimeoutMinutes: 10, // how long project.smokeCommand may run before the repair parks
  seats: { walker: 'claude:claude-opus-5', worker: 'codex:gpt-5.6-sol', reviewer: 'claude:claude-opus-5' },
} satisfies WalkConfig;
```

The loader refuses a `userEnv` or `passwordEnv` whose value looks like a literal secret rather
than a variable name; credentials never live in the config.

## Environment kinds and their drivers

| `kind` | Default driver skill | What "go and look" means |
|---|---|---|
| `web` | `playwright-harness` | navigate, read, click, screenshot in headless Chromium |
| `ios` | `ios-simulator` | boot the simulator, launch the app, drive by accessibility |
| `android` | `android-emulator-harness` | boot the emulator, install the build, drive with Maestro |

The walker does not carry any of that knowledge itself; the prompt names the skill and the agent
loads it. `environment.driverSkill` replaces the kind's default with a stack-specific driver when
one exists (an Expo app names `expo-ios-simulator`, which sits on top of `ios-simulator`).
Adopting a fourth kind is a new row here and a new driver skill, not a change to the walker.

## Authoring a standing walk

A walk is a paragraph of prose an agent can follow, keyed to path globs. Write it the way you
would tell a new hire to check that something still works:

- Name what to open, what to do, and what "working" looks like ("at least one row renders", "the
  form refuses an empty postal code").
- Keep it to the ordinary user action. A walk is the `exercise` rung, not a test plan.
- Key it to the directories whose changes should trigger it. An item touching any of those paths
  gets the walk performed whatever else the walker does.
- Prefer a handful of walks covering the surfaces a user touches daily over dozens covering
  everything. Sign in, the main list, one record, one search, one print or export is a good floor.

## Safe endpoints

By default the walker posts to nothing. Listing an endpoint under `safeEndpoints` says: posting
here has no external side effect, creates nothing a person will be billed for, sends nothing to a
third party, and any record it creates can be soft-deleted. Inbound webhooks that only write rows
qualify; anything that touches payment, email, or a partner system does not, and the walker will
mark items behind it `not-checkable` rather than guess.

## Quiet windows

An environment that is rebuilt on a schedule (a nightly database copy from production, a
scheduled deploy) is down on purpose for a few minutes a day, and a walker that files an incident
for it every night is noise. List those minutes in `quietWindows`, in UTC. Inside one the walker
still probes and records what it sees, so the ledger stays honest, but it runs no callback, files
no incident, and defers the walk to the next wake.

## Reading the deployed revision

`revisionCommand` turns the propagation race into a state. Any command that prints the running
commit works: a `/version` route, a build stamp in the HTML, the host's release API. Without it the
walker falls back to `graceMinutes` and labels items inside the window `unverified`, which is
honest but blunter.

## Preconditions

- `walk-the-floor.config.ts` at the repository root.
- The `fix-github-issue` skill installed beside this one; the walker imports it.
- The driver skill for the configured kind installed, and its runtime present: Playwright with a
  Chromium build for `web`; a simulator or emulator harness for mobile.
- `gh` authenticated with issue-creation rights on the repository, so incidents can be filed.
- The walker seat's CLI on `PATH`.
- The environment variables the login block names, set in the shell that runs the walker.

## First-run order

1. `walk.ts --dir <floor> --liveness-only --once`. No agent, no list; confirms the base URL and
   health paths answer and the lock and ledger work.
2. Write three items by hand into `<floor>/list.jsonl` (one visible change, one behavioural, one
   file nothing renders) and run `walk.ts --dir <floor> --once --no-forge`. Read the ledger: every
   item has a rung and a verdict, and the reasons are things you could repeat.
3. `walk.ts --dir <floor> --once` with the forge producer on, against the real merge history.
4. `walk.ts --dir <floor> --every 10` in a terminal you can watch, for an hour.
5. Only then let something else start it for you.

## Stopping

Ctrl+C or SIGTERM to the pid in `<floor>/floor.lock`. The walker finishes nothing mid-turn; a
wake killed halfway leaves no ledger entry for that wake, and the next wake walks the same items.
