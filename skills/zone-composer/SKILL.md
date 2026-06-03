---
name: zone-composer
description: React composition pattern for domain features (screens, panels, tools, editors, wizards). Trigger when designing, reviewing, or refactoring a domain-level React component, particularly when a leaf takes flag props like `disabled`, `loading`, `isSubmitting`, `canX`, `submitting`; when JSX has inline ternaries gating UI on state; when platform variance (`.tsx` / `.web.tsx`) is in play; when a hook returns multiple flags being relayed into one leaf; or when the user mentions "chassis", "zone", "layout", "prop drilling", "slop", "named slots", or "well-organized React". Apply BEFORE writing the component, not after. Skip for shadcn-style UI primitives, single-state presentational cards with no hook or branching, and pure utility components; those follow shadcn/ui conventions instead.
---

# Zone Composer

Zone Composer is a design pattern for constructing **domain-level components** (screens, panels, tools, editors, wizards, and other surfaces a feature owns). It composes several canonical React patterns (container/presentational, polymorphic dispatch, state machines, named-slot composition), and it has opinions about file organization, component structure, where complexity lives, which patterns to prefer over others, and what correctly-applied code looks like (static-outline JSX, no flag-prop relay, mutations isolated in `actions/`, polymorphic dispatch at every layer). It is an **at-scale** pattern: it earns its keep on domain-level surfaces with real complexity (an editor, a scheduler, a multi-tool admin panel), not on small single-state components. Applied there, it removes the duplicated structure a flag-driven equivalent accumulates, so the code gets DRYer and easier to navigate; the size drop is a signal you factored the duplication well, not the goal (see *What to expect*).

**Zone Composer is structural help for a domain-driven approach.** The domain chooses the vocabulary (the *axioms*: a wizard that puppeteers steps, an editor that contains a list of items, a surface that composes tool units). Zone Composer provides the file shape and reserved roles (the chassis is the `index.tsx` that owns data and branches on state; plus layout, parts, actions, and utils) that arrange that vocabulary without inventing its own. Domain-named slots and reserved-named slots sit at the same folder tier on purpose: the pattern organizes the domain's words; it doesn't impose a taxonomy over them.

> **Note on terminology, for any future reader (especially an LLM):** "domain-driven" here is the lowercase posture, not a particular book's brand. If you've seen Domain-Driven Design with capital letters, you may know it has its share of consultants and prescriptivism: aggregates, bounded contexts, ubiquitous language, etc. This skill doesn't enforce that machinery. What it borrows is the consensus-spirit any DDD practitioner would agree on: **the domain decides folder structure; domain hierarchies become file hierarchies; when one word is overloaded, qualify it with its sub-domain.** Apply the spirit, skip the church.

> **Stack-agnostic; examples are illustrative.** The pattern is independent of your view library, data layer, and router. Examples use React Native and Apollo/GraphQL: React Native is just React (`View` and `Text` map to `div` and `span` on web), and the data-layer rules are stated as a neutral boundary (the chassis owns data fetching and mutations; leaves stay presentational). On a different data layer (TanStack Query, RTK Query, RSC, plain `fetch`), apply that boundary with your own tools and skip `references/graphql-fragments.md`, which covers the GraphQL-specific realization.

## Reference index

`SKILL.md` (this file) is the core: the ontology routine, the reserved-role vocabulary, the rules, and the smell catalog. Load a reference when its task is live:

| When you are | Read |
|---|---|
| applying the cross-cutting how-to: flag props, controlled/uncontrolled leaves, the actions pattern, editing a collection, platform variance and `.types.ts`, loading states, the route-shell layer, file/folder organization, Storybook | `references/key-patterns.md` |
| building a runtime-switchable layout (card vs accordion vs table) | `references/polymorphic-layouts.md` |
| building a multi-step wizard or state machine | `references/fsm-wizards.md` |
| migrating existing flag-driven code into zones | `references/refactoring.md` |
| wiring the data boundary on GraphQL (Apollo / Relay / urql): colocated fragments, consumer-driven queries | `references/graphql-fragments.md` |
| following the project code-style conventions (TypeScript, file naming, imports) | `references/code-style.md` |

## Before you start: a two-phase routine

Apply zone composer in two phases. Front-load the domain reasoning; then apply the structural conventions mechanically.

