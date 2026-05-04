# Anti-Patterns

Things that look like a plan but are not a plan. If the draft has any of these, fix before shipping.

## Goal-section anti-patterns

### "Refactor X for better maintainability."

**Why it fails:** Why now? Maintainability how? Measurable how? This is a wish, not a north star. The executor has nothing to measure scope drift against and nothing to compare end-state to.

**Fix:** Name the concrete failure mode the refactor addresses, the shape of the intervention, and a checkable end state.

> Replace the implicit `Achievement` + `LifeEvent` split (data duplicated across two tables, kept in sync by hand) with a unified `LifeEvent` model whose visual is driven by a client-side glyph registry of JSON configs. Done = no `Achievement` surface remains; every existing badge renders from a registry entry; no S3-URL paths in the rendering path.

### A five-paragraph essay

**Why it fails:** The Goal should be the first thing a cold reader absorbs. A long essay competes with the rest of the doc for the reader's attention; the doc has nine other sections that need to land.

**Fix:** Cap at one paragraph, two if the domain is genuinely complex. Aim for ≤150 words. Move history, stakeholder context, and decision rationale to **Domain context** or **Interrogation log**.

### Goal as commit list (file paths or code moves)

**Why it fails:** "Goal: move file A to B, delete file C, add resolver D"; or "Goal: move `components/foo/` to `components/bar/`." That is a commit list disguised as a Goal. The Goal is the *why* and the *what*; the *how* belongs in Commits. Mixing them forces the reader to read both twice, and a Goal expressed in code moves cannot be read by anyone who is not already familiar with the codebase.

**Fix:** State the Goal at the domain level, without file paths. It should be legible to someone who knows the domain but has not opened the repo. File paths belong in Current surface area, file trees, and Commits.

## Scope anti-patterns

### Plans that span multiple discrete features

**Why it fails:** A plan covering five mixed phases loses detail at every phase to save space overall. The executor reading Phase 4 has to swim past Phases 1–3 every time, and the tree drifts because no commit gets enough surface-area attention.

**Fix:** Split. Use one of the canonical patterns:
- Migration → features
- Infrastructure → consumers
- Deprecation → replacement

The dependent plan starts with a `Depends on:` line in front matter.

### Scope mismatch (scope declared does not match content)

**Why it fails:** A plan checked into a repo is not automatically project-scoped just because the file lives there. Scope is determined by who will execute it and against what surface; declaring one scope while writing for another produces a doc that misleads everyone.

| Declared `Scope:` | Symptom of mismatch |
|---|---|
| `model` | Body reaches outside the model's surface; touching unrelated tables, cross-cutting services, frontend components. Re-scope to `subsystem` or `cross-stack`. |
| `subsystem` | Body uses placeholder names (`Resource`, `useFollowActions`) instead of real codebase symbols. The plan reads like a template. Either re-scope to `cross-repo`, or specialize the body to the actual codebase. |
| `cross-stack` | Body is heavy on one feature's domain nouns and light on cross-feature concerns. Probably belongs as a `subsystem` plan instead. |
| `project-meta` | Body names a specific feature's symbols (`ResourceCard`, `useResourceActions`). `project-meta` plans are workflow/process/infra; feature nouns should not appear. Either move the work into a `subsystem` plan or abstract the noun ("any consumer hook of the actions registry"). |
| `cross-repo` | Body cites real codebase file paths, internal helper names, project-only convention docs. The plan will not transplant cleanly. Genericize before shipping; same depth gate as a global skill. |

**Fix:** Pick the scope that matches the content. Update the front-matter `Scope:` field, the file location (move it if needed), and run a grep pass to confirm body identifiers match the declaration. See SKILL.md "Step 3: Decide the plan's scope" for the verification rule.

### Plans without a scope-boundary section

**Why it fails:** Without an explicit "Out of scope (noted for future)" list, scope creep is guaranteed. Every interesting tangent the developer notices during execution becomes a question the executor has to relitigate.

**Fix:** List what is NOT in scope, with a one-line "why deferred" and a pointer to where the follow-up would happen.

### TBD or "to be determined during execution"

**Why it fails:** A plan with TBDs is a suggestion, not a plan. The executor will hit them mid-flight and either guess (wrong) or stall (slow).

