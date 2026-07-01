---
name: evidence-locker
description: >-
  Where and how artifacts are stored: the __evidence_locker__ branch, its integrity protection,
  the release-branch contamination guard, the pluggable backend, GitHub size limits, the
  append-only/SHA-pinning rule, and the artifact naming convention.
role: lifecycle-stage
stage: 3
---

# Evidence Locker

The store stage. Artifacts go to a blessed, never-merged branch and are referenced inline from the
PR/issue comment by a URL that pins an immutable commit.

## The branch

- `__evidence_locker__` (double underscores both sides; chosen to never collide).
- Artifacts live under `evidence/` on that branch; it **never merges** into any release branch.
- Comments reference locker files **inline**. Branch-hosted files are chosen over GitHub's
  drag-drop attachment uploads for durability, addressability, and greppability.
- **Pin the commit, not the branch.** A raw URL at the branch ref
  (`raw.githubusercontent.com/{owner}/{repo}/__evidence_locker__/evidence/<file>`) serves whatever the
  branch tip holds *now*, so a later commit could change the bytes under a live reference. Embed
  the commit SHA instead:

  ```
  https://raw.githubusercontent.com/{owner}/{repo}/<commit-sha>/evidence/NNNNN-<name>.ext
  ```

  Capture the SHA right after the append push (`git rev-parse HEAD` on `__evidence_locker__`). A
  blob addressed by commit SHA is fixed by git's own hashing, and the integrity protection below
  keeps that commit reachable, so the reference cannot silently change.

## Two protections

The release branch is resolved dynamically (see `acquire.md`); never assume `main`:

```bash
release_branch=$(gh repo view {owner}/{repo} --json defaultBranchRef -q .defaultBranchRef.name)
```

Both protections require repo admin; the check below reports whether you have it, and the answer
sets your rung on the consent ladder (below):

```bash
gh api repos/{owner}/{repo} -q .permissions.admin    # -> true | false
```

### 1. Protect locker integrity

