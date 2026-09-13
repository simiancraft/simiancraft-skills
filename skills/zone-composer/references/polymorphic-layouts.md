# Zone Composer: Polymorphic Layouts

> Reference for the `zone-composer` skill. Runtime-switchable layout strategies (card vs accordion vs table) over a stable zone contract.

## Polymorphic layouts (advanced)

The same zone contract can render through multiple presentation strategies, card vs accordion vs table, selected at runtime. The `.types.ts` zone contract (see the shared-types rule in `key-patterns.md`) is the stable boundary; only the selector mechanism differs (bundler suffix for platform; React component reading context or a chassis-bound component-type prop for runtime).

**Two axes of polymorphism:**

| Axis | When it switches | Mechanism |
|---|---|---|
| **Platform** | Build time | Expo `.tsx` / `.web.tsx` file suffixes; bundler picks the file |
| **Presentation** | Runtime | React context + selector component, or a component-type prop bound at the chassis; user or state picks the strategy |

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

**Runtime strategy invariants for the context-selector recipe:**

- **Strategy selection is a leaf decision.** The selector reads mode from context; callers still import `Layout` the same way.
- **Strategies consume resolved zones and presentation props.** Layout-owned callbacks such as `onDismiss` are allowed; no domain props. If a strategy needs domain awareness, the contract is wrong.
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

## Prior art: admin-actions presentation switching

Lifeguides `components/admin/admin-actions/index.tsx` composes resolved scenario content and CTA nodes into `ScenarioLayout`; its top-level `AdminActionsLayout` receives `headerZone`, `bannerZone`, and `actionsZone` in `components/admin/admin-actions/layout.tsx`. No scenario data needs to pass through that outer layout.

`components/admin/admin-actions/scenarios/layout.tsx` supplies the runtime precedent:

| Symbol | Responsibility |
|---|---|
| `ScenarioLayoutProvider` | Holds `card` / `accordion` presentation state in context. |
| `PresentationModeToggle` | Changes presentation state. |
| `ScenarioLayout` | Selects `ScenarioCardLayout` or `ScenarioAccordionLayout` with the same node contract. |
| `ScenarioLayoutParent` | Selects the outer View or Accordion root required by the presentation. |

The source shares `ScenarioLayoutProps` inline in that one file and uses `title` as the Accordion item's value. Those are existing choices, not new conventions: extract `.types.ts` for shared strategy contracts, and use explicit stable identity as the rule above prescribes. The source demonstrates node-fed runtime presentation switching; it does not implement the table strategy used as an illustrative option earlier.

## Selection layouts: platform and presentation

A selected item's popover is a polymorphic layout. Selection belongs to the chassis; the layout decides where the resolved anchor and selected content appear, and reports dismissal through `onDismiss`. A popover, inspector column, and bottom sheet fulfill the same zone contract.

| Axis | Contract and dispatch | Prior art |
|---|---|---|
| Platform | `selection-layout.tsx`, `selection-layout.web.tsx`, and shared `selection-layout.types.ts`; native uses a named portal host, and web uses Radix. | Lifeguides `components/primitives/popover/popover.tsx` uses `RNPPortal`; `components/primitives/popover/popover.web.tsx` imports `@radix-ui/react-popover`. Both import `components/primitives/popover/types.ts`, the source's existing shared filename. |
| Presentation | The chassis defaults and mounts `selectionLayout?: ComponentType<SelectionLayoutProps>`; the consumer can change the selected strategy at runtime. | Abstracted from the context-selected strategies in `components/admin/admin-actions/scenarios/layout.tsx`; the component-type selection API below is a recipe, not an existing prop in that file or combobox. |

This explicit strategy prop is an alternative to ambient presentation context. `selectionLayout` names a layout type, so it is the naming exception to the pluggable part's `Component` suffix. It is bound at the chassis and never relayed through another layout. `anchorZone` and `contentZone` remain `ReactNode`s. The layout's `onDismiss: () => void` callback reports an interaction; it is not a function for rendering content or relaying domain data.

