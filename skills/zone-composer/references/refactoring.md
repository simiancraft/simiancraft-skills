# Zone Composer: Refactoring Into Zones

> Reference for the `zone-composer` skill. The recovery path: migrating flag-driven code into the pattern. For migrating a concrete layout into a runtime-switchable one, see `polymorphic-layouts.md`.

## Refactor protocol (recovery path)

When you discover the smell late and need to migrate flag-driven code into zones:

1. **Extract a chassis.** Move existence checks and state branching into flat early returns at the top of `index.tsx`.
2. **Split the hydrated success case** into a no-suffix component with fully resolved types (no null guards).
3. **Split flag-driven leaves into per-state leaves.** `CTA(disabled, isSubmitting, label)` → `CTA(onPress)` + `CTALoading()` + `CTADisabled()`.
4. **Convert hook flag returns to optional handlers.** `{ canCreateX, onCreateX }` → `{ onCreateX?: () => void }`. Chassis hides the button when undefined.
5. **Extract mutations + toasts to `actions/use<Noun>Actions.ts`.** Scenario/feature files don't import `useMutation`, declare GraphQL mutations with `graphql()`, or call `Toast.show()`. Action hooks return async functions (often `Promise<boolean>` or `Promise<T | null>`); the scenario orchestrates them as pure composition. (The actions pattern is detailed in `key-patterns.md`; GraphQL fragment and data-flow specifics live in `graphql-fragments.md`.)
6. **Extract layout** when chrome diverges across states or platforms.

Each step is independently committable; after each, the surface is DRYer or unchanged, never more duplicated.
