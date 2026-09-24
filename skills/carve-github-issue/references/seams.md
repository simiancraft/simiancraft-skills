# Seams: how an issue is cut

The methodology the carver works by and the confirmer judges by. Written for the carver; a person
reading a carving record will find the words used there defined here.

## 1. Why this ladder differs from the canon

The story-splitting canon (Lawrence's patterns, Cohn's SPIDR, Cockburn's Elephant Carpaccio) writes
cards for people. A person picks up a card and slices it privately, in their head and their
branch, so a card can stay a vertical story and a horizontal cut is called a smell. Here the card
is the unit an agent works, in its own lane, with its own proof. The slice that would have been
private is written down, because nobody is holding it in their head. Horizontal cuts happen either
way; the only question is whether the tracker records them. So this ladder ranks every seam,
including the ones the canon forbids, and gates each with a test the canon never needed to state.

## 2. The ladder

Seven rungs, searched from the top. A cut on any rung is admissible only if every child has one
bounded outcome, its own acceptance and proof, and leaves the base usable after it lands. The
ladder is a search order, not a trump card: a lower rung that passes the gate beats a higher rung
that fails it, and a cut below `domain` must say, for every rung above, why it did not apply.

- **domain.** A boundary between things the product talks about: an entity, a workflow, a rule.
  Applies whenever the issue names more than one such thing. A child is one entity or one rule end
  to end, provable on its own by exercising it. Domain is first because a child cut here is
  provable without reference to its siblings.
- **tier.** A boundary between layers of one thing: schema, persistence, API, view. Applies when
  the issue is one domain object across several layers. A child is one layer with a contract at
  its edge; a stub or a fixture on the far side is how it is proven alone. Tier keeps its rung
  because a client with its own state has a real contract at its boundary with the server; the
  admissibility gate ("each tier child provable on its own") does the work a ban would, and a
  tier cut that cannot pass it is inadmissible, not forbidden.
- **route.** A boundary between entry points: a screen, an endpoint, a command. Applies when one
  change lands in several places a user or a caller reaches. A child is one entry point, proven by
  reaching it.
- **area.** A boundary between parts of the codebase that own their own conventions: a package, a
  service, a module tree. A child is one area's share, proven by that area's checks.
- **file.** One or a few files. Admissible only when the physical boundary also owns one change or
  one reviewable outcome; a file cut that produces a child nobody could accept on its own fails
  the gate.
- **unit.** One function, class, or component. Same gate as file.
- **material.** Interchangeable instances: the same change across N places, N rows, N assets. Last
  because it is blind to what the work means, and right only for width (section 6).

## 3. The axioms

- **Seam order matters more as size grows.** The larger the issue, the more the cut must be
  conceptual; a 21 cut on `file` is almost always the wrong shape.
- **The converse: the smaller the issue, the more freedom to cut mechanistically.** At small sizes
  a mechanistic seam may be the only axiom left, and it is fine.
- **Severability outranks symmetry.** A cut whose children can each land alone beats one whose
  children are equal in size. Symmetry is a tie-breaker, never a reason.
- **The ladder is a search order, not a trump card.** Admissibility decides; rank decides among
  admissible cuts.

## 4. Normalization

Inventory before cutting: every acceptance criterion the parent carries, from the whole thread,
numbered. An issue that is a list of unrelated asks becomes one piece per ask. Then name the pieces
and match each against what exists: the trunk's own tree first (adopt a child, open or closed),
then the backlog, open or closed (reference it; a closed one completes its criteria). Author only
what is missing. Re-read the tree immediately before applying, since it may have moved.

## 5. Floor and ceiling

Too large: still divisible or parallelizable; over the ceiling. Too small: the issue costs more to
write than to do. Operationally, a child without its own acceptance and proof, or under the
scale's smallest rung, is too small; fold it into the piece that exercises it.

## 6. Width

Recognize it: one criterion, many instances (the same migration across twelve tables, the same
label across forty issues). Width is a partition, not a count: a stable, deduplicated manifest of
the instances, each instance in exactly one chunk, the same acceptance per chunk, and shared
tooling owned by one chunk. The mechanistic rungs are the right cut here because the instances
are interchangeable. A width cut is always chunked when it is over the ceiling; its relation is
`shards` and the confirmer judges partition integrity, not cover.

## 7. Shared groundwork

Name it per cut (a migration, a helper, a fixture) and give each item one owner: the earliest
piece that exercises it, or its own piece only when it exposes a stable interface with its own
proof and a named consumer. A groundwork piece nobody consumes is a piece nobody can accept.

## 8. Dependencies and delivery order

Partition by deliverable first, derive order second. A dependent child must still be acceptable on
its own once its prerequisite exists; keep the critical path short. The ordering ladder: hard
dependency; closeness to the source of truth (definitions, schema, types, tables, API objects;
then persistence; then the view); uncertainty and risk; size. "Smallest useful slice first" is a
heuristic that usually lands on the risk rung by accident and must not be applied over a
dependency. Order is a dispatch preference; only an edge is a hard constraint, and an edge is
emitted wherever a later piece cannot land before an earlier one, and nowhere else.

Scoring among admissible cuts, each consulted only when the one before it ties: seam rank,
severability, balance, independence, size within bounds, child count.

## 9. Hand-offs, spikes, and pauses

- `indivisible` is a verdict: we know it cannot be cut at this ceiling. Say which rungs were tried
  and why each failed the gate.
- `too-uncertain` is a pending state: a person has not decided. State the exact question. The two
  are never blurred.
- A technical unknown is neither: it is a `spike` piece whose acceptance is the questions answered
  with evidence, and a `partial` cut lists the criteria deferred until it is answered, so the
  spike plus the deferred list still accounts for the whole parent.
- A question on a trunk pauses exactly the leaves that own the criteria it touches, their
  dependents along recorded edges, and everything under those, transitively; the rest keep
  working. A seam dispute the confirmer would not drop pauses everything, because it is about the
  whole carving.

## 10. Revisits

Every child close is followed by a re-check of the trunk. The ledger classifies every criterion:
`open`, `completed`, `deferred`, `withdrawn`, `orphaned`. `still-good` is invalid while any
criterion is orphaned or deferred on a closed spike. `exhausted` requires every criterion
completed or withdrawn and no open dependency. A better cut found later is a re-carve (`amend`);
children with work started survive it as adopted pieces, and a question answered on the thread
may require a rollback piece for work that landed on the old premise. Generations and revisits are
capped per epoch; past the cap a person decides.

## 11. Non-code pieces

Design, documentation, migrations, and operations are valid pieces when each names a deliverable
and its evidence. An unresolved preference is a hand-off, not a design piece.

## 12. Other people's seams, mapped onto the ladder

- **Lawrence's nine story-splitting patterns** (workflow steps, business rule variations, major
  effort, simple/complex, variations in data, data entry methods, defer performance, operations,
  breaking out a spike) are `domain` and `route` cuts, plus the spike; his two selection rules,
  severability then equal size, are axioms 3 and the scoring order above.
- **Cohn's SPIDR**: paths and rules are `domain` seams, interface is a `tier` or `route` seam,
  data is `material` or `domain`, spike is the technical unknown.
- **Cockburn's Elephant Carpaccio**: why `domain` outranks `tier`; a thin end-to-end slice is
  provable alone where a layer often is not.
- **Parnas (1972)**: a boundary that hides one decision is the admissibility test for the low
  rungs and the independence criterion in scoring.
- **The WBS 100% rule** is the ledger; **8/80** is the floor and ceiling in hours.
- **Google's small-CL guidance** (stacked, per-file, horizontal, vertical): a horizontal cut is
  fine when a stable stub lets each side land alone, which is the `tier` gate.
- **Adzic's hamburger method**: technical steps when no vertical cut exists, which is the ladder
  falling through to the mechanistic rungs.
- **Asthana et al. (2026)**, on decomposing long agentic tasks: validation gates between sub-tasks,
  and retrying only the failed phase, which is the intent-and-repair pattern the driver follows.
