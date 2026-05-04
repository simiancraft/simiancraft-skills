---
name: how-to-plan
description: Plans self-destruct when shipped (the Inspector Gadget Rule). Use this skill to draft tactical, hand-off-ready planning docs with a 150-word Goal cap, atomic commit steps with verification gates, before/after file trees, and a two-key handshake before deletion. Trigger on "plan this", "write a plan for X", "draft a plan", "make a plan", "plan a refactor", "plan a migration", "plan a deprecation", "design the implementation", "write a PLAN.md", or when scoping multi-commit feature work that needs hand-off. Skip for: subscription plans, query execution plans, quarterly roadmaps, billing plans, sprint plans, test plans (QA matrices).
---

# How to Plan

A plan is the contract between the session that designs the work and the session that executes it. It only works if it is explicit enough to hand off cold to a fresh agent or a junior engineer who has none of your conversation context.

This skill encodes the methodology for producing such plans. Follow it in order.

## Workflow at a glance

1. **Interview** the developer using the interrogation protocol below. No prose until every branch of the decision tree has a settled answer.
2. **Split.** One plan, one discrete feature. Split early if multiple heavy phases would otherwise share a doc.
3. **Decide the plan's scope** (`model` / `subsystem` / `cross-stack` / `project-meta` / `cross-repo`). Scope governs both what the body may reference and where the file lives.
4. **Name the file** descriptively. Never `PLAN.md`.
5. **Draft** the plan with required front matter, required sections, ASCII file trees, and atomic commit steps with verification gates.
6. **Execute** against the plan; mark progress with status glyphs.
7. **Self-destruct** the plan via the two-key Inspector Gadget Rule when work is verifiably done.

Each step is detailed below. References in `references/` carry the long-form templates and anti-patterns.

## Step 1: Interrogate before drafting

**No code is authored until the plan is airtight.** An airtight plan is one a weaker model could execute to a correct outcome without asking a follow-up question. Write for the dumbest plausible executor, not for the author.

Reaching that bar requires interrogation. Before drafting any plan prose, interview the developer about every branch of the design tree until shared understanding is reached.

### The interrogation protocol

1. **Ask one question at a time.** Never batch. The answer to Q1 reshapes Q2; asking both at once wastes the answer to the first.
2. **For each question, propose the recommended answer.** Not "what should we do about X?"; "I would do X because Y; does that match your intent?" Confirmation, correction, and elaboration are all higher-signal than a blank prompt.
3. **Walk the decision tree branch by branch.** Resolve upstream choices before moving laterally. If a downstream choice depends on an upstream decision, settle the upstream one first.
4. **Explore the codebase instead of asking** whenever a question can be answered by reading files. Burning the developer's time on facts you can look up is rude and slow.
5. **Do not stop early.** Drafting with unresolved questions guarantees the executor will hit them mid-flight and either guess (wrong) or stall (slow). Neither is acceptable.

Only when every branch has a settled answer; scope, domain model, file paths, data shapes, edge cases, out-of-scope items, ordering; begin drafting. Never paper over a gap with `TBD`; a plan with a TBD is a suggestion, not a plan.

> **Note:** This protocol is adapted from the standalone `grill-me` skill. If `grill-me` (or an equivalent) is installed in the host environment, prefer invoking it; the protocol above is inlined here so this skill works without external skill dependencies.

## Step 2: Split; one plan, one discrete feature

A plan describes a single discrete feature or action. When work grows large enough to contain multiple heavy phases that could each stand alone, split it into multiple plans that reference each other. This is the most important structural choice while drafting.

Goal: keep each plan **as detailed as possible but as bounded as possible**. A plan covering five mixed phases loses detail at every phase to save space overall; two plans, each covering a tighter slice, stay dense where it matters.

Typical split patterns:

| Pattern | First plan | Second plan |
|---------|-----------|-------------|
| Migration → features | Migrate the data/schema/structure | Build features that assume the new shape |
| Infrastructure → consumers | Scaffold the new infrastructure (registry, service, abstraction) | Migrate each consumer onto it |
| Deprecation → replacement | Remove the deprecated surface | Build the replacement (or vice versa, per ordering constraint) |

