# Plan Template

Copy this skeleton when starting a new plan. Fill every section. Never ship a plan with `TBD` markers; see `anti-patterns.md`.

## Minimum viable plan (all required sections)

````markdown
# <Short, Descriptive Title>

**Status:** Draft
**Scope:** model | subsystem | cross-stack | project-meta | cross-repo
**Date:** YYYY-MM-DD              <!-- original authorship date -->
**Last reviewed:** YYYY-MM-DD     <!-- bump on every non-trivial edit -->
**Context:** <one sentence naming the problem and why it matters now>

<!-- Scope governs what this plan's body may reference. See SKILL.md "Step 3: Decide the plan's scope". -->
<!-- Optional, only when this plan depends on another: -->
**Depends on:** `<other-plan-filename>.md` fully shipped and deployed; <state the prior plan must have reached>.

---

## Goal

<One paragraph, ≤150 words. Answer in order:>
<1. Why does this plan exist? What is wrong/blocked/rotting today.>
<2. What are we doing about it? One-sentence intervention shape.>
<3. What does done look like? Concrete enough that a cold reader can recognize it.>

## Domain context

<3-5 concepts the executor must hold in their head. Define each, even if "obvious"; the executor may not share your context.>

- **Concept A:** definition.
- **Concept B:** definition.
- **Concept C:** definition.

## Current surface area

<Inventory of every file, table, route, component, or export the plan touches. Include line counts where size matters.>

| Path | Kind | Lines | Notes |
|------|------|-------|-------|
| `path/to/file.ts` | source | 247 | central to the change |
| `path/to/other.ts` | source | 89 | imports the symbol being renamed |
| `db/migrations/0042_x.sql` | migration | – | last migration touching `resources` |

## File structure: before

**Legend:** ❌ deleted  <!-- trim to operation symbols actually used in this tree; renames surface only on the after-tree -->

```
<root>/
├── feature/
│   ├── component-a.tsx                        # gains absorbed helpers logic; see after-tree
│   ├── component-a.stories.tsx
│   └── ❌ helpers.ts                          // logic absorbed into component-a.tsx
└── shared/
    └── registry.ts                            # will rename; see after-tree
```

## File structure: after

**Legend:** 🆕 new · ✏️ rewritten · 🔀 moved/renamed

```
<root>/
├── feature/
│   ├── ✏️ component-a.tsx                    // absorbed helpers.ts
│   ├── component-a.stories.tsx
│   └── 🆕 component-b.tsx                     // <one-line purpose>
└── shared/
    ├── 🔀 new-registry.ts ← registry.ts
    └── 🆕 adapters/
        └── 🆕 default.ts
```

Bidirectional lineage holds: `❌ helpers.ts // logic absorbed into component-a.tsx` (before) ↔ `✏️ component-a.tsx // absorbed helpers.ts` (after). Either tree alone is self-contained.

Symbols, lineage notes (`←`, `→`, `// from …`), and the inline-legend rule are defined in `file-tree-annotations.md`. Trim each `**Legend:**` line to the symbols that actually appear in its tree.

## Commits

<Atomic, ordered, working-state-to-working-state. Each commit's Gate must pass before the next begins.>

### Commit 1: <imperative-tense summary>

**Goal:** <one sentence>

**Files created:**
- `<path>`: <one-line purpose>

**Files rewritten:**
- `<path>`: <what changes, in one sentence>

**Files moved/renamed:**
- `<new-path> ← <old-path>`: <one-line purpose if non-obvious>

**Files deleted:**
- `<path>`

**Gate:** <project validation command> passes. <Any additional verification.>

<!-- Use only the file-action subsections that apply; omit empty ones. -->
<!-- The `← old-path` arrow on moves/renames matches the `🔀` notation in file-tree-annotations.md. -->

### Commit 2: <imperative-tense summary>

…

### Commit N+1: Delete this plan

- Delete `<this-plan-filename>.md`.
- If any convention is worth keeping, extract it to the project's convention docs first in a prior commit.

**Gate:** Project validation passes. Repo contains no references to the plan file.

## Verification checklist

- [ ] Project validation command passes on every commit.
- [ ] <domain-specific assertion 1>
- [ ] <domain-specific assertion 2>
- [ ] Plan file deleted (Inspector Gadget Rule: no orphan plans).

## References

- Related plans: `<path>`
- Convention docs: `<path>`
- External: <URL>
````

## Optional sections (include when relevant)

### Open questions

```markdown
## Open questions

- **Q1:** <question>
  - **Context:** <link or paragraph>
  - **Tentative answer:** <best guess if any>
- **Q2:** …
```

### Answered questions

```markdown
## Answered questions

- **Q1 (resolved YYYY-MM-DD):** <question> → <decision>. Rationale: <one line>.
- **Q2 (resolved YYYY-MM-DD):** <question> → <decision>. Rationale: <one line>.
```

Never delete answered questions; they are the future reviewer's shortcut.

### Interrogation log

For plans that survive multiple design sessions. Lets future reviewers evaluate whether the conditions that shaped a decision still hold.

```markdown
## Interrogation log

### Session YYYY-MM-DD

- Decision: <X>. Driver: <constraint or stakeholder>. Alternative considered: <Y>. Why rejected: <reason>.
- Decision: …
```

### Out of scope (anti-patterns / scope boundaries)

Without this section, scope creep is guaranteed.

```markdown
## Out of scope (noted for future)

- **<Item>:** deferred because <reason>. Likely follow-up: <pointer>.
- **<Item>:** deferred because <reason>. Likely follow-up: <pointer>.
```

### Data flow diagram

Include when the plan changes how data moves. Use ASCII or Mermaid; match the surrounding repo's conventions.

### Target state per item

When many items each migrate to a different shape, use a per-row table:

```markdown
| Item | Before | After | Notes |
|------|--------|-------|-------|
| `resource-a` | URL string in DB | JSON config in registry | drop `resource_a_url` column |
| `resource-b` | URL string in DB | JSON config in registry | drop `resource_b_url` column |
```
