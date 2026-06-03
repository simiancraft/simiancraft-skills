# Zone Composer: FSM-Driven Wizards

> Reference for the `zone-composer` skill. Multi-step flows as layout polymorphism over a state machine.

## FSM-driven wizards (advanced)

Multi-step flows are layout polymorphism (the runtime-switching mechanism in `polymorphic-layouts.md`) over a state machine. The FSM has discriminated union state (per-step shape), a pure reducer for transitions, and side-effectful event handlers that dispatch reducer actions. The zone-composer pieces:

- **State type**: discriminated union with per-step shape (`{ step: 'select-day' } | { step: 'select-time'; selectedDay: Date } | ...`).
- **Reducer**: pure transitions only. Guards prevent illegal state changes (can't skip ahead). No side effects.
- **Wizard hook**: owns reducer state + dispatched event handlers (`selectDay`, `selectTime`, `confirmDateTime`). Side-effectful transitions (API calls) are handler functions that dispatch.
- **Wizard component**: picks the step component to render based on the current discriminated-union tag. Zero logic: the chassis pre-renders all step zones, and the wizard just selects which one to display.

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