How to split:

1. Look at the projected commit list. If a natural seam exists where the next batch of commits depends on prior commits being **shipped and live** (not just code-complete), that is a split point.
2. The dependent plan starts with a `Depends on:` line in the front matter naming the prior plan and the state it must have reached. Example: *"Depends on: `migrate-resource-schema.md` fully shipped and deployed; `legacy_resources` table dropped."*
3. Each plan self-destructs independently when **its own** work completes.

**Judgment, not a rule.** Three tight phases that share context and edit the same files are fine in one plan. Three heavy phases that touch disjoint file sets, each with its own surface-area inventory, should split. When in doubt, split. A too-small plan is cheap; a too-big plan stays painful the whole time.

## Step 3: Decide the plan's scope (scope-aware encapsulation)

A plan's *scope* governs both what its body may reference and where the file lives. A plan checked into a repo is not automatically project-scoped just because the file is there; scope is determined by who will execute it and against what surface. Pick one scope before drafting; declare it as the `Scope:` front-matter value. The five canonical scopes are:

| `Scope:` value | Lives at | Body may reference |
|----------------|----------|--------------------|
| `model` | `<models-or-db-dir>/<model>/<plan>.md` | The model and its near-neighbors only. Don't reach across the data layer. |
| `subsystem` (one folder, one concern; includes monorepo packages) | `<feature-or-package>/<plan>.md` | Real symbol names, domain nouns, internal helpers, real file paths. **Anchor to the codebase:** that's the value. |
| `cross-stack` | Repo root | Project-internal identifiers freely. Default for anything spanning frontend + backend, or large enough to need persistent state across multiple agent sessions. |
| `project-meta` | Repo root or `docs/process/` | Repo-level configs, workflow files, CI/release tooling, durable convention docs. **Avoid feature-domain nouns:** the plan affects all features but is owned by none. |
| `cross-repo` | Template repo or shared docs | Generic placeholder names; abstract patterns; no codebase-specific helpers. Same depth gate as a global skill. |

**Rule of thumb:** bigger than a breadbox and needs a planning doc to persist state across multiple agent sessions → `cross-stack` at repo root, unless it cleanly belongs to one folder (`subsystem`) or one model (`model`). A monorepo package counts as a `subsystem`; a plan touching one package lives inside that package; a plan touching many is `cross-stack` at the monorepo root.

**Verification:** before the draft is "ready," grep the body against the declared scope. `cross-repo` plan with project-specific paths → genericize. `subsystem` plan reading like a template → specialize. `project-meta` plan that names a feature's symbols → either move into a `subsystem` plan or abstract the noun. Mismatch = draft, not plan.

## Step 4: Name the plan file

**Never name a plan file `PLAN.md`.** Generic names do not survive; six months later no one can tell what the plan was about without opening it, and greps for feature names miss it.

The filename must describe what the plan *does*. Use kebab-case, imperative-ish phrasing.

| Good | Bad |
|------|-----|
| `deprecate-legacy-mocks.md` | `PLAN.md` |
| `refactor-field-resolvers-pattern.md` | `plan.md` |
| `migrate-image-uploads-to-s3-presign.md` | `notes.md` |
| `onboarding-experience-flow.md` | `refactor.md` |

File placement follows the `Scope:` chosen in Step 3; see the scope-table column "Lives at."

## Step 5: Draft the plan

Every plan needs the same front matter and the same ordered sections.

### Required front matter

```markdown
# <Short, Descriptive Title>

**Status:** Draft | In progress | Descoped | Archived
**Scope:** model | subsystem | cross-stack | project-meta | cross-repo
**Date:** YYYY-MM-DD              <!-- original authorship date -->
**Last reviewed:** YYYY-MM-DD     <!-- bump on every non-trivial edit -->
**Context:** <one sentence naming the problem and why it matters now>
**Depends on:** `<other-plan-filename>.md` …    <!-- optional; include only when this plan starts after another plan ships -->
```