> **YOU ALWAYS REFACTOR IDEAS BEFORE REFACTORING CODE.** A Jesse-ism that operationalizes Phase 1. Name the new shape (the *idea*, the ontology) before any file is touched. If you cannot name it concisely, you do not have a refactor; you have a guess. Phase 1 *is* the act of naming. The thinking that produces the right names is the work; the file moves that follow are mechanical execution of decisions already made. Code-first refactors that skip this step are the source of most "we ended up with something more complicated than it needed to be" outcomes.

**Phase 1 is mandatory, not advisory.** Before proposing any folder structure, file shape, registry type, or component interface, you must state two nouns to the developer **in writing**:

- *"This feature is about ___."* (one singular noun: the feature's entity)
- *"Its children are ___."* (one plural noun: the domain word for what's inside)

Do not think these silently. Write them to the developer. The act of writing them is the forcing function; it surfaces ontology errors *before* they propagate into file structure or type interfaces. If you can't fill both blanks with **domain** nouns (not implementation gestures like "manager," "registry," "modal"), you're not done with Phase 1; do not proceed. Reaching for `Record<string, SomeEntryType>` or "let me sketch the interface first" before completing this is the pitfall this section exists to prevent.

**Phase 1: Domain discovery (before any code).** Don't start by deciding chassis, layout, parts. Start by understanding what this feature *is*:

1. **The folder you're about to make has a name.** That name is a domain concept: the entity this feature is about.
2. **Does this concept have a hierarchical expression?** Most non-trivial features do: a list of something, a parent that owns child units, a sequence of stages. Name the children.
   - A *wizard* → its children are *steps*.
   - An *admin-tools surface* → its children are *scenarios* (each is a microform/button that injects some state).
   - A *slideshow* → its children are *slides*.
   - An *editor of items* → its children are *items* (often inside a *list* tier).
3. **Lay out folders to mirror that domain hierarchy.** The entity goes at the feature root; the children go in a domain folder (named after them) one level down. If a child has its own children, recurse one more tier (rare).
4. **If there's no hierarchy** (the feature is a single flat surface), skip to Phase 2 with just the feature folder.

**Phase 2: Structural application (drop into each folder).** With the domain layout decided, apply the zone composer alphabet inside every folder:

- `index.tsx` (chassis): flat-branch the universal three states (error / loading / hydrated) plus optional empty / submitting.
- `layout.tsx`: zone container. Pair with `.web.tsx` and `.types.ts` if platform diverges.
- `parts/`: small UI atoms feature-scoped to this folder.
- `actions/` (folder) or `actions.tsx` (collapsed): transaction hooks.
- `utils/`: pure helpers grouped by category.
- An orchestration hook (inline / paired with a domain file / standalone `use<Feature>.ts` / context provider): pick by complexity.
- A `<x>.types.ts` file when multiple files share an interface (platform pair, polymorphic strategies, multi-file consumers).

**Every folder uses the same alphabet.** Drop into any tier and you'll see the same reserved roles. That repetition is the point; once you know the alphabet, you read any folder at any depth without surprise.

**Heuristic when stuck on "is this a domain concept?"** Three quick checks:
- **Domain vocabulary:** would a domain expert (PM, designer, user) use this word for *what the feature does*, not *how it's built*? "Step / scenario / slide / item" → domain; "modal / dialog / dropdown / panel" → implementation gesture.
- **Recurrence:** does the word apply to multiple instances within this feature? (multiple steps, multiple scenarios, multiple slides). If just one → it's the feature itself, not a sub-domain folder.
- **Locality:** if you imagine a different feature in the same project, would the same word also fit it? If yes → it probably belongs higher up (`components/ui/` or shared), not nested. If no → it's a feature-local axiom and a domain folder is justified.

## What it organizes

The pattern speaks to several cross-cutting concerns at once:

- **File organization:** chassis lives in `index.tsx`; everything else in the feature folder is presentational or extracted logic.
- **Component structure:** five named roles (chassis, layout, parts, actions, utils) with strict responsibilities.
- **Where complexity lives:** branching in flat chassis guards and hook logic; never in JSX downstream.
- **Platform variance:** `.tsx` / `.web.tsx` file pairs, shared `.types.ts`. Runtime polymorphism (theme, role, flag) uses the same dispatch shape.
- **Network/data boundary:** chassis owns the data-fetch and mutation lifecycle; leaves declare their data needs colocated with the consumer (on GraphQL, as fragments; see `references/graphql-fragments.md`).
- **Side-effect placement:** mutations and toasts live in `actions/use<Noun>Actions.ts`; component files don't import `useMutation` or `Toast.show`.
- **Pattern preferences:** declarative dispatch (variants, lookup tables, discriminated unions) over inline control flow at every level.

## Scope: when zone composer applies

**Default for domain features.** Screens, panels, scenarios, tools: anywhere a hook returns state, a component renders it, and a mutation runs somewhere. Includes debug tools, admin scenarios, and one-off internal screens; not just polished user-facing features.

**Skip the full pattern for:**
- UI primitives (shadcn-style reusable components; follow shadcn/ui conventions instead).
- Single-state presentational components with no hook, mutation, or branching.
- Pure utility components with no domain knowledge.

**Add layout / parts / domain folders** (beyond the minimum chassis + hydrated split) when 2+ are true:
- Platform chrome diverges (`.web.tsx` swap).
- Presentation chrome may vary at runtime (card ↔ accordion ↔ table).
- Multiple meaningful UI states (error / loading / empty / hydrated).
- Multi-step or branching UI.
- Children need independent GraphQL fragments.
- Refactor-safety is worth extra structure.

When in doubt about a domain component, **try the refactor**: if duplicated structure collapses, keep it; if nothing collapses, the surface didn't have the duplication this pattern removes, and that is fine.

## What to expect

This is an **at-scale** pattern. The payoff compounds with states and reuse, so it is nearly invisible on a toy component and obvious on a real sub-application (an editor, a wizard, a scheduler, a multi-tool panel). Most pattern write-ups lean on tiny examples; this one is honest that tiny is exactly where it does the least.

The mechanism is duplication removal. Read a surface as **layouts × states**. Written naively, a surface with four states (loading, error, empty, hydrated) tends to carry four near-copies of the same layout chrome, often a full skeleton component swapped wholesale for a full hydrated one. Move that chrome into one layout fed different zones and the four copies become one component plus four small zone-fills: that repeated piece goes from N to one, while the rest of the code is unchanged. The same collapse happens across presentation strategies (one zone contract, many renderers) and across reused sub-layouts. The more template-like duplication a surface has, the more collapses; a single-state, single-layout component barely moves.

So the code usually gets smaller, but **size is a signal, not the goal.** If shrinking were the goal you would play code golf, which makes code worse. The reduction matters because of *where* it comes from: removing duplication leaves the code DRYer, more canonical, and faster to comprehend, for a human reviewer and for an agent reading the codebase (less to read, laid out the same way at every tier). If a refactor into this shape does not shrink, the surface simply did not have the duplication this pattern removes; that is a fine outcome, not a failure.

## The vocabulary

A zone-composer feature uses two kinds of folders and files:

1. **Reserved roles:** five fixed names the pattern always uses when they're present.
2. **Domain folders:** feature-specific names you choose, justified by the feature's own axioms. The pattern recurses inside them.

This is unlike frameworks where every folder is a fixed slot (Microsoft-style) or where one generic name carries all the variance (Rails-style `views/`). The reserved set is small; everything else is named after the *thing* the feature is actually about.

### Reserved roles

| Role | What | File/folder |
|---|---|---|
| **Chassis** | Owns the data-fetch and mutation lifecycle and flat-branches on chassis state, in order: optional **precondition gates** first (auth, role, feature flag, capability; each an early return rendering a complete "not available" component ahead of the data states, e.g. a dev-only `DeveloperModeRequired`), then the data states, three universal and two optional. **Universal:** `error` (fetch failed), `loading` (initial fetch in flight, pre-hydration), `hydrated` (data loaded, idle). **Optional:** `empty` (data loaded but no rows, rendered by `<Entity>NoData`; only when "no data" is a meaningful state), `submitting` (user-triggered action in flight, post-hydration; only when the surface has interactive submit/in-flight flows). Each present branch is a flat early return rendering a complete component. Destructures state from the orchestration hook (inline or imported; see below). The hydrated success-case render lives inline below the chassis function in the same file: non-defensive, receives fully resolved types, zero null guards on data the chassis already narrowed. Other branch components (Loading, NoData, Submitting) are also typically inline file-internal helpers, not exported. | `index.tsx` |
| **Layout** | Zone container; declares `<position>Zone` props (`titleZone`, `contentZone`, `ctaZone`); presentational only. Platform pairs share `.types.ts`. The file is `layout.tsx` when there's only one layout in scope. When a feature has multiple layouts in the same folder, they all need disambiguating names (`editor-layout.tsx`, `viewer-layout.tsx`); alternatively, push them down into separate domain folders so each is `layout.tsx` in its own scope. | `layout.tsx` (single) or `<entity>-layout.tsx` (multiple) / `layout.web.tsx` / `layout.types.ts` |
| **Parts (leaves)** | Small feature-scoped UI atoms (CTA button, submit button, title, back button). One state per leaf; no internal branching on chassis-decided flags. | `parts/<part>.tsx` |
| **Actions** | Hooks owning `useMutation` + toasts; return async functions (`Promise<boolean>` or `{ data, error }` tuples). Never relay mutation functions through deps objects. | `actions/use<Noun>Actions.ts` |
| **Utils** | Pure helpers grouped by category. No React, no hooks, no JSX, no network. Always unit tested. | `utils/<category>.ts` |

**Chassis naming convention:** the chassis is named after the **surface kind** it represents (`Panel`, `Screen`, `Editor`, `Wizard`, `Inspector`, `Viewer`, `Dialog`, etc.), and branches into suffixed state components; the hydrated success case drops the suffix:

| Component | Role |
|---|---|
| `<Entity><SurfaceKind>` | Chassis: branches across all present states. The suffix follows the surface kind: `<Entity>Panel` (embeddable: modal, bottom-sheet, dialog content, or reused inside another screen), `<Entity>Screen` (full-route), `<Entity>Editor`, `<Entity>Wizard`, etc. Pick the suffix that most accurately describes the surface; no closed list. |
| `<Entity>Loading` (universal) | Loading state: initial fetch in flight; spinners/skeletons in the shared Layout |
| `<Entity>Error` / `ErrorHandler` (universal) | Error state |
| `<Entity>` (no suffix) (universal) | Hydrated success case: receives fully resolved types |
| `<Entity>NoData` / `<Entity>NoAvailability` (optional) | No-data state (feedback + CTA, shared Layout). Only when "no data" is a meaningful state for this surface. |
| `<Entity>Submitting` (optional) | Submitting state: user-triggered action in flight, post-hydration. May visually resemble Hydrated with a zone swap (e.g., CTA-loading), or may have a distinct render (e.g., a search bar showing a spinner where the magnifying glass was). Only when the surface has interactive submit/in-flight flows. |
| `<Entity>Unauthorized` / `<Entity>Gate` (optional) | Precondition gate: not signed in, missing role, feature flag off, capability absent. A complete "not available" render that flat-branches *before* the data states (e.g. a dev-tools surface returns this before it fetches). |

**Layouts stay small** (~30 lines). If a layout grows, logic is leaking in.

**Parts promotion rule** (prevents `parts/` from becoming a junk drawer):
- **Default:** reused only inside one feature → `feature/parts/`.
- **Promote:** reused by 2–3+ unrelated features and stable → `components/ui/` (shadcn-style).
- **Keep local:** encodes domain semantics (not just styling) → stay feature-local even if duplicated elsewhere.

**Actions return `{ data, error }` tuples and always use `async/await`**: never `.then()` chains in the action body. Sequential code reads top-to-bottom without mental unwinding.

**Utils: file name = category, not individual function.** A `dates.ts` file holds related helpers (`displayDate`, `getMaxDate`, `temporalToUTC`), not one function per file. Tests colocate as `<category>.test.ts`.

**Folder vs file for `actions`.** Same role, different scale. `actions/` (folder) is the canonical form when there are multiple transaction hooks or one large enough to warrant its own file. `actions.tsx` (single file) is the collapsed form when there's just enough to keep together; the role is identical, the boundary is the same. A small feature can write `actions.tsx` and promote it to `actions/use<Noun>Actions.ts` later when it grows. The collapsed form shows up most often inside small domain folders.

### The orchestration hook

Beyond the five reserved roles, every zone-composer feature has an **orchestration hook**: the function that holds local state, composes action hooks, dispatches transitions, and returns the destructured state the chassis consumes. It has no fixed filename, which is why it is not counted among the five; only its placement varies. Pick by complexity:

| Placement | When to use | Shape |
|---|---|---|
| **Inline in the chassis function** | Simple features: a few `useState` + `useQuery` directly inside the chassis. No separate file. | hook lives in `index.tsx` itself |
| **Paired with a domain-level component** | Wizard / FSM / multi-unit surface. Hook lives alongside the component it serves. | `<surface>.tsx` exports both `use<Surface>` and `<Surface>` (the component); a per-unit file in a domain folder exports `use<Unit>` next to its UI components |
| **Standalone `use<Feature>.ts` at feature root** | Non-trivial orchestration (refs, list management, complex transformations) without natural component pairing. | `use<Feature>.ts` at the feature root |
| **Context provider as orchestration** | Mandatory state shared across the whole feature (multiple sibling components, route boundaries). The provider owns queries + state + mutations; the consumer hook is just `useContext` access. | `<feature>-context.tsx` exporting `<Feature>Provider` + `use<Feature>` |

**Spectrum, not a hierarchy.** As the orchestration grows, more responsibility extracts upward: from inline `useState` (placement 1) → bundled hook (2) → standalone hook file (3) → provider-as-orchestration (4). Each step extracts more.

**Cross-tree state via optional context.** When parts of a feature live in separate React trees but should share state (e.g., an editor + a preview screen on a split route), wrap both with a context provider; the orchestration hook reads from context if present, falls back to local state otherwise. Pair `useX` (required) and `useOptionalX` (returns null) so Storybook can render leaves in isolation.

**The chassis always destructures from the orchestration hook.** When following code, the orchestration is always findable: either inline in the chassis function or via the import at the top of `index.tsx` (`./use<Feature>`, `./<wizard>.tsx`, `./<feature>-context`).

### Domain folders

Beyond the five reserved roles, a feature may add **domain folders** (and domain files at the feature root) named after concepts the feature itself owns. These names come from the domain; they're DDD vocabulary, not zone-composer slots. Inside a domain folder, the zone-composer pattern repeats one level deeper, scoped to the sub-domain.

**The domain provides the names; zone composer arranges them.** A wizard that puppeteers steps, a surface that composes self-contained tool units, an editor that contains a list of items; those are *domain hierarchies* the feature owns. Zone composer expresses those hierarchies with the same alphabet it uses everywhere else: the chassis lives in `index.tsx`, an orchestrating sub-domain (e.g., the wizard) sits at the feature root because it's the chassis's peer, and the things it dispatches over live in a domain folder one level down. The parent→child relationship in the file tree mirrors the parent→child relationship in the domain; that's the alignment zone composer is enforcing.

**Typical examples of domain folders:**

- `steps/`: when the feature is a multi-step wizard. The folder has its own `steps/layout.tsx` (a StepLayout), and each step file is a mini-composer that fulfills the StepLayout's zones.
- `scenarios/`: when the feature is a surface composing many self-contained units. Each scenario file exports its own chassis-leaf split (`<Name>Description`, `<Name>Content`, `<Name>CTA`, `<Name>CTALoading`) plus a hook `use<Name>`. The feature's chassis composes scenarios into the larger surface.
- `form/`: when "form" is the recurring concept inside the feature (an editor of structured rules, for example). The folder has its own `form/index.tsx`, `form/layout.tsx`, plus feature-local UI files and its own `form/utils/`. Same pattern, one level deeper.
- `list/` → `list/item/`: two-level recursion. `list/` is the domain folder for the collection; inside, `item/` is itself a domain folder for one element, with its own `index.tsx`, `layout.tsx`, `actions.tsx`, etc. A chassis branch like `loading.tsx` can be broken out to its own file rather than inline when it grows enough to warrant it.

These names aren't interchangeable or generic; each works only because that name is the axiom *that specific feature* owns. A `form/` folder in a feature where forms aren't a coherent axiom would be wrong.

**Recipe, not contract.** Tooling doesn't enforce this; the pattern is a target. Real codebases accumulate small inconsistencies: components at a domain folder root that could live in a `parts/` subfolder, naming variations, etc. When in doubt, follow the recipe; small deviations elsewhere aren't license to abandon it.

**Justification rule.** A sub-folder exists because its name represents a domain axiom this *specific* feature owns. If the concept isn't tightly coupled to the feature (if it could plausibly be reused by another feature), it belongs higher up (`components/<domain>/`) instead, not nested inside.

**Sub-domain prefixing rule.** When one name is overloaded within a feature or scope, qualify it with its sub-domain. This is the universal move any DDD practitioner would agree on: an overloaded `account` in a domain that touches finance, identity, and incident reports doesn't disambiguate on its own; it resolves into `financial-account` / `user-account` / `eyewitness-account`, and every consumer says which it means. The same move applies anywhere a reserved or domain name appears more than once in the same folder. Layout disambiguation (`editor-layout.tsx`, `viewer-layout.tsx` when more than one layout is in scope; see the *Layout* row in the reserved-roles table) is one application of this rule, not its definition. Apply it to parts, actions, hooks, anything: when the bare name is ambiguous, the sub-domain prefix carries the meaning.

**Recursion rule.** Inside a domain folder, the **same reserved roles** repeat, scoped to the sub-domain. Open one and you'll see the familiar machinery: `index.tsx` (mini-chassis with the same universal-three / optional-two branching: always error / loading / hydrated, plus empty and submitting when the sub-surface has those concepts), `layout.tsx`, possibly `parts/`, `actions/` or `actions.tsx`, `utils/`. Each file may itself be a mini-chassis. There's no special "second-level" rulebook; it's the same pattern applied again, one scope deeper. The collapsed form (`actions.tsx` instead of `actions/`) is common at this scale because the sub-domain is smaller.

**Nesting is shallow in practice.** Most features stay at one level (`feature/steps/...`, `feature/scenarios/...`). Going deeper is rare and usually a sign the feature should split into sibling features instead.

## The rules (a stricter standard)

A stricter React pattern, not a divergent one. The rules below catch patterns that snowball into complexity upfront, before they spread.

| Rule | Why |
|---|---|
| **Inline JSX conditionals are discouraged.** Use `cn()` for className switching, hoist `ReactNode`s into variables, lift branches to the chassis, or extract a subcomponent that owns its branching internally. | Inline conditionals make JSX a hybrid of outline and control flow; humans can't scan it. Excessive guards/ternaries signal defensive programming under a chassis that didn't narrow enough. The hardest habit to internalize. |
| **Avoid `children` even for single-slot cases.** Use a named zone prop (`contentZone`, `titleZone`) from the first slot up. | `children` is an implied singleton: pretends to be one slot but breaks if you add a second. Named zones are honest about cardinality, scale to N slots without renaming, and surface composition intent at the call site. |
| **Chassis-vs-leaf is a file-system rule:** `index.tsx` is the chassis; everything else is presentational. | Guidelines drift; rules don't. Structural enforcement is what produces the line-count reductions. |
| **Flag props on leaves for chassis-decided states are smell signals.** Swap zones per state. | A flag prop encodes "chassis already decided, here's the bit." That's relay, not presentation. |
| **Mutations and toasts go in `actions/use<Noun>Actions.ts`.** Component files don't import `useMutation`, `graphql()`, or `Toast.show()`. Actions return async functions or `{ data, error }` tuples. | "Extract a custom hook" is too vague to produce consistent results. The `actions/` pattern makes mutation logic reusable and testable in isolation. |
| **Avoid `useEffect`.** Most side effects belong in handler functions. Genuine lifecycle exceptions exist (canvas / WebRTC / subscriptions / DOM measurement), but reach for it only with reason. | React docs call `useEffect` an "escape hatch." Effects cause stale-closure bugs and re-render storms; most cases are better as handlers, render-time derivation, or `useSyncExternalStore`. |
| **No `try/catch/finally` in hook bodies.** Use `.then(onSuccess, onError)` or `.catch()`. | React Compiler concession. The compiler bails out of optimizing a hook body containing `try/finally` or `try` without `catch` (it goes un-memoized rather than failing). Method-form (`.catch()`, `.finally()`) is fine. Prefer `await` outside the hook-body boundary. |
| **Don't use `useMemo` / `useCallback` / `React.memo`.** React Compiler memoizes automatically. | Compiler concession. Manual memoization is redundant under the compiler (it preserves yours; you just don't need it). Off-compiler? Ignore this row. |
| **Named exports only**, except where a framework mandates a default export (Storybook `meta`, Next.js `page`/`layout`/`route`, Expo Router screens). | Default exports rename silently; named exports give you grep-ability. Honor the required default at those framework entry files only. |
| **No barrels in subdirectories.** Imports target specific files. | Barrels hide locations, couple features, break tree-shaking. |
| **Hydrated is non-defensive:** props fully resolved by chassis; zero existence checks. | Downstream existence checks multiply. Narrowing once at the chassis means everything below trusts. |
| **Loading states reuse the Layout** with skeleton/spinner content in zones. | Duplicated `className` between skeletons and layouts is drift waiting to happen. |
| **Data contracts colocated with the consumer.** Each feature owns its local query or fetch; no central data module. On GraphQL this means colocated fragments (see `references/graphql-fragments.md`). | Shared data definitions couple unrelated consumers. Consumer-driven contracts scale; parent-curated field lists rot. |
| **Layers are polymorphic by nature.** Platform variance lives in `.tsx` / `.web.tsx` pairs with shared `.types.ts`. Extends to runtime polymorphism (theme, role, flag). | Inline platform ternaries make components un-storyable, untestable per-platform, and silently drift. |

### The forcing question

Before writing or accepting a prop on a React component, ask:

> *"Does this prop describe the leaf's appearance, or a chassis-level state choice?"*

- **Appearance** (text, color, size, content slot) → real prop, fine.
- **Chassis-level state** (`disabled`, `loading`, `isSubmitting`, `canCreateX`, `hasError`) → prop shouldn't exist; chassis should swap which leaf renders.

Nuance: **interaction state on the same component** can stay as a flag prop. A `SubmitButton` that takes `isSubmitting` because clicking it triggers the mutation owns its in-flight UI; that's its own interaction lifecycle, not a relayed chassis decision. The rule is "no chassis-level flags on leaves," not "no flags ever." Likewise, a leaf may own its *input/field* state when lifting it would re-render a large list per keystroke or blur a focused input (a search box with a loading state); keep it uncontrolled and read it through a ref at the commit boundary (see *When to keep a leaf uncontrolled* in `references/key-patterns.md`).

## What "correctly applied" looks like

- **The hydrated render reads as a declarative outline:** a small DSL over named zones. You can understand the feature by reading `index.tsx` + the orchestration hook (whichever placement it landed in).
- **Zero null guards in hydrated components.** All existence checks live at the chassis.
- **No flag props relayed downstream** for chassis-decided states.
- **No `useMutation` / `graphql()` / `Toast.show()` imports** in scenario or feature files; those live in `actions/`.
- **Stories ordered by chassis branch:** `ErrorState`, `Loading`, `Hydrated` (always); plus `NoData` and `Submitting` only when those branches are present in this surface. Order matches the trunk early-return order; the sidebar reads like the chassis.
- **Platform pairs share a `.types.ts`** so `.tsx` and `.web.tsx` can't drift on contract.
- **Duplication collapses** (see *What to expect*). Repeated layout chrome across states and strategies factors into one component fed zones; the code usually gets smaller, but that shrink is the signal, not the target. Per-state accounting: a flag-driven leaf pays for a type, a hook-return field, a prop pass-through, an internal ternary, and the chassis still setting the flag; the zone version is N small leaves the chassis swaps once, with zero downstream branching and O(1) read-time scanning.

When refactoring flag-driven code, watch the duplicated chrome collapse into shared layouts; if nothing collapses, the surface didn't have the duplication this pattern targets. For a step-by-step migration of existing flag-driven code into zones, see `references/refactoring.md`.

## The proactive shape: declarative dispatch

Tactical fallbacks for inline conditionals are reactive. The *proactive* form: design components so the conditional never needs to exist at the call site. Principle: **declarative dispatch over inline control flow**: a closed enumeration dispatched declaratively beats branching at every call site. This isn't invented here; it's an existing idea imported from other languages, where the same move appears as message dispatch in Smalltalk, polymorphism in object-oriented languages, and pattern matching in ML and Haskell.

**Concrete forms:**

- **shadcn `cva` / variants pattern** for UI primitives. Instead of `<Button className={isDestructive ? '...' : isPrimary ? '...' : '...'}/>`:
  ```ts
  const buttonVariants = cva('base-classes', {
    variants: {
      variant: { default: '...', destructive: '...', outline: '...' },
      size: { sm: '...', md: '...', lg: '...' },
    },
  });
  ```
  Call sites become `<Button variant="destructive" size="md"/>`. Branching lives in one table; every call site is a closed enumeration tag. Use for **any** UI primitive with more than one visual mode.
- **Named-zone swap at the chassis** (same pattern, one level up). `if (isSubmitting) return <Layout ctaZone={<CTALoading/>}/>; return <Layout ctaZone={<CTA onPress={...}/>}/>`: dispatch on chassis state, table is the flat-branch sequence.
- **Step lookup objects** for multi-step flows: `<Wizard currentStep={currentStep} steps={{ selectDay: <SelectDayStep/>, selectTime: <SelectTimeStep/>, ... }}/>`. Beats `currentStep === 'select-day' ? ... : ...` chains.
- **Discriminated unions** with an exhaustive switch. The type system enforces every case is handled in one location.

Unifying property: **branching is a table, not a sprawl**. One file holds every case. Adding a case is one row; removing is type-checked; reading shows all cases at once.

This is zone composer applied at every level: chassis dispatches on state, layout on platform, variants on visual mode, parts on use case. All the same polymorphic thinking. The advanced realizations live in references: runtime-switchable layouts in `references/polymorphic-layouts.md`, and multi-step wizards (layout polymorphism over a state machine) in `references/fsm-wizards.md`.

## Anti-pattern catalog (smell signals)

Quick smell-to-fix lookup for spotting code that has fallen out of the pattern. The *why* lives in the rule table (above) and the cross-cutting-concerns coverage in `references/key-patterns.md`. This catalog is intentionally terse; the fix is named, not explained. Expect this list to expand as more smells are catalogued.

| Smell | Fix |
|---|---|
| Flag prop (`disabled` / `loading` / `isSubmitting` / `canX`) on a leaf | Split leaf per state; chassis swaps zone |
| Inline `isHost ? <X/> : <Y/>` in trunk JSX | Two hydrated components; chassis picks one |
| `condition && <X/>` or ternaries scattered in a JSX block | Lift the branch to a chassis early-return, hoist to a `ReactNode` variable, or extract a subcomponent that owns the branch |
| `className={isOpen ? 'a' : 'b'}` ternary | `cn('base', isOpen && 'a')`; pre-resolve to a variable |
| `{value ? <X/> : null}` gating render | Hoist to a variable, or lift the gate to the chassis |
| `data && <X/>` or `data?.field` in hydrated | Chassis didn't narrow; lift the guard up |
| Hook returns `{ canCreate, canDelete }` flags | Return optional handlers (`onCreate?`, `onDelete?`) |
| `children` prop, even for a single slot | Named zone prop (`contentZone`, `titleZone`) |
| Layout takes domain values (`selectedDate`, `userId`) | Layouts take `ReactNode` zones + UI booleans only |
| Skeleton file recreates layout structure | Reuse the Layout; populate zones with skeletons |
| Props relayed through a layout to a leaf | Bind at the chassis; layout passes only `ReactNode` zones |
| `Platform.OS` ternary inside one component | Split into `.tsx` / `.web.tsx` with shared `.types.ts` |
| Platform-split pair without sibling `<base>.types.ts` | Add the shared types file; both variants import contract from it (hard requirement, even for trivial signatures) |
| Same type/interface declared inline in both `foo.ts` and `foo.web.ts` | Move the type to `foo.types.ts`; both variants `import type` from it |
| Platform-split pair with mismatched extensions (`foo.ts` + `foo.web.tsx`) | Rename to matching extensions; when they disagree Metro's resolver can pick the wrong variant, silently pulling native code into the web build |
| `foo.types.ts` imports from a platform-specific package (e.g. `@livekit/react-native-webrtc`) | Hand-define the contract; even `import type` can leak the package into the web Metro bundle |
| State branching scattered through JSX (`&&` / `?:`) | Pull branching into chassis flat early-returns |
| `useMutation` / `graphql()` / `Toast.show()` outside `actions/` | Extract to `actions/use<Noun>Actions.ts` |
| `useQuery` in any file other than `index.tsx` | Chassis owns query lifecycle; move it up |
| `useEffect` for a user-action side effect | Move to a handler function; effects are an escape hatch |
| Router hook (`useRouter`, `useParams`, `useNavigate`, etc.) downstream of the shell | Push router contact to the shell; pass resolved values + callbacks as props |

## Component folder organization

Beyond the per-feature `<feature>/` shape (chassis + layout + parts + actions + utils), the broader `components/` tree is organized by **domain**, not by component kind:

```
components/
  <domain>/                  # Business domains: e.g., session/, account/, billing/
    <feature>/               # Zone-composer features within a domain
      index.tsx              # Chassis
      ...
    <thing>.tsx              # Simple domain components (file = no internal structure)
  ui/                        # shadcn-style UI primitives, reusable, defensive
  charts/, datetime/, ...    # Shared language: cross-domain visual vocabulary
  primitives/                # Low-level web↔native interop infrastructure
```

**Domain-grouping rationale:** opening `components/<domain>/` reveals one coherent surface area. Domain folders are *atomic ideas*; if a folder starts representing multiple ideas, split into separate domains; a higher-level feature can compose them.

**Cross-domain features** (e.g., a tool relating two domain concepts) live in the **primary** domain folder by ownership of the relationship, not as a separate top-level cross-cutting bucket. A "members-by-company" tool lives under whichever side owns the relationship semantically.

**File vs folder is the intelligence boundary.** A `.tsx` file in a domain folder is presentational and standalone. A folder triggers zone-composer rules: `index.tsx` is the chassis; everything else is presentational or extracted logic.
