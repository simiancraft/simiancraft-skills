# Zone Composer: Key Patterns

> Reference for the `zone-composer` skill; read `SKILL.md` first. Cross-cutting patterns and deep vocabulary, loaded on demand.

## Recursive slicing: managing chassis growth

Zone composer scales by **slicing**, not by accumulating inline branching. If the chassis JSX grows large, you don't add ternaries; you introduce another zone boundary:

- Chassis → `Layout` (platform-swappable).
- Domain-folder level → its own `layout.tsx` (platform-swappable). For a wizard whose domain folder is `steps/`, that's a `StepLayout`; for a list whose domain folder is `list/`, it's the list's own layout. The role is "the layout for this sub-domain"; the name follows the sub-domain.
- Sub-folder flows → their own mini-composers (repeat the pattern).

Feature folders are meant to be **atomic domain ideas**. Opening a feature folder should reveal one coherent surface area. If it starts representing multiple ideas, split into separate feature folders; a higher-level feature can compose them.

**Hook composition is allowed and expected.** A hydrated feature can compose multiple hooks; the chassis is where cross-domain dependencies are integrated *once*, and everything downstream stays presentational. Leaf components remain reusable because they're behaviorally dumb; steps and parts can be reused elsewhere by fulfilling their props; they don't import feature hooks by default.

## Trunk-to-leaf file order

A zone-composer file reads top-down as a tree walk from root to leaves: **exported root first, descendants below in the order they nest, utils at the bottom.** Same rule for any tier (chassis file, layout file, scenario file). A reader scrolling the file traverses the same path React traverses at render time.

Order inside a typical chassis file:

1. **Imports** (alphabetized within group; React first, third-party, then aliased `~/`).
2. **Module-scoped constants and types** that the rest of the file references. These aren't tree nodes; they're configuration that needs scope above its consumers. Keep this band small; large constant tables belong in a sibling file.
3. **Exported root component** (the chassis, screen, panel, scenario). This is what other files import; it should be the first declaration a reader meets.
4. **Private child components**, in tree order: the components the root composes, then the components those compose, and so on. A widget that fills a layout's `interactionZone` lives directly below the root that mounts it; the widget's sub-visualizers (Visual, Matrix, Panel) live below the widget.
5. **Utility functions** at the bottom: pure helpers like `buildCode(state)`, formatters, classification predicates. No JSX, no hooks; the leaves of the file's logical tree.

**Why this order:** the reader's first question is "what does this file export?" The export should be visible without scrolling. Their second question is "what does the export render?", and the answer is the very next declaration. Working top-down through the file mirrors working top-down through the rendered component tree. Inverting (utils first, then leaves, then root) forces the reader to assemble the picture from the bottom; that's the way a *compiler* reads a file, not a human.

**Exception (rare):** if a util is short and *only* used by one nearby leaf, colocate the util just above that leaf. The "utils at the bottom" rule applies to file-wide helpers; one-call-site helpers can ride along with their caller.

## Layouts are the documentation surface for ReactNode slots

A layout's zone props are almost always typed `ReactNode`. That type carries no contract; a `titleZone: ReactNode` says nothing about whether the slot expects a `<SectionHeader>`, a button group, an `<h1>`, or arbitrary inline copy. The contract lives in the docstring on the prop, **at the point of implementation**.

**Doc every zone prop**, even when the prop name seems self-explanatory. Each zone JSDoc should answer:
- **What goes here.** Conventionally a `<Foo>` doing X, but any ReactNode satisfying these constraints. Name the most common filler explicitly.
- **What's already provided.** "Wrapped in a card by this layout; sections should not add their own card wrap." "Rendered as a single `<p>`, so do not nest a block element here." This is the invisible contract a future contributor or LLM will otherwise rediscover by trial and error.
- **The convention.** "Inputs at top, then visualizer, then readouts." "buildCode(state) returning a string; numeric comments route through formatMagnitude." Convention captured here travels with the chassis instead of decoupling into a separate docs file that goes stale.

The payoff is twofold: (1) IDE hover and LLM context window both see the contract next to the import; (2) splitting a chassis into nested layouts (`SectionLayout` → `WidgetLayout`) becomes a documentation act, not just a structural one; each new layout is a chance to name what its zones expect.

When a zone has more than one accepted shape ("ReactNode, but usually `<X>` and sometimes `<Y>`"), say so. When a zone is platform-divergent in expectation, say so. When a zone has a cadence implication ("string changes on every drag tick; CodeBlock absorbs that via useDeferredValue"), say that too. The docstring is where load-bearing facts about the slot live.