The `Status` enum is closed; do not invent modifiers (`Draft; blocked on X`). If a plan is blocked, keep `Status: Draft` and put the blocker in the `Context:` line.

The `Scope:` field is set in Step 3 and governs what the body may reference.

Update `Last reviewed` on every non-trivial edit; a stale plan is a trap. If you read a plan without editing it and it still looks correct, bump `Last reviewed` anyway with a one-line `# verified still accurate` note in the front matter; that signal protects future readers from second-guessing.

`Depends on:` is included only when the plan needs another plan **shipped and live** before this one starts. Name the prior plan and the state it must have reached: *"Depends on: `migrate-resource-schema.md` fully shipped and deployed; `legacy_resources` table dropped."*

### Required sections, in order

1. **Goal:** north star. One short paragraph. See "The Goal section" below; most load-bearing part of the document.
2. **Domain context:** 3–5 concepts the reader must hold in their head, defined even if "obvious."
3. **Current surface area:** inventory of every file, table, route, component, or export the plan touches. Use tables; cite paths; count lines where size matters.
4. **File structure: before:** ASCII tree of starting state for every directory the plan touches. *Required only when the plan creates, moves, renames, splits, or deletes files; omit if the plan only changes schema rows, process docs, or in-place content with no structural shift.*
5. **File structure: after:** ASCII tree of end state. Annotate each transformed node with the legend symbol; place a `**Legend:**` line directly above the tree, trimmed to operation symbols actually used; carry lineage in `// from …` notes. **Canonical legend, mutex table, and combinable annotations live in `references/file-tree-annotations.md`:** load it once and treat it as authoritative; the symbol set is not duplicated here to prevent drift. *Same omission rule as the before-tree.*
6. **Commits:** ordered, atomic execution steps. See "Step quality" below.
7. **Verification checklist:** final gate; every box must check before "done."
8. **References:** file paths to related plans, project docs, external URLs.

Situational sections (include when relevant):

- **Data flow diagram** when the plan changes how data moves.
- **Domain categories** when the plan disambiguates concepts.
- **Target state per item** when many items each migrate to a different shape (before→after table per row).
- **Open questions** + **Answered questions** (track decisions explicitly).
- **Interrogation log** for plans shaped across multiple design sessions.
- **Anti-patterns / scope boundaries:** what is explicitly NOT in scope.

### The Goal section: north star, not a summary

This is the single most important paragraph in the document; more than file trees, more than the commit list. Everything downstream derives meaning from the Goal.

The Goal must answer three questions, in order:

1. **Why does this plan exist?** What problem or opportunity triggered writing it. Not "we want to refactor X"; *why* we want to refactor X, what is wrong today, what is blocked, what is rotting.
2. **What are we doing about it?** One sentence naming the intervention. Not the mechanics; just the shape: "move X into Y," "deprecate X in favor of Y," "introduce a Y to replace the implicit X."
3. **What does done look like?** A one-paragraph description of the desired end state, concrete enough that a cold reader can recognize whether the current code matches.

**Cap the Goal at ~150 words.** A Goal that runs longer is doing someone else's job.

The Goal is the reference point both author and executor consult to answer two recurring questions:

- *"Are we still on scope?"*; Every commit, every file change, every suggested tangent gets measured against the Goal. If a proposed change does not advance the Goal, it does not belong in this plan. (It might still be a good idea; split it into a different plan.) Scope creep happens when the Goal is soft.
- *"Are we done? Should this plan self-destruct?"*; Read the Goal, compare it against current file state and commit history. If the desired end state already matches reality, the plan is done (or was never needed). If the gap is narrowing but not closed, the plan is mid-flight. This only works if the Goal is concrete enough to check against the code.

### File structure diagrams

Non-negotiable when the plan creates, moves, renames, or deletes files. The before/after trees are the single most important transformation aid for the executing session; they let the executor reason about "this turns into that" without juggling prose.

