# DECISIONS (in-progress, disposable)

> **Delete this file as part of the first publish to `simiancraft-skills`.** It is a scratch home
> for decisions while the iOS-simulator skill set is being built, not a durable artifact. Same
> disposability rule as a `how-to-plan` plan: the moment the skills ship, the rationale lives in the
> SKILL.md files and git history, and this file is noise. Two-key handshake before deletion.

Branch: `feat/ios-simulator-skillset`. Target: a standalone simiancraft skill set that drives an
iOS Simulator end to end (build, drive, triage, evidence) for any Expo/RN app.

---

## D1. Driving primitive: AXe, accessibility-first
- **AXe** (`brew install cameroncooke/axe/axe`, v1.7.1) is the primary driver. It reads/drives the
  **accessibility tree** (`describe-ui`, `tap` by element or point, `type`, `swipe`, `key-combo`,
  `button`), and also captures evidence (`screenshot`, `record-video`, `stream-video`); `batch`
  runs a flow in one HID session.
- **Prefer accessibility over coordinates.** Coordinates are brittle; a11y labels/ids are stable.
  This is why `mobile-accessibility` is a foundational dependency, not an afterthought.
- **No fullscreen, ever.** The screenshot is the device pixel buffer (window-independent); when a
  coordinate is unavoidable, it is a device coordinate, not a window-mapped one. Read state, never
  mutate the window. `cliclick` + live window-bounds is the no-install fallback only.
- We are **not** running `axe init` (it installs AXe's own skill files). Per the no-prior-art-deps
  rule, we author our own.

## D2. Accessibility is its own skill (the shared trunk)
- One accessibility tree, **two consumers reading different fields**:
  - **Driving** wants the stable **handle**: `testID` (-> iOS `accessibilityIdentifier`).
  - **Auditing** wants the user-facing **semantics**: `accessibilityLabel` (name), role, state, focus.
- So `mobile-accessibility` owns "how to set all of these correctly"; the simulator/driving skills
  consume the handle; the future general auditing skill consumes the semantics. Burying it in the
  simulator skill would force the auditing skill to redefine it: that is the DRY violation we avoid.
- `mobile-accessibility` now (iOS-native + RN/Expo, Android-extensible). `web-accessibility` is a
  future sibling. A future cross-platform `accessibility` (auditing) skill points INTO this one.

## D3. Structure (5 skills we own + 1 external sibling)
- `ios-simulator` (core: lifecycle, UI lexicon, capture, permissions, web-on-mobile).
- `expo-ios-simulator` (Expo/RN layer: dev client, dev menu, recurring prompts).
- `mobile-accessibility` (shared dependency, D2).
- `ios-simulator-triage` (living failure catalog: build / runtime[app vs expo] / automation; logging
  as per-layer subsections indexed from `logging.md`).
- `ios-simulator-flow-evidence` (extract evidence; conforms to the contract of...).
- `github-proof-presentation` (**external**, authored separately by the user; we do NOT own it, we
  hand it artifacts). Our `flow-evidence` skill conforms to its artifact contract.
- Cross-links, not installs: each skill is atomic (installable alone); arrows are references.

## D4. Mandates
- **Project-agnostic.** Discover everything (booted UDID, bundle id + scheme from `app.config`,
  device scale). Zero app-specific nouns. (A real Expo app was the proving ground, not a reference.)
- **No prior-art dependencies.** We reviewed the field (below) ONLY to find gaps we might be missing,
  then implement them ourselves within our structure. We never tell a user "go install that skill."
- **Atomic but DRY.** Install some, not all. One home per concept. No run-on ball-of-mud skill.

## D5. Prior art reviewed (for gap-mining only, not dependencies)
conorluddy/ios-simulator-skill (accessibility-first philosophy validated D1), joshuayoes &
whitesmith ios-simulator-mcp (idb-wrapping MCPs), XcodeBuildMCP, AXe (cameroncooke, chosen tool),
tristanmanchester/agent-skills, ygrec-app/SimPilot, callstack/agent-device,
chrishayuk/chuk-mcp-ios-simulator, AXe-iOS-CLI. TODO: mine each for capabilities we lack.

## D6. Frontmatter convention (extended-MIDI: conformant core + our extensions)
- **SKILL.md** keeps the standard required fields `name` + `description` (Agent Skills spec:
  https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), then adds our
  extensions `status` (scaffold | stub | draft | complete) and `sources` (list of PRIMARY-source
  URLs; `[]` = unsourced). A standard loader reads name/description and ignores the rest, so we stay
  conformant while carrying more.
- **Reference files** have no standard frontmatter (the spec bundles them as plain markdown), so all
  their frontmatter is extension: `title`, `summary`, `status`, `sources`.
- `sources` is the file's machine-readable provenance index: primary/official docs only, never a
  prior-art skill. An empty `sources` on a non-`stub` file is a defect we can grep for.

## D7. Status lifecycle (frontmatter `status`)
- `scaffold`: empty home, structure only.
- `stub`: placeholder content (a TODO body, empty `sources`).
- `draft`: content composed AND passed the two-reviewer gate (technical writer + the nit),
  but the skill is not yet published. Gate-passed reference files **stay `draft`**.
- `complete`: applied in a **batch at first publish**, when the whole skill ships (and this
  DECISIONS.md is deleted). Reference files graduate `draft` -> `complete` together then.

So a reviewer seeing `status: draft` on a gate-passed file is seeing the intended pre-publish
state, not an oversight. Do not flip individual files to `complete` mid-build; besides being
premature, a metadata-only change would needlessly trip the both-reviewers-every-revision rule.

## Open questions
- **NAS workflow**: target is to offer this on the NAS; the NAS is not mounted on this Mac and is
  not referenced in the repo. Confirm: clone/author on NAS, or author here and mirror?
- Whether the universal a11y trunk eventually promotes into the general `accessibility` skill.
- Maestro vs AXe for cross-platform flow reuse (Android harness uses Maestro). Default: AXe for iOS.
</content>
