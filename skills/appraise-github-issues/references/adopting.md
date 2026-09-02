# Adopting appraise-github-issues

The command reads one config file at the repository root. A repository that has already adopted
`burn-down-github-issues` needs nothing more: `appraise.ts` reads `burn-down-github-issues.config.ts`
when no `appraise-github-issues.config.ts` exists, and the burndown's `ageDays`, `appraiseLimit`,
`appraiserConcurrency`, `skipLabels`, and `seats.appraiser` are the same knobs.

A repository adopting appraisal alone writes `appraise-github-issues.config.ts`:

```ts
export default {
  project: {
    // The same `project` shape as burn-down-github-issues; only these fields are read here.
    name: 'YourApp',
    repo: 'your-org/your-app',
    remote: 'origin',
    baseBranch: 'main',
    conventionDocs: ['CONTRIBUTING.md'],   // what an issue's prescribed remedy is read against
    sizingScale: 'docs/sizing.md',          // where the point scale is written
    worktreeRoot: '../.your-app-loop',      // runs/ and scratch directories live under it
    // The loader validates the whole project shape, so the remaining fields must be present
    // even though appraisal never uses them; copy them from the burndown template.
    evidenceBranch: '__evidence_locker__',
    checkCommand: 'bun run verify',
    installCommand: 'bun install --frozen-lockfile',
    sharedServices: [],
    portBase: 41000,
    portSpan: 1000,
    pathAliases: [{ prefix: '@/', dir: 'src' }],
    sourceExtensions: ['.ts', '.tsx'],
    alwaysInvalidates: [],
    touchPaths: { migration: [], ci: [] },
  },
  ageDays: 30,                 // only issues opened this recently, unless --all
  appraiseLimit: 12,           // per run, unless --limit
  appraiserConcurrency: 3,
  confirmCloses: true,         // a second engine must agree before an issue closes
  skipLabels: ['needs-decision', 'needs-human', 'loop/skip', 'loop/parked'],
  seats: { appraiser: 'codex:gpt-5.6-sol', confirmer: 'claude:claude-opus-5' },
};
```

## What it writes to the tracker

Labels it creates on start, idempotently: `needs-decision`, `needs-human`, `loop/skip`,
`loop/parked`, `loop/dlq`. Labels it applies: `size: N`, `needs-decision`, `needs-human`. Comments:
the question for a hand-off, the receipt for a close, both opinions for a disputed close, and the
reason for a re-size. Closes: only `already-fixed` and `obsolete`, and only after the confirmer
agrees unless `confirmCloses` is off.

An issue carrying `needs-decision`, `needs-human`, `loop/skip`, `loop/parked`, or `loop/dlq` is
never selected; a person removes the label to put it back in reach. `--issue <n>` bypasses the
window and the size filter but not those labels.

## First-run order

1. `appraise.ts --dry-run`: prints what it would select; no lock is taken, no agent runs, and nothing but `runs/appraise.log` is written.
2. `appraise.ts --issue <n>` on one issue you already know the answer for. Read the comment or the
   label it left and check that a stranger could re-check it.
3. `appraise.ts --limit 3`, then a full window.
4. `appraise.ts --all` once, if the backlog predates the window. Expect the closes to be the
   highest-yield part; read a few of the receipts before trusting the rest.
5. `appraise.ts --every <minutes>` in a terminal you can watch, if you want the backlog kept sized
   between burndown runs.

## Boundaries

`--all --include-sized` re-judges every open issue and will comment on every sizing disagreement it
finds. On a large backlog that is a lot of comments; run it once, deliberately, not on a cadence.

`--no-confirm` removes the only independent check on a close. Use it for a tracker you would let
one model close issues on unsupervised, and nowhere else.