Illustrative shared contract and chassis binding; the item types, default strategy, and visual parts stand for the feature's own components:

```tsx
import type { ComponentType, ReactNode } from 'react';

export type SelectionLayoutProps = {
  /** The already-mounted selection anchor; the layout positions it. */
  anchorZone: ReactNode;
  /** Resolved selected-item details; null when no item is selected. */
  contentZone: ReactNode;
  open: boolean;
  onDismiss: () => void;
  portalHost?: string;
};

type SelectionProps = {
  selectionLayout?: ComponentType<SelectionLayoutProps>;
};

export function Selection({
  selectionLayout: SelectionLayout = PopoverSelectionLayout,
}: SelectionProps) {
  const { selectedItem, selectItem, dismiss } = useSelection();
  let contentZone: ReactNode = null;
  if (selectedItem) contentZone = <SelectionDetails item={selectedItem} />;

  return (
    <SelectionLayout
      anchorZone={<SelectionAnchor onSelect={selectItem} />}
      contentZone={contentZone}
      open={selectedItem !== null}
      onDismiss={dismiss}
    />
  );
}
```

Default the type once and mount it; do not call `selectionLayout(props)`, pass `selectedItem` into the layout, or accept `renderSelection`. Each platform implementation owns positioning and close mechanics. Native dismissal from overlay press or hardware back, web dismissal from Radix, and a sheet close gesture all call the same `onDismiss`. The chassis clears selection in that handler.

## Native mechanism: the portal host store

Lifeguides `components/primitives/portal.tsx` holds a module-level store whose `state.map` is a `Map<hostName, Map<portalName, ReactNode>>`. `Portal` registers its node in an effect and removes it on cleanup; `PortalHost` subscribes and renders the node values for its name. This is an external host store, not a React context provider carrying the whole overlay tree.

| Boundary | Source behavior and recipe |
|---|---|
| Host ownership | Mount `PortalHost` once per host name at the owning layout's overlay destination, not per row. Keep it mounted while selection changes. Give independent layout instances distinct host names. The default host name is `INTERNAL_PRIMITIVE_DEFAULT_HOST_NAME` in `components/primitives/portal.tsx`. |
| Overlay override | Expose `portalHost?: string` on every overlay so it can target its containing layout's host. `components/ui/popover.tsx` demonstrates this: `PopoverContent` forwards `portalHost` to `PopoverPrimitive.Portal` as `hostName`. This is the prescribed convention for every overlay; the inspected wrapper proves it for popover. |
| Native mounting | `components/primitives/popover/popover.tsx` registers through `RNPPortal`, using a per-instance `nativeID` for the portal name. It re-provides its own `RootContext` around the portaled children; do not assume arbitrary caller context survives a store-based move to a host. |
| Native anchor and dismissal | The native Trigger measures its position; Portal returns null until a trigger position exists. Overlay press and Content's hardware-back integration close the popover. A selection layout must supply its anchor integration as well as the host; merely setting `open` does not measure an anchor. |
| Coordinate adjustment | `useModalPortalRoot` in `components/primitives/portal.tsx` measures the native root and returns a negative vertical `sideOffset`; the native popover's Portal comment calls out custom-host offset adjustment. Keep this coordinate work inside the layout or primitive integration. |
| Web mounting | `components/primitives/popover/popover.web.tsx` delegates to Radix Portal and accepts `container`; the native `hostName` is not the web destination mechanism. Keep the platform distinction behind the shared layout contract. |

For a native selection layout that owns its host, resolve a stable host name, mount one `<PortalHost name={hostName} />`, and direct each overlay to that same name. If `portalHost` names an already-mounted ancestor host, target it and let the ancestor remain its sole owner; do not mount a duplicate host with the same name. The web strategy mounts the corresponding Radix infrastructure. The inspector strategy can arrange the two nodes in columns without a portal, and the sheet strategy can place `contentZone` in its sheet. These are presentation implementations of one contract; selection and domain actions stay in the chassis.