**Fix:** Stop drafting and run another interrogation pass on the unresolved branch. Resolve it in conversation, then return to drafting. If the answer truly requires production data or a teammate's input that is not yet available, the plan is not ready. Keep `Status: Draft` (the enum is closed; do not invent modifiers) and put the blocker in the `Context:` line; e.g., `Context: <one-sentence framing>; blocked on <input from X>`.

## Structural anti-patterns

### No front matter

**Why it fails:** The plan is undatable and unauditable. Six months later no one knows when it was written, when it was last reviewed, or whether it shipped.

**Fix:** Include all five fields: Status, Scope, Date, Last reviewed, Context. Update Last reviewed on every non-trivial edit.

### Abstract steps

> "Refactor the achievement logic."

That is not a step. The executor cannot tell when it is done.

**Fix:** Name the file, the operation, and the outcome.

> "Delete `components/achievement/edit-list.tsx` and remove its import from `app/(root)/admin/records/(lists)/achievements.tsx`. Verify with `grep` finds zero references to `EditList` outside `__generated__/`."

### No before/after file trees

**Why it fails:** The executor has to reverse-engineer the transformation from prose. Much higher error rate; reviewers cannot tell whether the prose is internally consistent.

**Fix:** Always include both trees when files are created, moved, renamed, or deleted. See `file-tree-annotations.md`.

### Silent convention reliance

**Why it fails:** If the plan creates a component but does not state "follow [convention X]," the executor may or may not follow it. Conventions are durable until they are not, and the cold-handoff session may not know the latest house style.

**Fix:** Cite the doc. "Follow the project's component composition conventions in `<convention-doc-path>`." Do not paraphrase the convention; link it.

### No gates between sections

**Why it fails:** Produces broken intermediate states. PRs become unreviewable; rollback becomes ambiguous; CI fails halfway through and the executor does not know which commit poisoned the tree.

**Fix:** Between every major section (phase boundary, grouped commits), require the project's full validation command to pass. If a step legitimately cannot be atomic, split it until it can, or introduce a temporary compatibility shim that the final step removes.

### Mixing decisions and mechanics

**Why it fails:** Keep "here's what to do" separate from "here's why." The executing session wants the first; the future reviewer wants the second. Mixing them forces both audiences to filter past the other.

**Fix:** Mechanics live in Commits. Decisions live in Goal, Domain context, Open/Answered questions, and the Interrogation log. If a single line is doing both, split it.

### Burying the status

**Why it fails:** If the plan is partially executed and the status is buried in a paragraph, readers cannot tell what is done. They re-do work or skip work that was not actually done.

**Fix:** Front-matter `Status:` field plus per-commit progress glyphs (`✅` / `🔶` / `❌` / `🚫`) on the commit list itself. The opening of the plan should answer "is this done?" in one glance. Progress glyphs go on the commit list or section headers, never inside file-tree nodes (file-tree symbols are a separate vocabulary; see SKILL.md "Status glyphs" hard rule).

### Never updating Last reviewed

**Why it fails:** A plan that has not been reviewed in a year may be wrong. The reader needs that signal so they know whether to trust file paths and decisions.

**Fix:** Update `Last reviewed` on every non-trivial edit. If the plan is being read but not edited, and it still looks correct, update it anyway with a one-line "verified still accurate" note.

## Anti-patterns the plan must omit

These are not flaws in plan structure; they are content that does not belong in a plan at all.

### Rollout / delivery strategy

How the work ships; one PR vs many, which branch lands first, feature-flag staging, who reviews; is decided **after** planning, not during it. At plan-writing time the final packaging is unknown; guessing locks the executor into decisions that should stay flexible.

| Belongs in plan | Belongs in PR description / release notes |
|-----------------|-------------------------------------------|
| `**Gate:** Resolver removal (Commit 6) must merge and deploy before table drop (Commit 7).` | `## Rollout: Ship Commits 1-5 as PR #1, then Commits 6-7 as PR #2 gated by product sign-off.` |

The first is durable technical truth. The second is a premature packaging decision that will be wrong by the time the work starts.

### Restating workflow conventions

The repo already has durable conventions that apply to **every** change (commit format, branching rules, hook policy, atomic-commit discipline). A plan that repeats them adds noise and implies they are plan-specific (they are not). **Assume them.** Mention a workflow rule only when the plan deliberately deviates; and that deviation needs a justification.

### Meta-commentary

Skip "this plan was discussed on 2026-04-20," "reviewed by Alice," "approved by Bob." Git history records authorship; PR review records approval. The plan is the what-and-how, not the who-and-when.
