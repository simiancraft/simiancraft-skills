# Worked Example: A Complete Plan

A reference plan using placeholder names. Study the shape, not the domain. The patterns transfer to any feature, refactor, migration, or deprecation.

This example covers a moderate-complexity refactor: extracting the resource-action surface from one monolith into per-action files, and introducing a dispatcher hook.

The plan declares `Scope: subsystem` and lives at `features/resources/split-resource-actions-hook.md` (co-located with the feature folder it refactors).

---

````markdown
# Split monolithic resource-actions hook into per-action files

**Status:** Draft
**Scope:** subsystem
**Date:** 2026-04-15              <!-- original authorship date -->
**Last reviewed:** 2026-04-15     <!-- bump on every non-trivial edit -->
**Context:** A single 870-line `use-resource-actions.ts` hook serves five distinct mutations and three local-state branches; every consumer relays through it, which has produced two regressions in the last quarter where one mutation's logic broke another's.

---

## Goal

The resource-action surface is a single 870-line monolith with five mutations and three local-state branches; one mutation's logic has broken another's twice in the last quarter. Replace the monolith with a per-action structure where each mutation owns its own home, composed by a thin dispatcher that preserves today's consumer-facing shape exactly. Done = no monolith remains; each mutation has a single-purpose home; consumer call sites are byte-identical to today; existing test bodies pass without modification.

## Domain context

- **Resource:** the editable entity owned by a workspace; rendered by `ResourceCard` and edited by `ResourceEditor`.
- **Resource action:** a single mutation operating on a Resource (`createResource`, `renameResource`, `deleteResource`, `archiveResource`, `restoreResource`).
- **Dispatcher hook:** a hook that composes the per-action hooks and returns a single object; consumers do not import individual actions.
- **Consumer:** any component that calls `useResourceActions()` today; there are 11 of them, listed in Current surface area.

## Current surface area

| Path | Kind | Lines | Notes |
|------|------|-------|-------|
| `features/resources/use-resource-actions.ts` | hook | 870 | the monolith |
| `features/resources/use-resource-actions.test.ts` | test | 340 | covers all five mutations |
| `features/resources/resource-card.tsx` | consumer | 180 | calls `useResourceActions()` |
| `features/resources/resource-editor.tsx` | consumer | 410 | calls `useResourceActions()` |
| 9 other consumers under `app/` and `features/` | consumer | – | grep `useResourceActions` for the full list |

## File structure: before

**Legend:** ✏️ rewritten

```
features/resources/
├── resource-card.tsx
├── resource-card.stories.tsx
├── resource-editor.tsx
├── resource-editor.stories.tsx
├── ✏️ use-resource-actions.ts                  // five mutations extracted to actions/*.ts
└── use-resource-actions.test.ts                # unchanged
```

This is an *Extract* operation (per `file-tree-annotations.md` lineage table), not a Split: the source survives as a thinner dispatcher rather than disappearing into N targets, so it carries `✏️` not `🪓`.

## File structure: after

**Legend:** 🆕 new · ✏️ rewritten

```
features/resources/
├── resource-card.tsx
├── resource-card.stories.tsx
├── resource-editor.tsx
├── resource-editor.stories.tsx
├── ✏️ use-resource-actions.ts                  // dispatcher only, ~60 lines
├── use-resource-actions.test.ts                # unchanged in this plan
└── 🆕 actions/
    ├── 🆕 create.ts                             // extracted from use-resource-actions.ts
    ├── 🆕 rename.ts                             // extracted from use-resource-actions.ts
    ├── 🆕 delete.ts                             // extracted from use-resource-actions.ts
    ├── 🆕 archive.ts                            // extracted from use-resource-actions.ts
    └── 🆕 restore.ts                            // extracted from use-resource-actions.ts
```

## Commits

### Commit 1: Scaffold actions/ folder with empty exports

**Goal:** Reserve the per-action surface so consumers can be migrated incrementally without breaking imports.

**Files created:**
- `features/resources/actions/create.ts`: `useCreateResource(): { create: (input) => Promise<Resource> }`
- `features/resources/actions/rename.ts`: `useRenameResource(): { rename: (id, name) => Promise<Resource> }`
- `features/resources/actions/delete.ts`: `useDeleteResource(): { delete: (id) => Promise<void> }`
- `features/resources/actions/archive.ts`: `useArchiveResource(): { archive: (id) => Promise<Resource> }`
- `features/resources/actions/restore.ts`: `useRestoreResource(): { restore: (id) => Promise<Resource> }`

Lineage: each new file extracts the corresponding mutation from `features/resources/use-resource-actions.ts`. The After-tree carries the same notation (`// extracted from use-resource-actions.ts`); per SKILL.md commit text uses canonical subsections only, lineage stays in the tree.

