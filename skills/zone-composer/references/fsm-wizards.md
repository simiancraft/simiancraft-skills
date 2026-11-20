# Zone Composer: FSM-Driven Wizards

> Reference for the `zone-composer` skill. Multi-step flows as layout polymorphism over a state machine.

## FSM-driven wizards (advanced)

Multi-step flows are layout polymorphism (the runtime-switching mechanism in `polymorphic-layouts.md`) over a state machine. The FSM has discriminated union state (per-step shape), a pure reducer for transitions, and side-effectful event handlers that dispatch reducer actions. The zone-composer pieces:

- **State type**: discriminated union with per-step shape (`{ step: 'select-day' } | { step: 'select-time'; selectedDay: Date } | ...`).
- **Reducer**: pure transitions only. Guards prevent illegal state changes (can't skip ahead). No side effects.
- **Wizard hook**: owns reducer state + dispatched event handlers (`selectDay`, `selectTime`, `confirmDateTime`). Side-effectful transitions (API calls) are handler functions that dispatch.
- **Wizard component**: picks the resolved step node to render based on the current discriminated-union tag. Zero logic: the chassis constructs all step nodes, and the wizard just selects which one to display.

```tsx
const { currentStep, selectDay, selectTime, confirmDateTime } = useWizard(deps);

<Wizard
  currentStep={currentStep}
  steps={{
    selectDay: <SelectDayStep onSubmit={selectDay} />,
    selectTime: <SelectTimeStep onSubmit={selectTime} />,
    confirm: <ConfirmStep onSubmit={confirmDateTime} />,
  }}
/>
```

**When to use FSM vs simple layout switching:**

| Simple switching | FSM wizard |
|---|---|
| UI chrome changes (card vs accordion, modal vs drawer) | Multi-step flow with accumulated data |
| State is a single enum | State is a discriminated union |
| No transition rules | Transitions have guards (can't skip ahead) |
| No side effects on transition | API calls at specific transitions |

**Anti-patterns:**

- Calling a "start" function during render: singleton/debounce smell.
- `useEffect` to trigger step transitions: transitions are user events, not effects.
- Async logic in the reducer: reducer must be pure; side effects belong in the hook's event handlers.
- Wizard component with any logic beyond a step switch: if the wizard checks data or calls hooks, the boundary leaked.

## Root-composed steps and step-composed steps

Both patterns are valid; the wizard receives a table of resolved `ReactNode`s in either case. It selects a node, never invokes a step render function.

| Pattern | Who fills StepLayout? | Tradeoff |
|---|---|---|
| Root-composed | The root chassis writes every step tree, including content, submit controls, and back controls. | One file shows the whole flow; that file grows with the steps. |
| Step-composed | Each step file mounts StepLayout and fills its zones; the root mounts the step component. | Per-step encapsulation; reading the whole flow takes several files. |

**Canonical domain prior art: Lifeguides.** `components/session/session-scheduler/index.tsx` uses root composition. Its hydrated `SessionScheduler` constructs every `StepLayout` node in the `steps` table handed to `ScheduleSessionWizard`; only the selected tree mounts. `components/session/session-scheduler/steps/layout.types.ts` names the slots `contentZone`, `submitButton`, and `backButton`; all are nodes. The last two are historical names for node slots; new contracts use the `Zone` suffix. `steps/layout.tsx` and `steps/layout.web.tsx` arrange the same contract on native and web.

For example, the root places `SelectTimeStep` in `contentZone`, `SubmitButton` in `submitButton`, and `BackButton` in `backButton`. The step body does not mount StepLayout. `components/session/session-scheduler/schedule-session-wizard.tsx` owns the hook, reducer, and node selector; `schedule-session-wizard.types.ts` shares the discriminated state and actions. Do not describe these existing step files as all being mini-composers. Step composition is an alternative organization, not what this root implements.

## Eager construction and typed sentinels

Constructing the entire node table evaluates every step's prop expressions each render. It does not mount every step or run inactive component hooks: `ScheduleSessionWizard` returns only the node for `currentStep`. The tradeoff is a complete, readable table in exchange for constructing inactive elements and supplying total prop shapes before their data exists.

Lifeguides `components/session/session-scheduler/schedule-session-wizard.tsx` uses two named, inert values:

```tsx
const OFF_SCREEN_DAY = calendarDayFromParts(1970, 1, 1);
const OFF_SCREEN_TIME_SLOT: TimeSlot = {
  value: new Date(0),
  label: '',
  category: 'morning',
  available: false,
};
```

`calendarDayFromParts` in `components/session/session-scheduler/utils/date-tools.ts` constructs the branded `CalendarDay`; the sentinel remains a valid typed value. The hook supplies `OFF_SCREEN_DAY` to inactive time and confirmation steps, and `OFF_SCREEN_TIME_SLOT` to inactive confirmation. `components/session/session-scheduler/steps/confirm-date-time-step.tsx` consequently keeps required `CalendarDay` and `TimeSlot` props. Do not weaken those contracts to optional props, or cast `undefined` into them.

Keep three invariants: the reducer guarantees real values for the active tag; the selector mounts only that tag's node; sentinels never become submitted values. Inert here means unused off-screen data, not a magic query-disable value. If all steps begin mounting for animation or preloading, revisit the design before a sentinel can drive a query or action. Construct only the selected branch's node when eager construction no longer fits; do not replace the table with render-function props. An actual empty selection, such as the day step's `CalendarDay | null`, remains a real state and does not need a sentinel.

## Nested chassis recipe: a query-owning step

Lifeguides `components/session/session-scheduler/steps/select-time-step.tsx` exports `SelectTimeStep`, which owns `GET_AVAILABLE_TIMES_BY_DATE_QUERY`. It accepts a required `selectedDate` and `guideId`, computes bounds, calls `useQuery` with `skip: !bounds`, and flat-branches invalid bounds, loading, errors, absent times, and no remaining slots before mounting the picker. Its parent `components/session/session-scheduler/index.tsx` keeps submit and back controls in StepLayout.

1. Accept resolved query inputs and callbacks for selected values; keep wizard transitions in the parent hook.
2. Call the query hook unconditionally. Use query options to skip invalid inputs; do not return before hooks.
3. Flat-branch the step's own states into complete bodies. For new code, order error, loading, empty, and ready after preconditions; the source currently checks loading before its query error.
4. Narrow data once and mount the presentational body with resolved props. Keep external submit and back nodes outside this query boundary.

The step is a nested chassis, even though its file is named `select-time-step.tsx`. This is the explicit exception to "queries live in index.tsx"; it does not authorize queries in ordinary leaves. Extract its orchestration hook when needed, and keep mutations in `actions/`. The scheduler's `components/session/session-scheduler/actions/useBooking.ts` supplies the booking boundary. Its existing `parts/submit-button.tsx` still takes flags; that is separate from the valid root-composition and nested-query patterns described here.