Disallow deletion and force-push on `__evidence_locker__` so history cannot be rewritten and the
branch cannot be removed; this is what keeps SHA-pinned references reachable, and it backs the
append-only rule below. It touches only the locker branch, so it is low-risk and the default.
As a ruleset (GitHub's current mechanism):

```bash
gh api --method POST -H "X-GitHub-Api-Version: 2022-11-28" \
  repos/{owner}/{repo}/rulesets --input - <<'JSON'
{
  "name": "protect __evidence_locker__",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/__evidence_locker__"], "exclude": [] } },
  "rules": [ { "type": "deletion" }, { "type": "non_fast_forward" } ]
}
JSON
```

Classic branch protection is the equivalent if you prefer it. All four nullable fields must be
present or the call returns 422, and `restrictions` must be `null` on a user-owned repo:

```bash
gh api --method PUT -H "X-GitHub-Api-Version: 2022-11-28" \
  repos/{owner}/{repo}/branches/__evidence_locker__/protection --input - <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Neither protection blocks a normal fast-forward commit that *overwrites* an existing file, so
append-only stays an operating convention (see below); SHA-pinning is what makes an already-issued
reference tamper-evident regardless.

### 2. Guard the release branch against locker contamination

This one is heavier: it modifies your **default branch** and, misconfigured, can block every PR
merge (a required status check that never reports leaves PRs stuck in "Expected", and rulesets bind
admins by default, so there is no merge-as-admin escape until you edit or delete the rule). Add it
deliberately, and only in the order below.

A rule on the locker branch cannot do this job; a merge into the release branch is gated by *that*
branch's rules, not by the source branch. The portable tool on every tier is a **required status
check driven by CI**.

**Sequence, in order:** commit the workflow to the default branch, open a throwaway PR and confirm
the `guard-evidence-contamination` check reports green, and only then add the ruleset that requires
it. Applying the ruleset first holds all PRs until the check reports.

The check fails when a PR's head ref is the locker or its diff adds locker artifacts. Two safety
details: branch names are attacker-controllable on fork PRs, so the untrusted values pass through
`env:` and are read as quoted shell variables, never interpolated into `run:`; and the diff is
captured before it is greped, so a large diff cannot make `grep -q` close the pipe early and let
contaminated content pass:

```yaml
# .github/workflows/guard-evidence-contamination.yml
name: guard-evidence-contamination
on: pull_request
jobs:
  guard-evidence-contamination:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Reject locker content on the release branch
        env:
          HEAD_REF: ${{ github.head_ref }}
          BASE_REF: ${{ github.base_ref }}
        run: |
          if [ "$HEAD_REF" = "__evidence_locker__" ]; then
            echo "PR head is the evidence locker; it must never merge."; exit 1
          fi
          changed=$(git diff --name-only "origin/$BASE_REF...HEAD")
          if printf '%s\n' "$changed" \
             | grep -qE '(^|/)evidence/[0-9]{5}-[0-9]{4}-[0-9]{2}-[0-9]{2}-'; then
            echo "PR diff adds evidence-locker artifacts to the release branch."; exit 1
          fi
```

Pin `actions/checkout` to a commit SHA rather than `@v4` if you want to close the tag-mutation
vector too. The grep keys on the storage path and the artifact naming pattern
(`evidence/NNNNN-YYYY-MM-DD-`) so an unrelated `evidence/` directory does not false-trip, and the
three-dot diff range compares against the merge base so it sees only the PR's own additions.

Then require that check on the release branch. `strict_required_status_checks_policy` is `false` on
purpose: contamination detection does not need branch-up-to-dateness, and `true` would force a
rebase before every merge:

```bash
gh api --method POST -H "X-GitHub-Api-Version: 2022-11-28" \
  repos/{owner}/{repo}/rulesets --input - <<'JSON'
{
  "name": "release-branch anti-contamination gate",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [ { "type": "required_status_checks", "parameters": {
    "strict_required_status_checks_policy": false,
    "required_status_checks": [ { "context": "guard-evidence-contamination" } ] } } ]
}
JSON
```

`~DEFAULT_BRANCH` targets the repo's default branch, which in this file is the release branch you
resolved above; parameterize the condition if your release branch is not the default.

A required check gates pull-request merges only, so a direct push to the release branch sidesteps
it. To close that path, add a `pull_request` rule to the same `rules` array; it requires a PR
before merging (zero approvals, so no review gate) and blocks direct pushes:

```json
{ "type": "pull_request", "parameters": {
  "required_approving_review_count": 0,
  "dismiss_stale_reviews_on_push": false,
  "require_code_owner_review": false,
  "require_last_push_approval": false,
  "required_review_thread_resolution": false } }
```

Drop it if your release branch already requires PRs, or if you deliberately push to it directly.

GitHub's path-based push ruleset (`file_path_restriction`) is the wrong tool here: a push ruleset
takes no branch condition, so it would also block the pushes to `__evidence_locker__` that must
succeed.

If you add no ruleset at all, the procedural floor remains: never open a PR from the locker; it is
a store, not a merge source.

## Three-tier consent before the first artifact push

Repo-settings changes are durable and outward-facing, so confirm before acting, and be explicit
that protection 2 touches the default branch:

1. **Author with consent**: "I'm about to use `__evidence_locker__` as an artifact store. Want me
   to add integrity protection so it can't be force-pushed or deleted? Optionally, I can also add a
   CI gate to `<release-branch>` that blocks any PR from merging locker artifacts; that one is a
   required status check on your default branch, so if the check ever stops reporting, merges block
   until you remove the rule. I have admin; here is exactly what I'd add."
2. **Instruct if you can't**: no admin or no scope: hand the user the commands above, or the
   Settings then Rules path.
3. **At minimum, warn**: never silently pile artifacts onto an unprotected branch.

## Pluggable backend

One interface: "give me a durable, addressable URL for these bytes." Two adapters:

- **Default = the GitHub branch.** Zero setup; clone the skill and it works.
- **Opt-in = a user/team-provided backend** (S3 bucket or similar). Also serves as the
  per-artifact overflow valve when a single artifact cannot be brought under GitHub's
  per-file limit.

## Size, growth, and limits

Compress before upload; see `optimize-assets.md`, which defers the how to the
`asset-optimization` skill.

GitHub has two different limits, and only one is a migration trigger:

- **Per-file hard block at 100 MiB** (warning at 50 MiB). This can reject a single oversized
  artifact at push time. It is a per-artifact problem: compress or downscale it, or route that
  one artifact to the provided backend. It is not a reason to migrate the whole locker.
- **Repo-size soft threshold** (GitHub recommends staying under about 1 GiB and reaches out by
  email in the multi-GiB range; no silent hard stop). This is the only whole-locker migration
  trigger, and it arrives gradually, with warning.

LFS is opt-in and is never auto-forced.

Storage lifetime stance: **keep indefinitely, no GC.** Evidence on old PRs stays valuable, and
never-delete also means SHA-pinned references never 404. The cost is gradual clone-size growth (a
full clone fetches all branch objects), bounded by compression.

When the repo-size threshold is genuinely hit, the escape hatch is a one-time migration, not
routine deletion: move the artifacts to a provided backend, rewrite the inline URLs across the
affected PRs and issues, then delete the locker branch. Deleting the branch stops growth but
does not instantly reclaim storage; GitHub's GC runs on its own schedule, and forks or the repo
network may retain objects. This migration is a separate, larger task.

If pruning is ever forced before a backend is available, prune by validity-staleness, not age
(see `freshness-and-reproof.md`): the oldest proof that no longer reflects the application is
the first to cull.

## Append-only and pinned

Never overwrite a locker file. The integrity protection stops history rewrite and branch deletion
but still permits a normal commit that replaces a file, so append-only is an operating rule you
keep, not something the branch enforces for you. Two things make an issued reference tamper-evident
regardless: the inline URL embeds the artifact's commit SHA, so it resolves to those exact bytes for
as long as the branch lives, and the manifest records the artifact's content hash as an independent
anchor a reader can re-verify (see `artifact-manifest.md`). Superseded proof is replaced *inline in
the comment* by a fresh artifact at a new SHA; the old bytes remain as audit history.

## Artifact naming convention

Stored at `evidence/<filename>` on the locker branch, where `<filename>` is:

```
NNNNN-YYYY-MM-DD-kebab-description[-disambiguator].ext
```

- `NNNNN`: zero-padded issue/PR number. Issues and PRs share one monotonic number space per
  repo, so this is globally unique and chronological; padding makes a plain file listing sort
  in creation order and keeps a single PR's artifacts contiguous (prefix scan).
- `YYYY-MM-DD`: capture date.
- `kebab-description`: what the evidence is.
- Disambiguator, **only** when a set shares the base:
  - ordered series (a `flow`: step 1 to 2 to 3) takes a zero-padded **sequence**: `-01`, `-02`.
  - unordered set (parallel captures) takes a short **content-hash**: `-a1b9f3c`.

Example: `evidence/00128-2026-06-29-login-flow-walkthrough.gif`. Collisions are effectively
impossible: the issue number, description, and sequence-or-hash disambiguator together make a
repeat vanishingly unlikely.

## Consumes / produces

- Consumes: optimized artifacts (`optimize-assets.md`) and their manifest entries.
- Produces: durable, SHA-pinned URLs for the render step (stage 3) to embed.
