# Zone Composer: Code Style

> Reference for the `zone-composer` skill. Adjacent conventions that are not strictly zone-composer-specific but pair well with the pattern.

**TypeScript**
- Always use `import type` for type-only imports.
- Use `function` declarations for top-level exports; arrow functions for callbacks. (`export function Foo() {}`, not `export const Foo = () => {}`.)
- Use type inference when the type is obvious; reserve explicit annotations for ambiguous cases.

**File naming**

| Type | Convention | Example |
|---|---|---|
| Components | `kebab-case.tsx` | `home-screen.tsx` |
| Hooks | `useXxx.tsx` or `useXxx.ts` | `useMe.tsx`, `useAuth.ts` |
| Utils | `kebab-case.ts` | `format-date.ts` |
| Tests | `xxx.test.ts` | `home-screen.test.ts` |
| Stories | `xxx.stories.tsx` | `button.stories.tsx` |

**Component naming.** `PascalCase` (`HomeScreen`, `Button`); descriptive over generic (`PersonableAvatar`, `HomeCTA` over `Avatar`, `Header`).

**Path aliases.** Use whatever path-alias prefix your project has declared in `tsconfig.json` `paths` (or your bundler equivalent), such as `~/`, `@/`, `#/`, `src/`, or custom, instead of relative `../../` chains for cross-folder imports. The prefix doesn't matter; the *shape* does. Aliased imports are always **root-to-child** (`<prefix>/components/feature/parts/foo`), which is easier to reason about than counting `../` hops to figure out where a file actually lives. Same-feature relatives (`./parts/foo`, `../actions/useFoo`) stay relative; they carry the "lives next to me" signal that aliasing would erase.

**Import organization.** Group imports in this order, with a blank line between groups:

1. Node/builtin (rare)
2. External packages (`react`, `react-native`, third-party)
3. Path-aliased internal imports (whatever your project's prefix is: `~/components/...`, `@/components/...`, etc.)
4. Relative imports from the same feature (`./parts/...`, `./actions/...`)
5. Type-only imports

**Function placement.** Public exports at the top; private helpers at the bottom of the same file. Promote helpers to `utils/` when shared across files or complex enough for dedicated tests; promote to `actions/` when they involve network operations.
