# File Tree Annotations

Before/after ASCII trees are non-negotiable when a plan creates, moves, renames, deletes, splits, or regenerates files. They are the single most important transformation aid for the executing session; they let the executor reason about "this turns into that" without juggling prose.

This file defines the **single canonical legend** every tree in every plan must follow.

## The legend

```
🆕 new   ❌ deleted   ✏️ rewritten   🔀 moved/renamed   🪓 split
🤖 regenerated   ⚠️ deprecated   🚫 descoped
🔶 in progress   ✅ complete
```

**Combinable:** `🤖✏️` (regen-after-source-change) · `🤖🆕` (newly-generated) · `🔀✏️` (rename + rewrite). No other combinations.

| Symbol | Meaning | Mutually exclusive with |
|--------|---------|-------------------------|
| `🆕` | File or folder did not exist before this plan | `❌`, `✏️`, `🔀`, `🪓`, `⚠️` |
| `❌` | File existed; removed by this plan | every other op |
| `✏️` | File stays at the same path; contents change | `🆕`, `❌`, `🪓` (combinable: `🔀✏️` rename-and-rewrite, `🤖✏️` regen) |
| `🔀` | File moves or renames; contents largely unchanged | `🆕`, `❌`, `🪓` (combinable: `🔀✏️` when contents also change) |
| `🪓` | File becomes multiple files (split) | every other op |
| `🤖` | Codegen/build artifact; do not hand-edit, run the generator | (combinable: `🤖✏️` regen-after-source-change, `🤖🆕` newly-generated) |
| `⚠️` | File stays for now, slated for removal in a named future plan | `❌` (if removing now, use `❌`) |
| `🚫` | Was in scope, will not happen | every op |
| `🔶` | Mid-flight (long-running plans only) | `✅` |
| `✅` | Complete and shipped (long-running plans only) | `🔶` |

A node never carries two operation symbols at once except where the table marks them combinable. **Unannotated** nodes are unchanged context; included only for orientation.

## Inline-legend rule (place the legend with every tree)

Plans get excerpted: pasted into PR descriptions, screenshotted into status reports, quoted in standups. The legend must travel with the tree. Place a one-line `**Legend:**` directly above each fenced tree:

````markdown
**Legend:** ✏️ rewritten · 🆕 new

```
features/follow/
├── follow-toggle.tsx
├── ✏️ use-follow-actions.ts
└── 🆕 actions/
    ├── 🆕 follow.ts
    └── 🆕 unfollow.ts
```
````

Trim the legend to only the **operation symbols carrying nodes** in that tree (i.e., symbols prefixing a path). Symbols that appear only inside `// from …` lineage notes; like a `🪓` referring to a source file in a different tree; do not count and must not be added to the legend; the lineage convention gives them meaning by association. A tree with three new files and no deletes does not need `❌` in its legend.

When both `❌` (deleted-by-this-plan) and `🚫` (descoped) appear in the same tree, gloss them inline to disambiguate: `**Legend:** ❌ deleted-now · 🚫 descoped`.

**Once-per-plan legend** (single legend at the top of the plan, no per-tree repetition) is permitted only when *every* tree in the plan uses the *same* subset of symbols. The moment two trees diverge, switch to per-tree.

## Notes carry the data symbols can't

The symbol announces the operation; the **note** carries the per-op data the symbol can't encode. Notes follow the path with `//` (chosen to read like code) and stay one line per node.

Three rules:

1. **Symbol + path is the headline.** If the operation is self-explanatory, no note needed.
2. **Notes earn their tokens individually.** Use them for lineage (`from`, `to`, `from + from`), tool commands (regen targets), removal-in plan names (deprecation targets), and the rare non-obvious "why."
3. **Lineage is bidirectional.** When an operation has a counterpart node elsewhere in the tree, both nodes name each other. The reader who lands on either side can reconstruct the relationship without scrolling.

### Per-op note conventions

| Op | What the note must carry | Example |
|---|---|---|
| `🆕` | Origin if the file came from a split, merge, or extraction | `🆕 follow.ts  // from 🪓 use-resource-actions.ts` |
| `❌` | Where the deleted logic went (if anywhere) | `❌ helpers.ts  // logic absorbed into component-a.tsx` |
| `✏️` | One-sentence summary of what changed | `✏️ dispatcher.ts  // reduced to composition only (~60 lines)` |
| `🔀` | Old path, on the *new* node, with `←` | `🔀 dispatcher.ts ← old-actions.ts` |
| `🪓` | Targets the file becomes, with `→` | `🪓 use-resource-actions.ts → actions/{create,rename,delete,archive,restore}.ts` |
| `🤖` | Command that regenerates the file | `🤖 db/__generated__/types.ts  // regen via <project codegen command>` |
| `⚠️` | Plan filename that removes it | `⚠️ legacy-shim.tsx  // remove in delete-legacy-shim.md` |
| `🚫` | Why descoped + likely follow-up | `🚫 mobile-variant.tsx  // deferred; needs design pass; track in followups.md` |

