# Required landing preflight proof

Code commit: `20badfd95ad4a101277423172060b6e066708ed9`

Small, reversible change: five files, 133 additions, and four deletions. No schema, persisted data, CI, or dependency changes.

## Acceptance and observations

- A1: deterministic protection-only, config-only, and overlapping-union cases pass. The read assertion names fixture/project and release, including both legacy contexts and check contexts in the GitHub query.
- A2: empty required mode prints the empty list and both configuration remedies. None mode reports a disabled gate without the warning. Unavailable protection retains the existing landing fallback.
- Dry-run integration: the actual main function body is evaluated with explicit fake dependencies for empty and nonempty backlogs. Unknown dependencies fail. No real tracker, agent process, or GitHub write is used. Source review confirms the new call precedes backlog processing and is inside DRY_RUN; the new reporter exposes only read and output boundaries.
- A4, A5, A6: Order of work instructs preflight before the first real run, restarting after config changes, and sizing checksTimeoutMinutes for the slowest required workflow plus runner queue time. It explicitly says the default 45 minutes assumes healthy CI.
- Landing policy: requiredStatusChecks only gains an export and a defaulted read argument. Its query and error fallback are unchanged; existing landing checks pass.

## Deciding-command record

At this commit, `git ls-tree -r --name-only HEAD .github` returns no paths: there is no .github/workflows directory or configured Actions command to exercise. `gh run list` for this branch returns []. package.json defines `gate` as `tsc --noEmit -p . && bun test`.

The supplied validation record certifies `bun run gate` at this exact commit: TypeScript passed and 596 tests passed. That result is retained under the explicit instruction not to repeat the gate at an unchanged head. This is inherited validation, not a newly observed gate execution. The independently captured focused and regression output below supplements it. Re-check the deciding command with `bun run gate`.

## Independent test execution

Command: `bun test skills/burn-down-github-issues/lib/preflight.test.ts skills/burn-down-github-issues/lib skills/fix-github-issue/lib/pipeline.checks.test.ts skills/fix-github-issue/lib/pipeline.dry-run.test.ts`

Exit status: 0.

```text
bun test v1.4.2 (744846f84)

skills/burn-down-github-issues/lib/pressure.test.ts:
late CI: result=nothing names the checks this landing must pass: the config lists no requiredChecks and main requires no status checks (a repository that runs no checks says so with checks: 'none'), elapsed=0

skills/burn-down-github-issues/lib/world-sweep.test.ts:
world sweep: 40565 cases, 255 disabled events, stale Merging entries: 
reconcile: 1117 world pairs

 270 pass
 0 fail
 43430 expect() calls
Ran 270 tests across 13 files. [728.00ms]
```

## Captured fixture output

```text
CASE: protection only
READ: ["gh","api","repos/fixture/project/branches/release/protection/required_status_checks","--jq","[.contexts[]?, .checks[]?.context] | unique"]
Preflight: fixture/project base release, checks: 'required'
Required landing check names (requiredChecks + base protection): ["build"]
CASE: config only
READ: ["gh","api","repos/fixture/project/branches/release/protection/required_status_checks","--jq","[.contexts[]?, .checks[]?.context] | unique"]
Preflight: fixture/project base release, checks: 'required'
Required landing check names (requiredChecks + base protection): ["test"]
CASE: overlap
READ: ["gh","api","repos/fixture/project/branches/release/protection/required_status_checks","--jq","[.contexts[]?, .checks[]?.context] | unique"]
Preflight: fixture/project base release, checks: 'required'
Required landing check names (requiredChecks + base protection): ["test","lint","build"]
CASE: empty required
READ: ["gh","api","repos/fixture/project/branches/release/protection/required_status_checks","--jq","[.contexts[]?, .checks[]?.context] | unique"]
Preflight: fixture/project base release, checks: 'required'
Required landing check names (requiredChecks + base protection): []
WARNING: the required landing check list is empty. Configure requiredChecks or required status checks on base release before the first real run. Repositories intentionally running no checks can set checks: 'none'.
CASE: none
READ: ["gh","api","repos/fixture/project/branches/release/protection/required_status_checks","--jq","[.contexts[]?, .checks[]?.context] | unique"]
Preflight: fixture/project base release, checks: 'none'
Required landing check names (requiredChecks + base protection): []
checks: 'none': the landing check gate is disabled.
```

Reproduce the output by placing this script at .proof-49/report.ts and running `bun .proof-49/report.ts`:

```ts
import { reportPreflight } from '../skills/burn-down-github-issues/lib/preflight.ts';
for (const [name, protection, requiredChecks, checks] of [
  ['protection only', ['build'], [], 'required'],
  ['config only', [], ['test'], 'required'],
  ['overlap', ['build', 'test', 'build'], ['test', 'lint', 'lint'], 'required'],
  ['empty required', [], [], 'required'],
  ['none', [], [], 'none'],
] as const) {
  console.log(`CASE: ${name}`);
  reportPreflight({project: {repo: 'fixture/project', baseBranch: 'release'}, knobs: {requiredChecks, checks}} as any, {
    read: argv => { console.log(`READ: ${JSON.stringify(argv)}`); return JSON.stringify(protection); },
    say: console.log,
  });
}
```

## Adoption text at the proved head

```markdown


1. Write `burn-down-github-issues.config.ts` from the template above. Copy nothing else.
2. `bun run <skill-dir>/board.ts`. It finds or creates the operator's board, verifies it by a
   second read, and prints its number and URL; `--dry-run` only reports. See "The board" below.
3. Before the first real run, run the preflight from the repository root:
   `bun run <skill-dir>/loop.ts --dry-run --limit 2`. It reports the required landing checks;
   resolve an empty required-check list before proceeding. This mutates
   nothing and starts no agent. It prints what it would select and writes each rendered prompt to
   `<worktreeRoot>/runs/<issue>-<role>-<timestamp>.log`.
4. **Read one rendered prompt.** `grep -oE "\{\{[A-Z_]+\}\}"` against it must return nothing; an
   unresolved placeholder means a field you did not set. Confirm the prose names your repository,
   your commands, and your branches.
5. Verify the closure walk resolves:
   `bun run <skill-dir>/loop.ts --closure <file-with-an-aliased-import>` prints every module
   the walk reaches and exits without touching anything. A result of one module (only the entry
   itself) means the aliases resolve nothing, which is the silent failure described above.
6. One real issue, alone, with the single-issue command, since the loop takes no `--issue`:
   `bun run <fix-github-issue-dir>/fix.ts --issue <n> --dry-run` first, then the same without
   `--dry-run`. Watch it end to end; `fix.ts --help` lists its flags, and Ctrl+C stops it cleanly
   (see Stopping a run).
7. Then a small batch. `--limit 3` before `--limit 5`.

Changing config requires restarting a running loop; it does not reread the file.
Set `checksTimeoutMinutes` to cover the slowest required workflow plus runner queue time.
The default 45 minutes assumes healthy CI.

```

## Limits and judgement

No live GitHub protection lookup was used; deterministic reads are the requested evidence. The startup harness evaluates main with fake dependencies, rather than launching the complete CLI process. Protection lookup cannot distinguish absent protection from unreadable protection; this existing landing behavior is preserved. No Actions run exists for this head. The accepted full gate result and independent 270-test regression run cover this bounded change. All scoped acceptance claims are covered; ready for review.