## How it handles cross-cutting concerns

### Inline JSX conditionals

Most of the architecture is the skill's **answer to inline conditionals downstream**. Flat-branching chassis, non-defensive hydrated components, branching in chassis guards: those rules exist *because* they prevent `condition && <X/>` and ternary scaffolding from sprawling through JSX. Optimistic catches upstream (early returns, narrowing, zone swaps) produce JSX that reads as a static outline.

Exemplars have *some* inline conditionals (the rule isn't "zero") but **dramatically fewer than typical React**. That's the signal upstream catches are working.

**Diagnostic when you see one mid-edit:** reaching for `condition && <X/>`, a ternary `className`, or `value ? <X/> : null`? Ask *"why didn't the chassis catch this?"*, not *"how do I express this inline?"* The fix is usually upstream:

- `value ? <X/> : null` gating a whole section → chassis should swap zones, or parent should decide whether to render
- Ternary on `className` from a state flag → parent already knew the state; leaf shouldn't wear it as a flag prop
- Multiple ternaries in one JSX block → extract a subcomponent, or chassis should branch one level higher

**Tactical fallbacks** when an inline conditional genuinely earns its place:

1. **`cn()` for className switching.** `cn('rounded-full', isOpen && 'bg-emerald-500')`; better yet, pre-resolve as a variable.
2. **Hoist a `ReactNode` into a named variable.** `const statusBadge = isOpen ? <OpenBadge/> : <ClosedBadge/>`: pulls switching out of the visual tree; the name documents intent.
3. **Extract a subcomponent.** Internal branching (list vs empty)? `<TranscriptsList items={items}/>` owns its own early return.
4. **Lift to chassis.** None of the above? Branch belongs upstream; chassis swaps the entire zone.

**Acceptable:** micro-interpolation on primitives (`<Text>Door is {isOpen ? 'open' : 'locked'}</Text>`); `.map()` list-rendering; discriminated-union step switches when no better expression exists.

### Flag props on leaves

A flag prop like `disabled` / `loading` / `isSubmitting` / `canCreateX` on a leaf encodes "the chassis already decided this; here's the bit." That's relay, not presentation. The fix:

- Split the leaf per state (`CTA(onPress)` + `CTALoading()` + `CTADisabled()`).
- Chassis swaps which leaf renders, based on its own state branch.
- The hook returns optional handlers (`onCreateX?: () => void`) instead of capability flags (`canCreateX: boolean`); undefined handler = chassis hides the button.

Exception: **interaction state owned by the same component** stays as a flag prop. A `SubmitButton` that takes `isSubmitting` because pressing it triggers the in-flight mutation owns its own lifecycle.

#### Anatomy of a state-swap leaf (the most common in-the-wild form)

A control inside a panel is itself a mini-chassis: it flat-branches its own resource / loading / idle / submitting states and **dispatches to a per-state subcomponent**. Each subcomponent is dirt simple; its appearance is its name. No `disabled={loading}` props anywhere.

```tsx
// ✅ Mini-chassis: flat-branches and swaps a named subcomponent per state
function FollowToggle({ profileId, isFollowing }: { profileId: string | undefined; isFollowing: boolean | undefined }) {
  const action = useFollowAction(profileId ?? '');   // useFollowAction must no-op on an empty id
  if (!profileId) return <FollowToggleUnavailable />;
  if (action.submitting) return <FollowToggleBusy />;
  if (isFollowing) return <UnfollowButton onPress={action.unfollow} />;
  return <FollowButton onPress={action.follow} />;
}

// Each subcomponent has zero flags; its name IS its state.
function FollowToggleUnavailable() { return <Button disabled variant="outline"><Text>Unavailable</Text></Button>; }
function FollowToggleBusy()        { return <Button disabled variant="outline"><ActivityIndicator size="small" /></Button>; }
function FollowButton({ onPress }:   { onPress: () => void }) { return <Button onPress={onPress}><Text>Follow</Text></Button>; }
function UnfollowButton({ onPress }: { onPress: () => void }) { return <Button variant="outline" onPress={onPress}><Text>Unfollow</Text></Button>; }

// ❌ Single leaf that wears every state as flags
function FollowToggle({ profileId, isFollowing, submitting, onFollow, onUnfollow }) {
  return (
    <Button
      variant={isFollowing ? 'outline' : 'default'}
      disabled={!profileId || submitting}
      onPress={!profileId ? undefined : (isFollowing ? onUnfollow : onFollow)}
    >
      {submitting ? <ActivityIndicator size="small" /> : <Text>{isFollowing ? 'Unfollow' : 'Follow'}</Text>}
    </Button>
  );
}
```

The mini-chassis form scales: adding a fifth state (e.g., `submitFailed`) is one new branch + one new 3-line subcomponent. The flag-prop form requires reading every ternary in the body to confirm the new state composes correctly with the existing ones, and the prop list grows linearly. This is the same shape as the feature-level chassis, just one scope deeper. **Every leaf with internal state-driven UI is a candidate for this split.**

**CTA-loading example: one shape of the submitting branch.** When a surface has interactive submit/in-flight flows, the chassis flat-branches into a Submitting state alongside the others. One common shape is when the submitting render mostly mirrors the hydrated layout but swaps a single zone (e.g., the CTA); the rest of the layout stays put. This is *one implementation* of the submitting branch, not its definition. Other surfaces (search bars, complex forms) may have visually distinct submitting renders.

```tsx
// ✅ Chassis flat-branches into submitting; CTA zone swaps for this surface's shape
if (isSubmitting) {
  return <Layout ... ctaZone={<CTALoading />} />;  // disabled button + spinner, no handler
}
return <Layout ... ctaZone={<CTA onSubmit={handleSubmit} />} />;  // handler only

// ❌ Relay state flags into the CTA
<CTA onSubmit={handleSubmit} isSubmitting={isSubmitting} disabled={isSubmitting} />
```

Item-level loading states follow the same rule: a list item with its own `ItemLayout` uses that layout populated with skeleton content, not a separate skeleton component that rebuilds the card structure.

### Side effects, mutations, toasts (the actions pattern)

The biggest source of feature-file bloat is inline mutations + toasts. The fix: **`actions/use<Noun>Actions.ts`** owns the mutation and the user-feedback logic; the feature file imports the action and orchestrates pure composition.

Worked example below: a multi-tool admin surface where each unit is called a "scenario" (the example feature's domain-folder axiom; see *Domain folders* in `SKILL.md`). Each scenario file lives at `scenarios/<scenario-name>.tsx`. Substitute your feature's own axiom term ("step," "slide," "form," whatever); the rule is the same.

```ts
// actions/useDatabaseActions.ts: owns the mutation, owns the toasts
export function useDatabaseActions() {
  const [mutate] = useMutation(RunSeedScenarioMutation);
  async function resetDatabase(): Promise<boolean> {
    const { data, errors } = await mutate({ variables: { ... } });
    if (errors?.length) { Toast.show({ type: 'error', ... }); return false; }
    if (data?.success) { Toast.show({ type: 'success', ... }); return true; }
    Toast.show({ type: 'error', ... });
    return false;
  }
  return { resetDatabase };
}

// scenarios/reset-database.tsx: pure composition, no useMutation, no Toast
import { useDatabaseActions } from '../actions/useDatabaseActions';
export function useResetDatabase() {
  const { resetDatabase } = useDatabaseActions();
  return { handleReset: resetDatabase };
}
```

A feature or sub-feature file importing `useMutation`, `graphql()`, or `Toast.show()` is wrong-shaped. Those belong in `actions/`. Even when the user-facing UI is identical, moving the mutation and toast out of the calling file is worth it on its own: the calling file reads as a static outline of zones; the action becomes reusable and testable as a transactional unit. (GraphQL fragment and data-flow specifics: `graphql-fragments.md`.)

**`useEffect` is also a side-effect concern.** Most cases that "need" an effect are better expressed as user-action-triggered handler functions, derived computation during render, or `useSyncExternalStore`. Genuine lifecycle exceptions (canvas, WebRTC, external subscriptions, DOM measurement) are real but rare; reach for `useEffect` only with reason.

### Platform variance

Build-time platform switching uses Expo's `.tsx` / `.web.tsx` file resolution with a shared `.types.ts` for the contract. Inline `Platform.OS === 'ios'` ternaries inside one component make it un-storyable, untestable per-platform, and prone to silent drift; they're banned in favor of the file-pair pattern.

**Layers are polymorphic by nature.** The same dispatch shape extends beyond platform to runtime polymorphism: theme, user role, feature flag. Build-time switching (`.web.tsx`) and runtime switching (card vs accordion, detailed in `polymorphic-layouts.md`) are conceptually unified: same zone contract, different render strategy.

#### Platform splits ALWAYS use a shared `.types.ts` file (hard requirement)

Every platform-split pair (`foo.tsx` / `foo.web.tsx`, or `foo.ts` / `foo.web.ts`) MUST have a sibling `foo.types.ts` that both implementations import their public type surface from. No exceptions for "trivial" pairs; even two `() => void` functions get a shared types file.

**Why.** TypeScript's type-check loads exactly one variant of the pair (the unsuffixed one) during a typical `bun check` / editor session. Drift in the `.web.tsx` variant goes unsignaled until web runtime. The shared `.types.ts` is the compile-time contract that forces both implementations to satisfy the same shape; a change there propagates as a compile error on both platforms.

**Conventions.**

- File naming: `foo.ts` (or `foo.tsx`) for the native/default variant; `foo.web.ts` (or `foo.web.tsx`) for the web variant; `foo.types.ts` for the shared contract. **Native is the unsuffixed file**, never `foo.native.ts`.
- Both implementations `import type { ... } from './foo.types'` and annotate their exports against those types. For const exports, also re-export the instance types as type aliases (`export type Foo = FooShape`) so consumers can write `new Foo(...)` AND `: Foo` from one import.
- `foo.types.ts` holds **zero** runtime imports from platform-specific packages. Even `import type { X } from '@livekit/react-native-webrtc'` can leak the package into the web Metro bundle in resolver edge cases. Hand-define the contract against the structural shape both platforms expose.
- **Extension parity matters.** `foo.ts` vs `foo.web.tsx` (mismatched extensions) is a known Metro-resolver footgun: the resolver can pick the wrong variant, so the web build silently pulls in native code and you hit a confusing runtime crash (e.g. `requireNativeComponent is not a function`) with no obvious cause. Always make the extensions match (both `.ts`, or both `.tsx`).
- Two copies of the same type living in `foo.ts` and `foo.web.ts` is the failure mode this rule exists to prevent. Reviewer must reject any platform-split pair that lacks a shared types file or duplicates types between variants.

**Reviewer checklist for any platform-split pair:**

1. Does `foo.types.ts` exist as a sibling?
2. Do both `foo.{ts,tsx}` and `foo.web.{ts,tsx}` import type annotations from `foo.types.ts`?
3. Do the platform variants have matching extensions?
4. Does `foo.types.ts` avoid runtime imports of platform-specific packages?
5. Are the exported type names identical in both implementations (no drift, no duplicate definitions)?

If any answer is "no," the pattern is broken and must be fixed before merge.

### Loading and skeleton states

Loading and no-data states **reuse the Layout** with skeleton/spinner content populating the zones, instead of being separate components that recreate the layout structure. Duplicated `className` between a skeleton file and the real layout is drift waiting to happen.

### File and folder organization

A feature folder has a fixed shape, only the **reserved roles**:

```
<feature>/
  index.tsx                    # Chassis: owns query + state branching, flat early returns
  layout.tsx                   # Zone container; .web.tsx companion if platform diverges
  layout.types.ts              # Only present if layout has a .web.tsx pair (see below)
  <x>.types.ts                 # Optional: only when multiple files share the same types
  parts/
    <part>.tsx                 # Small presentational pieces, .web.tsx if needed
    <part>.stories.tsx
  actions/
    use<Noun>Actions.ts        # Mutation + toast hooks
  utils/
    <category>.ts
    <category>.test.ts
```

**When to extract a `.types.ts` file.** The rule: **extract when multiple files implement or consume the same interface.** Otherwise inline the types. Three concrete cases force extraction:

1. **Platform pair (mandatory).** When a `.tsx` file has a `.web.tsx` companion (`layout.tsx` + `layout.web.tsx`, or `<part>.tsx` + `<part>.web.tsx`), they **must** share a `.types.ts` file. Reason: the TypeScript compiler only type-checks one of them per build target; `.web.tsx` is invisible on native, `.tsx` on web. Without a shared types file, the web implementation's props can silently drift from native and nothing catches it. The shared file is the only mechanism that keeps both lockstep.

2. **Runtime polymorphic layouts (mandatory).** When multiple strategies implement the same zone contract (`<X>Card` / `<X>Accordion` / `<X>Table`, modal vs. drawer renderers, etc.), they **must** share a `.types.ts` file. Same drift-prevention reason as the platform pair, just on a different dispatch axis: the strategies are interchangeable only because the type system enforces an identical interface. Without the shared file, two strategies' props can drift and no compiler error catches it.

3. **Multi-file shared types in one scope (recommended).** When a reducer, an orchestration hook, and a util all consume the same discriminated unions or state types (a common pattern in FSM-driven features; see `fsm-wizards.md`), put the shared definitions in `<x>.types.ts` so all consumers import the same authoritative source. The `<x>` matches the surface they're about.

**Default: inline.** Don't extract a `.types.ts` file just because types exist. Over-extraction is "not wrong, just harder to read"; fewer files when sharing isn't required. Extract only when sharing forces it.

**Do an explicit extraction pass.** When implementing or reviewing a feature, walk through every set of related files and consciously decide for each: *do these share types?* If yes, extract; if no, inline. Don't let this decision be implicit. Common gestures to look for: any `.tsx` with a `.web.tsx` sibling, any group of strategy files implementing the same layout zones, any feature with a reducer + hook + utils referencing the same state shape.

A feature **may also** add domain folders named after its own axiomatic concepts. Two illustrative shapes:

```
<wizard-feature>/
  index.tsx                    # Chassis
  layout.tsx, layout.web.tsx
  parts/
    <small-ui>.tsx, ...
  actions/
    <transaction>.ts
  utils/
    <category>.ts
  steps/                       # ← DOMAIN FOLDER ("step" is this feature's axiom)
    layout.tsx                 # StepLayout: pattern recurses; this folder has its own layout
    <step-name>-step.tsx       # Each step is a mini-composer fulfilling StepLayout zones
    ...
  <wizard-name>.tsx            # Wizard hook + component (orchestration paired with surface)
  <wizard-name>.types.ts
```

```
<multi-tool-feature>/
  index.tsx                    # Chassis: composes tool units into the surface
  layout.tsx
  parts/
    <small-ui>.tsx, ...
  scenarios/                   # ← DOMAIN FOLDER ("scenario" is this surface's axiom)
    layout.tsx                 # ScenarioLayout
    <tool-a>.tsx               # Each scenario file exports its own chassis-leaf split:
    <tool-b>.tsx               #   <Name>Description, <Name>Content, <Name>CTA,
    <tool-c>.tsx               #   <Name>CTALoading, plus use<Name> hook
    ...
```

### The route-shell layer (keep it thin)

Most projects consuming this skill have *some* router: Expo Router, Next.js (App Router or Pages Router), Remix, TanStack Router, React Router (Vite SPA), Nuxt, even older Angular-style declaration-based routing. Zone Composer doesn't require a router, but if you have one, it has opinions about the *shell* layer where your URLs and route params live.

**The shell layer goes by many names but does one job.** It's the bridge between the router (file-system or declaration-based) and your components. Common locations:

| Framework | Conventional shell folder |
|---|---|
| Expo Router | `app/` |
| Next.js (App Router) | `app/` |
| Next.js (Pages Router), Nuxt | `pages/` |
| Remix | `app/routes/` |
| TanStack Router | generated route tree (often `routes/`) |
| React Router (Vite SPA) | wherever you mount `<Routes>` (often `routes/` or inline in `App.tsx`) |
| Angular (declaration-based) | the routing module |

Whatever your router calls it, **the shell is where you talk about what your URL does and how you mess with its params**, and nothing else.

**Keep this layer small**: typically tens of lines per file, not hundreds. Its only responsibilities are: read route params (`useRouter`, `useLocalSearchParams`, `useParams`, `useSearchParams`, `useNavigate`, `useLocation`, or whatever your framework uses), invoke the feature, and pass the resolved values plus navigation callbacks as props. No data fetching, no state, no JSX beyond mounting the feature.

**Nothing downstream of the shell touches the router.** Not the chassis, not the layout, not parts, not actions, not utils. The shell extracts; everything below receives. A component that imports a router hook (`useRouter`, `useParams`, `useNavigate`, etc.) anywhere downstream is wrong-shaped; push the router contact up to the shell, and pass the resolved value down. This is the same boundary as the data-fetching one: the chassis owns the query lifecycle once, leaves never see Apollo; the shell owns the URL once, components never see the router.

```tsx
// routes/edit-user.tsx: route-shell file. Tens of lines.
export function EditUserRoute() {
  const { id } = useParams();
  const navigate = useNavigate();
  return (
    <UserProfileEditor
      userId={id}
      onSaved={() => navigate(`/users/${id}`)}
      onCancel={() => navigate(-1)}
    />
  );
}

// components/user/user-profile-editor/index.tsx: chassis. No router hooks.
export function UserProfileEditor({ userId, onSaved, onCancel }: Props) { ... }
```

**Why this matters.** The boundary peels off several cross-cutting concerns at once:

1. **Coupling.** A component reaching up to the router is glued to the URL shape. Renaming a route, lifting a screen into a modal, reusing a panel inside another flow: all become rewrites instead of recompositions. Keeping router contact in the shell means components stay portable across routes.
2. **Hostability in any out-of-app environment.** Storybook is the obvious case: it doesn't have your framework's router, and a leaf calling `useRouter()` won't render in it. **Don't mock the router**; the fix is the boundary refactor, not a fake router. The same logic generalizes to anything that runs or introspects your code outside the live app, none of which boots your router: static-analysis tools (madge, dependency-cruiser), doc generators (TypeDoc), and codemod runners (jscodeshift, ts-morph). Code in proper-separation shape works in all of them with no shim; code that reaches for ambient framework state in random places does not.
3. **Testability.** Same lever: passing resolved values as props means a unit test calls the component directly with a `userId`; an integration test still wires it through the real router. Both work without ceremony.

This is the same lesson as platform-switching, runtime polymorphism, and mutations-in-actions: **good organization peels cross-cutting concerns off for free**. The pattern is good despite the platform. Apply it correctly and the same component renders identically in your app, in Storybook, in tests, in a docs-gen tool, across web/native, with no per-environment rework. Apply it wrong (router hooks in the chassis, ambient framework calls in leaves) and every one of those environments becomes a separate problem.

**Fatal error guards in hydrated components** are the one allowed exception to "non-defensive hydrated." Some errors occur *after* hydration (during user interaction or side-effectful operations) and can't be represented as a valid UI state. The hydrated component may guard once, at the top, using the same flat early-return pattern as the chassis:

```tsx
const { error, reset, ...rest } = useFeatureHook({ ... });
if (error) return <ErrorHandler error={error} />;
```

This is not a violation of the non-defensive rule. The guard is on a runtime error from a side effect (e.g., a failed mutation), not on gated data the chassis already narrowed. Same flat shape; remaining JSX stays non-defensive.

**Controlled / uncontrolled chassis** is a common shape for embeddable panels. When `isOpen` is a passed prop, the panel is controlled externally; when omitted, the panel manages its own open state and renders a CTA trigger. In uncontrolled mode the chassis creates the CTA internally and passes it as `ctaZone`; in controlled mode `ctaZone` is undefined; the caller owns visibility.

**Multi-step flows use `useReducer`** for transitions guarded by current state. A discriminated union state type (per-step shape) plus a reducer centralizes pure transitions; side-effectful transitions stay as handler functions that dispatch.

```tsx
// Pure transitions → reducer
dispatch({ type: 'SUBMIT_DAY' });
dispatch({ type: 'BACK_TO_TIME' });

// Side-effectful transitions → handler
function submitSelectTime() {
  if (members.length === 0) { onNoMembers(); return; }
  if (members.length === 1) { dispatch({ type: 'ADVANCE_TO_CONFIRM', memberId: ... }); return; }
  dispatch({ type: 'ADVANCE_TO_MEMBER' });
}
```

## Storybook implications

- Stories mirror the chassis composition, not isolated zones.
- Story names match chassis branches: `ErrorState`, `Loading`, `Hydrated` (always); plus `NoData` and `Submitting` only when those branches exist for this surface. Order matches the trunk early-return order. The Storybook sidebar reads like the chassis.
- Don't render isolated leaves; render the full Layout with all zones populated.
- Hooks inside `render` break rules-of-hooks; extract a named wrapper component instead.
- Mock data lives in a single `mock-data.ts` at the feature root (`SCREAMING_CASE` exports), shared by all stories in the feature. Pure utils always have `.test.ts`.

## React Compiler compatibility

The pattern aligns with React Compiler's memoization assumptions:

- No `try/catch/finally` in hook bodies: extract async work, use `.catch()` or `.then(success, error)` on the call.
- No `useEffect` for user-action-triggered side effects: use handler functions.
- No manual `useMemo` / `useCallback` / `React.memo`: the compiler memoizes automatically.
- Branching lives in flat chassis guards, not JSX templates.