### Step quality

Each step states:

- **What happens:** create file, delete file, move file, rewrite file, update import, regenerate artifact. No abstract verbs ("refactor the thing").
- **Which files:** exact paths, not "the relevant files."
- **What the file contains:** for new files: exports, types, key patterns. For rewritten files: before/after sketch or enough signal that the executor can reproduce the change.
- **Gate:** the verification that must pass before the next step begins. Usually the project's full validation command. May also include: a specific test subset, a Storybook story renders, a `grep` returns zero matches, etc.

Step template (use only the file-action subsections that apply; omit empty ones):

```markdown
### Commit N: <imperative-tense summary>

**Goal:** <one sentence>

**Files created:**
- `path/to/new-file.ts`: <one-line purpose>

**Files rewritten:**
- `path/to/existing.tsx`: <what changes, in one sentence>

**Files moved/renamed:**
- `path/to/new.ts ← path/to/old.ts`: <one-line purpose if non-obvious>

**Files deleted:**
- `path/to/deadcode.ts`

**Gate:** <project validation command> passes. <Any additional verification.>
```

The `Files moved/renamed:` subsection mirrors the `🔀 new ← old` notation from `references/file-tree-annotations.md`, so the commit text and the file tree describe the same operation in the same shape.

**No `Files split:` subsection**; splits decompose into existing subsections. The split source goes under `Files rewritten:` (if it survives the split) or `Files deleted:` (if it goes away); the targets go under `Files created:` with `// from 🪓 <source-path>` notes. The `🪓` symbol carries the split semantics in the file tree; the commit text uses the regular subsections. This is the same trade-off `merge` makes (no symbol; lineage via `// from a + b`).

#### Sub-letter commits (3a / 3b / 3c)

When several commits share the same shape; same file-action subsections, same Gate, same template; and differ only by a single swap (which mutation, which model, which consumer), number them with sub-letters tied to one parent number:

```markdown
### Commit 3a: <imperative for first variant>
…full step body…

### Commits 3b, 3c, 3d: <other variants> (same shape)

Each follows Commit 3a's template verbatim with the <swap> name swapped. Three separate commits, each with its own Gate; do not collapse into one.
```

Use sparingly: only when the commits are genuinely identical except for the swap. The first sub-letter (`3a`) is shown concretely with all subsections and a Gate; the rest get a one-line note. This keeps the parent number tied to the conceptual unit ("the per-action migration") instead of spraying eight sequential numbers across what is one step's worth of intent.

Between major sections (phase boundary, grouped commits), the gate is **all checks pass**: the project's full validation command at minimum; add scoped tests, Storybook smoke, or a grep assertion when the change touches those layers.

### Status glyphs (track-progress markers)

Use these to mark *progress through the plan's commits or sections* in long-running plans; not to mark file-operation outcomes (the file-tree legend covers that):

| Marker | Meaning |
|--------|---------|
| ✅ | Complete |
| 🔶 | Partial / In progress |
| ❌ | Not started |
| 🚫 | Descoped / will not do |

**Hard rule; no cross-pollination between systems:**

- File-op symbols (the legend in `references/file-tree-annotations.md`) **never** appear in commit checklists, status tables, or anywhere outside file trees.
- Progress glyphs (`🔶` `✅`) **never** appear inside file-tree nodes. *(`🔶` and `✅` exist in the file-tree legend only for the long-running-plan sub-case where the legend is doing double duty as a per-node progress indicator; in that case the tree IS a checklist. Never mix the two functions in one tree.)*
- The overlap of `❌` and `🚫` is permitted because both senses converge on "gone / not happening," and the surrounding context (a tree node vs. a checklist row) disambiguates without ambiguity. When both appear in one tree, gloss them inline (see `file-tree-annotations.md`).

## Step 6: What does NOT belong in a plan

Leaving the wrong things out is as important as putting the right ones in. Every paragraph spent on the wrong topic is a paragraph the executor skims past.

