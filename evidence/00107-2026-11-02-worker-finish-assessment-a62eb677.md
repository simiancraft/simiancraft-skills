# Issue 107 proof assessment

Capture commit: a62eb67723e4c4575514d23cbb885006a68faf1d

Physical: 13 files, 315 insertions, and 50 deletions. Moderate behavioral scope: a shared switch policy, two worker admission sites, reporting, machine data, tests, and operating documentation. Reversible code change; no schema, dependency, configuration, or shared-data mutation.

Correctness and receipts:
- Word parsing, finish latch, one-poll pause release/refusal, merge hold/release, floor exception, and signal throws: lib/line.test.ts.
- Real pool at concurrency one admits only item one of three; its live sleep child survives finish and pool completion, and isStopping remains false: lib/line.test.ts.
- Real resumePull body refuses before claim, judgment, objection, and redrive: lib/pressure.test.ts.
- Both worker admission sites precede dispatch, and mayMerge retains waitForGo: loop.source.test.ts and diff inspection.
- Machine FINISH transitions from active and paused have no exit, with no added lane: lib/machine.test.ts.
- Board and pulse remain finishing after go; watch recognizes finishing: status.test.ts and loop.source.test.ts.
- Floor suite passes; pool.ts, resume.ts, lib/floor/, and lib/lanes.ts have no diff. Inspection finds no changes to configuration loading, --only, run exit, or incident policy.
- Operating documentation explicitly leaves knife, stranded resume, appraisal, merge passage on finish, and automatic exit to sibling issues. Latest carving records on #51 and #42 agree with this boundary.

Observed execution: 140 pass, 0 fail, and 1224 assertions across six files. See accompanying receipt. bun install --frozen-lockfile succeeded. git diff --check succeeded.

Deciding-command accounting: package.json defines gate as `tsc --noEmit -p . && bun test`. The supplied gate attestation is for this exact commit: 555 pass and zero failures. It is accepted under the proof instructions and was not rerun; this is inherited evidence, not a newly observed gate transcript. `git ls-tree -r HEAD .github` returns no entries: there is no .github/workflows directory or pipeline command at this head. `gh run list` for this branch returns []. No CI success is claimed.

Confidence and limits: no live tracker dispatch was performed. The real policy, pool, child process, extracted resume body, source assertions, and unchanged surrounding dispatch code cover the bounded issue. No finish-driven cancellation or new data/security surface was found. Gate provenance is explicitly inherited. Verdict: adequate for review within #107's scope.

Remote witness: fetched fix/finish-worker-dispatch-107 and verified the capture commit is an ancestor of origin/fix/finish-worker-dispatch-107. Default branch resolved by git ls-remote --symref origin HEAD as main. Locker protection is unverified; append-only storage and immutable commit links are used without changing repository settings.
