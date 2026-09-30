# The carving record

The record is the comment the knife posts on a trunk at every step that changes the carving. The newest valid one is authoritative: workers read it before starting a leaf, revisits read it to know what the last carving assumed, and people read the table under it. Everything else on the thread is conversation.

## Grammar

One comment, three parts, in this order:

1. The marker line: `<!-- carve-record gen=N epoch=E state=S -->`, with `S` one of `applying`, `live`, `released`.
2. One fenced `json` block holding the `Record` object verbatim (the shape below).
3. A Markdown table for people, derived from the JSON. Readers parse the JSON only.

A comment is a record only when all three hold: its author is the account the loop runs as, the marker is present, and the JSON parses to the shape and agrees with the marker. A comment failing any of these is logged and treated as not a record. A person cannot forge one by pasting, and the knife's own malformed write is ignored rather than trusted.

## Every marker the collection writes

All are trusted only in a comment (or, for the child marker, an issue body) authored by the loop's account. In a person's text they are ordinary characters. Marker comments by the bot are excluded from the fingerprint, so the knife's own writes never trigger a revisit.

| Marker | Where | Meaning |
|---|---|---|
| `<!-- carve-record gen=N epoch=E state=S -->` | the trunk | a record |
| `<!-- carve-rollup child=N event=E at=T -->` | the trunk | a leaf closed; one per child, event, and close time |
| `<!-- carve-claim kind=K run=R at=T expires=T2 -->` | any issue | a run holds it (`carving` or `working`); the holder renews `expires` in place |
| `<!-- carve-unclaim kind=K run=R -->` | any issue | the claim is released |
| `<!-- carve-handoff verdict=V gen=G -->` | the trunk | the knife handed off; a `json` block carries reason, affected criteria, pause set, both opinions |
| `<!-- appraise-handoff verdict=V -->` | any issue | the appraiser handed off; a `json` block carries the reason |
| `<!-- loop-close verdict=V by=R -->` | any issue | the comment every close posts first; `R` is `appraiser`, `worker`, `knife`, or `reconcile` |
| `<!-- carve-answer issue=N -->` | a spike | the posted answer; never posted twice |
| `<!-- carve parent=N gen=G piece=I -->` | an authored child's body, first line | which trunk, generation, and piece it is |
| `<!-- carve-pause by=N gen=G -->` | a leaf | trunk `N` paused it |
| `<!-- carve-unpause by=N -->` | a leaf | trunk `N` released its pause |

## The JSON shape

```ts
type Record = {
  generation: number;            // 1 for the first carve; every amend is a new one
  epoch: number;                 // 1; +1 each time a person removes a hold from the trunk
  state: 'applying' | 'live' | 'released';
  verdict: string;               // carve, amend, still-good, exhausted, or a hand-off verdict
  reason: string;
  cut: Cut | null;               // the accepted cut; null on a hand-off with no cut
  children: RecordChild[];       // every piece, with its issue number once it exists
  supersedes: Array<{ old: number; replacements: number[]; reason: string }>;
  affected: string[];            // criterion ids a hand-off's question touches
  ledger: Ledger;                // every acceptance criterion of the parent
  revisits: number;              // this generation and epoch
  seen: Fingerprint;             // what the tracker looked like when this was written
  at: string;                    // ISO time
  note?: 'hold-observed';        // a snapshot the sweep wrote while the trunk was held; same state as the record before it
};
```

`RecordChild`: `{ number, piece, kind: 'author' | 'child' | 'reference', link: 'sub-issue' | 'blocker', points, order, orderRung, dependsOn, status, paused, role, title }`. `owner`, `dependsOn`, `waitsOn`, and `replacements` are piece indexes into `children`; `number` is the issue number once it exists (null in an `applying` record for a piece not yet created).

## The ledger

One row per acceptance criterion of the parent: `{ id, text, owner, status, cite?, waitsOn? }`. Ids are stable across generations (`carryIds`: equal or near-equal normalized text keeps its id). Statuses:

| Status | Meaning |
|---|---|
| `open` | not yet done; owned by a piece, or unowned (which only an `amend` may leave) |
| `completed` | its owner closed `COMPLETED` |
| `deferred` | waits on a spike (`waitsOn`); a partial cut lists these |
| `withdrawn` | the thread retracted it (`cite` names the comment); counts as done for exhaustion |
| `orphaned` | its owner closed `NOT_PLANNED`, was superseded and closed, or was deleted; must be re-owned |

Transitions, one row per event:

| Event | Effect |
|---|---|
| a child or reference closed `COMPLETED` | its criteria `completed` |
| closed `NOT_PLANNED`, or deleted | its criteria `orphaned` |
| a completed child reopened | its criteria `open` |
| a superseded child reopened | an unexpected open child; the revisit adopts it or hands off |
| a spike closed | its deferred criteria `open` and unowned; only an `amend` settles them |
| a withdrawing comment removed or edited | the criterion `open` |
| a child's body, title, or comments changed since the record | re-judged by the confirmer at the next revisit |
| supersession | criteria move to the replacement as `open`; `superseded` is a child status, not a criterion status |

`still-good` is invalid while any criterion is `orphaned`, or `deferred` with its spike closed. `exhausted` requires every criterion `completed` or `withdrawn` and no open dependency.

## The fingerprint

What the record saw: the trunk's title, body hash, size, non-loop labels, hold labels, parent, and the people's comments (id and body hash); each child's number, state, reason, title, body hash, labels, blockers, people's comments, and record time; each blocker's number, state, and reason. Arrays are sorted before hashing so two reads of one state compare equal. The sweep compares the current fingerprint with the newest record's `seen` field by field; the first difference names the revisit's trigger. A released record is never compared.

## Readers

- **Workers.** A leaf with a parent reads its parent's newest record, and every ancestor's, before starting: which piece it is, what it may assume has landed (a `layers` relation), what it must not touch (a `shards` relation), and whether it waits on a spike.
- **Revisits.** The knife reads the newest `live` record to answer "is this carving still good", carrying its ledger forward.
- **People.** The table. Nothing in the JSON is needed to understand the state of a trunk.