**Gate:** Project full validation passes. Each new file exports a working hook that calls the same mutation as the monolith.

### Commit 2: Move create logic into actions/create.ts

**Goal:** Migrate the first mutation off the monolith.

**Files rewritten:**
- `features/resources/actions/create.ts`: implement using the same Apollo mutation the monolith calls; identical optimistic-update behavior.
- `features/resources/use-resource-actions.ts`: replace inline `create` implementation with a call to `useCreateResource()`.

**Gate:** Full validation. `features/resources/use-resource-actions.test.ts` passes (still using the dispatcher entry point). Manual verification: `ResourceEditor` create flow still works in Storybook.

### Commit 3a: Move rename logic into actions/rename.ts

**Goal:** Migrate the second mutation off the monolith.

**Files rewritten:**
- `features/resources/actions/rename.ts`: implement using the same Apollo mutation the monolith calls; identical optimistic-update behavior.
- `features/resources/use-resource-actions.ts`: replace inline `rename` implementation with a call to `useRenameResource()`.

**Gate:** Full validation. `features/resources/use-resource-actions.test.ts` passes. Manual: `ResourceEditor` rename flow still works in Storybook.

### Commits 3b, 3c, 3d: delete, archive, restore (same shape)

Each follows the Commit 3a template verbatim with the action name swapped. Three separate commits, each with its own Gate; do not collapse into one.

### Commit 4: Reduce dispatcher to composition

**Goal:** Strip the now-redundant inline implementations from the dispatcher.

**Files rewritten:**
- `features/resources/use-resource-actions.ts`: final state: imports the five per-action hooks, composes them into one `ResourceActions` object, returns it. Target line count: ≤80.

**Gate:** Full validation. Diff should show ~790 lines removed from the dispatcher and zero changes outside the file.

### Commit 5: Delete this plan

- Delete `features/resources/split-resource-actions-hook.md`.
- Verify no convention is worth keeping (none expected; this is a one-off refactor, not a pattern introduction).

**Gate:** Full validation. `grep -r "split-resource-actions-hook"` returns zero matches.

## Verification checklist

- [ ] Project full validation passes on every commit.
- [ ] `features/resources/use-resource-actions.ts` final line count ≤80.
- [ ] All 11 consumers continue to call `useResourceActions()` with no signature change.
- [ ] `use-resource-actions.test.ts` passes unchanged; coverage on `actions/*.ts` is ≥ pre-refactor coverage on `use-resource-actions.ts`.
- [ ] No new circular-dependency warnings.
- [ ] Plan file deleted (Inspector Gadget Rule: no orphan plans).

## Out of scope (noted for future)

- **Type-safe error union per action.** The current actions throw on failure; introducing a `Result<T, E>` shape is a separate concern. Likely follow-up: `features/resources/actions/result-types.md`.
- **Optimistic-update consolidation.** Each per-action hook duplicates a small optimistic-update pattern; that is intentional for this plan (less indirection beats DRY at this size). Revisit if a sixth mutation is added.

## References

- Existing convention: `<project-component-conventions>` (composition pattern this dispatcher follows).
- Apollo mutation hooks: `<project-graphql-conventions>`.
- Prior refactor of similar shape: git log on `features/sessions/use-session-actions.ts`.
````

---

## What this example demonstrates

- **Goal in one paragraph** names the failure mode, the shape of the intervention, and a checkable end state.
- **Atomic commits with Gates:** Commit 4 is reachable only after Commits 2–3 ship; final commit is "Delete this plan."
- **Out of scope** lists two adjacent ideas that explicitly will not happen here.
- **No rollout strategy and no restated workflow conventions:** packaging and standing rules belong elsewhere.

## Where plans live, by scope

The plan above is `Scope: subsystem`, so it co-locates with the feature folder. Other scopes land elsewhere:

```
<repo>/
├── deprecate-resource-actions.md                     (cross-stack; repo root, big enough to need persistent state)
├── db/
│   └── models/
│       └── resource/
│           └── add-archived-flag.md                  (model; narrow, lives with the model)
├── features/
│   └── resources/
│       └── split-resource-actions-hook.md            (subsystem; this example's scope and location)
├── packages/
│   └── ui-kit/
│       └── deprecate-button-variant.md               (subsystem; monorepo package counts as one subsystem)
└── docs/
    └── process/
        └── ci-release-rotation.md                    (project-meta; affects all features, owned by none)
```

Rule of thumb: bigger than a breadbox and needs to persist state across multiple agent sessions → `cross-stack` at repo root, unless it cleanly belongs to one folder (`subsystem`) or one model (`model`). A monorepo package is its own subsystem; a plan touching multiple packages is `cross-stack` at the monorepo root.
