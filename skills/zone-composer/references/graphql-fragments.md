# Zone Composer: GraphQL Fragments and Data Flow

> Reference for the `zone-composer` skill. The GraphQL realization of the data boundary. If you are not on GraphQL (Apollo / Relay / urql), apply the core data-boundary rule with your own data layer and skip this file.

## GraphQL data flow and fragments

The chassis and its orchestration hook own the query lifecycle; mutation hooks live in `actions/`. A named query-owning step is an explicit nested chassis exception to the `index.tsx` placement rule, not an ordinary leaf: Lifeguides `components/session/session-scheduler/steps/select-time-step.tsx` owns its query and flat-branches its states while the parent `components/session/session-scheduler/index.tsx` keeps submit and back controls. See `fsm-wizards.md` for the recipe. Leaves declare their data contracts as **colocated fragments**: a part needing data exports a `<Feature><Role>_<graphqlType>` fragment alongside its component, and the chassis query gathers fragments via spreads.

Each feature has its own local query; no central `graphql.ts`. Queries are **local to their consumer**: if two features use the same underlying query, each gets its own copy. They may diverge over time. Shared queries couple unrelated consumers; consumer-driven fragments scale; parent-curated field lists rot.

The chassis query is the extension point. Need more data in a part? Extend that part's fragment; the chassis query already spreads it.