### Lineage (bidirectional rule)

The same change always shows from two angles, so both readers see it:

| Op | Source side | Target side |
|---|---|---|
| **Move/rename** | (one node) | `🔀 new.tsx ← old.tsx` |
| **Split** | `🪓 x.tsx → y.tsx, z.tsx, w.tsx` | `🆕 y.tsx  // from 🪓 x.tsx` (and same for z, w) |
| **Merge** | `❌ a.tsx  // merged into z.tsx` (and same for b) | `🆕 z.tsx  // from a.tsx + b.tsx` |
| **Extract** (one new file lifted from existing) | `✏️ source.tsx  // <name> moved to lib/<name>.ts` | `🆕 lib/<name>.ts  // extracted from source.tsx` |

`←` means *was/came from*. `→` means *becomes/produces*. These two arrows plus the operation symbol express any restructuring without inventing more symbols.

## Before-tree convention

Show only the directories the plan touches. Do not include unrelated subtrees; they are noise that competes with what the executor needs to find.

For unchanged context the before-tree leaves nodes bare. For nodes that *will* change, the before-tree carries the operation symbol *with the verb's source-side perspective*; so `🪓` and `❌` show up in the before-tree where their data lives, while `🆕` and `🔀` show up in the after-tree because that's where the resulting node lives.

````markdown
**Legend:** 🪓 split · ❌ deleted · ✏️ rewritten

```
features/resources/
├── 🪓 use-resource-actions.ts → actions/{create,rename,delete,archive,restore}.ts
├── ❌ helpers.ts                              // logic absorbed into dispatcher
├── ✏️ dispatcher.ts                           // becomes composition-only (~60 lines)
└── use-resource-actions.test.ts                # will rename; see after-tree
```
````

The trailing `# will rename; see after-tree` style note is a context cue when the source-side symbol would be confusing or when the rename is the only change to that node.

## After-tree convention

Same shape, end state. Every transformed node carries its operation symbol; the *target side* carries lineage notes for splits, moves, merges, and extracts.

````markdown
**Legend:** 🆕 new · ✏️ rewritten · 🔀 moved/renamed

```
features/resources/
├── ✏️ dispatcher.ts                          // composes the 5 per-action hooks
├── 🔀 dispatcher.test.ts ← use-resource-actions.test.ts
└── 🆕 actions/
    ├── 🆕 create.ts                           // from 🪓 use-resource-actions.ts
    ├── 🆕 rename.ts                           // from 🪓 use-resource-actions.ts
    ├── 🆕 delete.ts                           // from 🪓 use-resource-actions.ts
    ├── 🆕 archive.ts                          // from 🪓 use-resource-actions.ts
    └── 🆕 restore.ts                          // from 🪓 use-resource-actions.ts
```
````

Reading the after-tree alone, the executor can see that all five `actions/*.ts` files come from one source split. Reading the before-tree alone, the executor can see what happens to `use-resource-actions.ts`. Either tree is self-contained; both together are unambiguous.

## When the change spans many directories (split by topic)

When the plan touches a wide tree, split into multiple before/after pairs by topic, each scoped to one concern. A single 200-line tree is harder to use than five 40-line trees grouped by what they accomplish.

````markdown
### File structure: before; schema

**Legend:** ✏️ rewritten

```
db/schema/
├── ✏️ resource-a.sql.ts                      // drop legacy_url column
└── ✏️ resource-b.sql.ts                      // drop legacy_url column
```

### File structure: after; schema

**Legend:** ✏️ rewritten · 🆕 new

```
db/schema/
├── ✏️ resource-a.sql.ts
├── ✏️ resource-b.sql.ts
└── 🆕 resource-config.sql.ts                  // JSON config table replacing legacy_url
```

### File structure: before; components