### Do not include rollout / delivery strategy

How the work ships; one PR vs many, which branch lands first, feature-flag staging, who reviews; is decided **after** planning, not during it. At plan-writing time the final packaging is unknown; guessing locks the executor into decisions that should stay flexible. Commit order within the plan is about **technical correctness** (nothing breaks between commits), not delivery logistics.

If the work has genuine deploy-order constraints, state them as **technical dependencies inside the relevant commit's Gate**, not as a separate rollout section.

| Good | Bad |
|------|-----|
| `**Gate:** Resolver removal (Commit 6) must merge and deploy before table drop (Commit 7). Don't drop the table while old resolvers still query it.` | `## Rollout notes: We'll ship Commits 1-5 as PR #1, then Commits 6-7 as PR #2 gated by product sign-off…` |

### Do not restate workflow conventions

Most repositories already have durable conventions that apply to **every** change (commit format, branching strategy, hook policy, atomic-commit discipline). A plan that repeats them adds noise and implies they are plan-specific (they are not). **Assume them.** Mention a workflow rule in a plan only when the plan deliberately deviates; and that deviation needs a justification.

### Do not pad with meta-commentary

Skip "this plan was discussed on 2026-04-20," "reviewed by X," "approved by Y." Git history records authorship; PR review records approval. The plan is the what-and-how, not the who-and-when.

## Step 7: The Inspector Gadget Rule; plans self-destruct when done

Plans are **tactical, disposable artifacts:** like the self-destructing notes in *Inspector Gadget*. They exist to coordinate one piece of work. When the work is done, the plan is no longer truth; it is a snapshot of what was about to happen, which now rots in place and misleads future readers.

**Delete the plan file as the final step of the work.** Not "archive it." Not "move it to a `done/` folder." Not "leave it with a `Status: Archived` header." Delete it.

**The deletion is its own atomic commit, not folded into the feature's last code commit.** Atomic-commit projects want the deletion as a separate, reviewable change so the diff is easy to read and easy to revert if needed. The "delete this plan" commit is the canonical Commit N+1 in every plan's commit list.

### What gets deleted, exactly

The agent deletes **exactly the file at the path declared in the plan's front-matter filename, and no other paths**. The plan's filename is the one the plan was created with (e.g. `features/resources/split-resource-actions-hook.md`); deletion of any other file; sibling docs, "stale" notes, related plans; is out of scope for this protocol and requires its own justification.

### Two-key handshake (mandatory)

Deletion is a two-key event; both developer and agent must agree. Failure modes go both ways:

- **Agent deletes too early:** all checks pass, agent is confident, but developer wanted to validate one more edge case. The plan is gone, the executing session has lost its map, the developer is annoyed.
- **Nobody deletes:** both sides assume the other will clean up, the plan rots in tree for six months until someone opens it and is misled by stale paths.

Protocol:

1. The agent proposes deletion **only when all of the following are true**:
   - Every commit in the plan has shipped.
   - The verification checklist passes in full.
   - The project's full validation command (and any domain-specific gates) is green.
2. The agent states the proposal explicitly: *"All verification items pass and the work appears complete. May I delete the plan file at `<exact path from front matter>`, or do you want to hold off?"*
3. The developer confirms with an **explicit confirmation phrase:** any unambiguous affirmative that names the action or unmistakably refers to the agent's proposal. Examples that count: `"confirm delete"`, `"yes, delete it"`, `"go ahead and delete"`, `"yep delete"`, `"do it"`, `"ship it"`, `"yes"` (only as a direct response to the agent's proposal turn). **Ambiguous standalone responses (`"sure"`, `"looks good"`, `"nice work"`, `"great"`) do NOT count as confirmation:** the agent must re-prompt with the explicit question.
4. **Only on explicit developer confirmation** does the agent delete the file and commit the deletion. No implicit approval. **Before issuing the delete**, the agent verifies the candidate path: (a) ends in `.md`, (b) is repo-relative (not absolute, not parent-of-repo), (c) currently exists in the working tree, and (d) matches the path declared in the plan's own front matter. If any check fails, the agent does not delete and surfaces the mismatch.

