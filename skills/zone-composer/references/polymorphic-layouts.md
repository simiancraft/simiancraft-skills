# Zone Composer: Polymorphic Layouts

> Reference for the `zone-composer` skill. Runtime-switchable layout strategies (card vs accordion vs table) over a stable zone contract.

## Polymorphic layouts (advanced)

The same zone contract can render through multiple presentation strategies, card vs accordion vs table, selected at runtime. The `.types.ts` zone contract (see the shared-types rule in `key-patterns.md`) is the stable boundary; only the selector mechanism differs (bundler suffix for platform; React component reading context for runtime).

**Two axes of polymorphism:**

| Axis | When it switches | Mechanism |
|---|---|---|
| **Platform** | Build time | Expo `.tsx` / `.web.tsx` file suffixes; bundler picks the file |
| **Presentation** | Runtime | React context + selector component; user or state picks the strategy |

**Layout is ready for runtime polymorphism when:**

- Presentational only: no domain state, no network, no orchestration. Conditional logic inside the layout is presentational-only (spacing, variant class names).
- Stable interface: props are small, predictable, don't leak domain values. Already used by multiple callers or states without drift.
- Named zones, not `children`: zones are `ReactNode` slots. This is the seam that makes strategy swapping possible.

**Diagnostic smells (NOT ready):**

| Smell | Problem |
|---|---|
| Layout takes `data`, `items`, `selectedId`, `onSubmit` | Domain values in layout props: extract to zone components |
| Layout takes `isLoading`, `isError`, `isSubmitting` | State branching belongs in chassis, not layout |
| Layout renders different children based on data state | Layout is doing chassis work: refactor branching out |
| Call sites do `layoutProps = { ...props }` and pass through | Relay-prop gravity; layout is coupled to caller's shape |

If these smells are present, refactor into proper zone-composer shape *first* (see `refactoring.md`). Making a layout polymorphic while it still owns domain state will get messy.

**Runtime strategy invariants:**

- **Strategy selection is a leaf decision.** The selector reads mode from context; callers still import `Layout` the same way.
- **Strategies consume only zones.** No domain props. If a strategy needs domain awareness, the contract is wrong.
- **Some strategies require an outer container** (Accordion root, Table root). Container switching happens one level up, not inside the strategy.
- **Mode state is ambient, not passed.** Strategies read mode from context; zone-filling components never receive a `mode` prop.
- **Identity is strategy-specific.** If a strategy needs a stable identifier per rendered unit (e.g., for accordion expansion state), require `itemId` explicitly. Don't invent fallbacks from display text.

**The recipe (evolving a single concrete layout into a runtime-switchable system):**

1. **Lock the zone contract.** Extract zone props to `.types.ts`; both strategies and the selector import the same types. Nothing about the contract changes during the refactor.
2. **Extract the existing layout into a concrete strategy.** Rename `ScenarioLayout` to `ScenarioLayoutCard` (or move to `layout-card.tsx`). The implementation is unchanged; only the export name moves.
3. **Add a second strategy** with the same interface (`ScenarioLayoutAccordion`).
4. **Define the presentation mode type**: a discriminated union of mode tags: `type LayoutMode = 'card' | 'accordion' | 'table'`.
5. **Create the presentation state hook** that exposes mode + setMode, backed by React context. Strategies read this; callers don't pass it.
6. **Add the selector** in `layout.tsx`: a thin component that reads mode from context and delegates to the right strategy. Preserves the old import path.
7. **Handle wrapper polymorphism** when strategies need a different outer container (Accordion root above the items). Container switching lives one level up.
8. **Add the toggle and wire the provider**: usually at the route or screen level, where the user picks card vs accordion.

**Single-file vs multi-file:** runtime strategies don't require file splitting. Single-file (`layout.tsx` contains both strategies plus the selector) is best for small strategies. Multi-file (`layout-card.tsx` / `layout-accordion.tsx` plus selector in `layout.tsx`) is best when strategies are large or need independent stories/tests.

**Do not touch during the refactor:** the chassis branching, the hook(s), the zone-filling components, the `.types.ts` contract. Only layout files change. If you find yourself editing chassis or hook code, the layout wasn't ready (return to the readiness checklist).

**Why this works:** the chassis branches once on data state; layouts swap independently on presentation state. The two axes don't intersect, so refactor blast radius stays minimal. Hydrated JSX becomes a structural outline (which zones go where), and control-flow complexity stays in chassis and hooks where it's easier to reason about.