…
```
````

Each pair stays small, the legend stays narrow, and reviewers can read one topic at a time.

### Combinable annotations

Two symbols may carry combinations. Both express genuinely-multi-aspect operations the rule layer needs to name explicitly so the executor doesn't lose information.

#### `🤖` codegen + state

`🤖✏️` regen-after-source-change; `🤖🆕` newly-generated.

```
db/__generated__/
├── 🤖✏️ types.ts                          // regen via <project codegen command> (source: db/schema/*.sql.ts)
└── 🤖🆕 resolvers.ts                      // generated for the first time; same command
```

`🤖✏️` says: "the file existed; its contents change because the source changed; run the generator, do not edit." `🤖🆕` says: "the file did not exist; the generator will create it." Without the `🤖`, the executor might try to author these by hand and have their work blown away on the next codegen run.

#### `🔀✏️` rename-and-rewrite

When a file moves to a new path *and* its contents change non-trivially in the same plan. Use the `← old-path` arrow on the new path, plus a note explaining what changed:

```
features/resources/
├── 🔀✏️ dispatcher.ts ← use-resource-actions.ts   // renamed AND reduced to composition only (~60 lines)
```

A plain `🔀` would imply contents-largely-unchanged, which is a lie when the rewrite is part of the same commit. A plain `✏️` would lose the rename. The combination keeps both facts on one line.

#### What is NOT combinable

No other combinations are valid. Reaching for two non-`🤖`/non-`🔀` symbols (e.g., `🆕✏️`, `🆕🪓`, `❌🔀`) means the operation is overloaded; split into one symbol plus a `// note`, or describe the operation across separate trees if the artifact's lineage spans before/after states. The legend stays small on purpose.

### Why no `merge` symbol; the asymmetry with `🪓` is deliberate

`🪓` (split) gets its own symbol because one source diverging into N targets needs a label on the *source* to signal "this file is going away in a structured way." There is no analogous need on the merge side: the merge target is genuinely `🆕` (a new file holding the merged content) and each source is genuinely `❌` (its file is gone). The lineage notation does the rest:

```
config/
├── ❌ config-a.ts                          // merged into unified-config.ts
├── ❌ config-b.ts                          // merged into unified-config.ts
└── 🆕 unified-config.ts                    // from config-a.ts + config-b.ts
```

Adding a `🤝` or `🧬` for merge would not give the executor any information the `❌` + `🆕` + bidirectional notes do not already carry. Splits are asymmetric (one source, multiple-rare targets named in a comma-list); merges are symmetric (the target's `// from a + b` line names the sources cleanly with a `+`-list).

## Worked example with the full vocabulary

A refactor that splits a hook, regenerates a codegen artifact, deprecates a legacy shim, and moves a test file:

````markdown
### File structure: before

**Legend:** 🪓 split · ✏️ rewritten · ⚠️ deprecated · 🤖 regenerated

```
features/resources/
├── 🪓 use-resource-actions.ts → actions/{create,rename,delete}.ts
├── ✏️ dispatcher.ts                          // becomes composition-only
├── ⚠️ legacy-resource-shim.tsx               // remove in delete-legacy-shim.md
└── 🤖 __generated__/resources.ts             // regen via <project codegen command>
```

### File structure: after

**Legend:** 🆕 new · ✏️ rewritten · 🔀 moved/renamed · ⚠️ deprecated · 🤖 regenerated

```
features/resources/
├── ✏️ dispatcher.ts                          // composes the 3 per-action hooks
├── 🔀 dispatcher.test.ts ← use-resource-actions.test.ts
├── ⚠️ legacy-resource-shim.tsx               // remove in delete-legacy-shim.md
├── 🤖 __generated__/resources.ts             // regen via <project codegen command>
└── 🆕 actions/
    ├── 🆕 create.ts                           // from 🪓 use-resource-actions.ts
    ├── 🆕 rename.ts                           // from 🪓 use-resource-actions.ts
    └── 🆕 delete.ts                           // from 🪓 use-resource-actions.ts
```
````

## Anti-patterns

- **Tree without a legend.** Once excerpted, the symbols are illegible to a cold reader.
- **Trees that show the entire repo.** Noise; the executor cannot tell what is in scope.
- **Trees that disagree with the Commits section.** If the after-tree shows `🆕 foo.ts` but no Commit creates `foo.ts`, one of them is wrong. Reconcile before shipping the plan.
- **Lineage on only one side.** A `🪓` source without `// from 🪓 …` notes on the targets; or a `🔀` without the `← old-path`; leaves the executor reading both trees back-to-back to reconstruct what's obvious.
- **Two operation symbols on one node** outside the documented combinations (`🤖✏️`, `🤖🆕`). If you reach for two, you probably want one symbol plus a note.
- **Rationale tails on every node.** Notes earn tokens individually; do not annotate self-explanatory ops.