If the developer says "this is totally done" without the agent having proposed deletion, the agent still confirms the checklist passes before acting; "done" is a signal to verify-then-propose-then-delete, not to delete blind. Same path check applies.

If the developer says "delete it" *before* the agent has proposed deletion (developer-ahead-of-protocol), the agent still runs the verification (every commit shipped, checklist passes, validation green, path checks pass). If verification passes, the developer's instruction counts as the confirmation; if any check fails, the agent surfaces what's not green and does not delete.

**Dangling-handshake fallback.** If the developer is not present to confirm (the agent is running in a long unattended session, or the user has stepped away without responding), the agent **leaves the plan file in place and does not delete unilaterally**. A plan rotting in the tree briefly is preferable to deleting in error. The agent may note in its session output that the plan is ready for deletion pending confirmation.

### Why deletion, not archival

- **Plans rot.** File paths move, conventions change, decisions get reversed. An archived plan is a loaded gun pointed at future readers who assume it is current.
- **Commit history is the archive.** Every plan is preserved in git. `git log --diff-filter=D -- <plan-file>` finds it. A file sitting in the tree is not.
- **The durable output is the code.** The plan's job was to make the code correct. Once the code is correct, the plan has nothing left to contribute.

### What stays (does not self-destruct)

- **Convention docs** in `docs/` (or equivalent); describe how things work, not what to do next. If a plan produced a new convention worth keeping, extract it into the convention layer **before** deleting the plan.
- **Rule files / agent guidance docs:** durable.
- **Skill docs:** durable.

### Inspector Gadget Rule artifacts to include in every plan

Add a Self-destruct step as the literal last item of the Commits section and the Verification checklist:

```markdown
### Commit N+1: Delete this plan

- Delete `<this-plan-filename>.md`.
- If any convention is worth keeping, extract it to the project's convention docs first in a prior commit.

**Gate:** Project validation passes. Repo contains no references to the plan file.
```

```markdown
## Verification checklist
- [ ] …
- [ ] Plan file deleted (Inspector Gadget Rule: no orphan plans).
```

### Exception: never-completing processes

A plan describing a **never-completing** process (a rolling migration that runs whenever a new model is added) belongs in the convention docs, not as a plan file. Convert it; do not leave it as `PLAN.md`.

## Reference index

Load on demand based on what the current draft needs:

| Need | Read |
|------|------|
| Minimum-viable plan skeleton + required front matter | `references/plan-template.md` |
| ASCII before/after tree conventions and a worked example | `references/file-tree-annotations.md` |
| Anti-patterns to avoid (Goal mistakes, scope mistakes, structure mistakes) | `references/anti-patterns.md` |
| End-to-end worked plan (placeholder names, complete shape) | `references/example-plan.md` |

## Acceptance criteria for a plan

A plan is complete when all of the following hold:

- Front matter present (Status, **Scope**, Date, Last reviewed, Context).
- `Scope:` declared as one of `model | subsystem | cross-stack | project-meta | cross-repo`, and the body identifiers match it (`subsystem`/`cross-stack` plans cite real names; `cross-repo` plans use generic placeholders; `project-meta` plans avoid feature-domain nouns; `model` plans stay inside one model's surface).
- File location matches declared scope per Step 3's table.
- Goal is ≤150 words and answers why-now / what-intervention / what-done-looks-like.
- All required sections present in order.
- Before/after trees included if any files are created, moved, renamed, or deleted, with annotations.
- Every commit step names exact file paths, what changes, and a Gate.
- Section gates require the project's full validation command to pass.
- Final commit is "Delete this plan" and the verification checklist includes plan-file deletion.
- No `TBD` markers, no rollout sections, no restatement of standing conventions, no meta-commentary.
- Filename matches kebab-case verb-phrase rule.

If any item fails, the plan is a draft, not a plan.
