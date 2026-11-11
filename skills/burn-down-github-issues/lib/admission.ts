/**
 * Mid-run admission: the work phase's refill. A run's work list used to be fixed when the run
 * started, so anything the run itself made eligible (a dependent whose blocker it merged, a child
 * the knife carved, a trunk's released remainder) waited for the next run. After a lane settles,
 * and once more before the run calls itself idle, the backlog is placed again from the tracker and
 * what is newly Ready joins the run. Placement, holds, claims, blockers, and the size ceiling decide
 * exactly as they do at the start; this module only decides what is new and what the budgets allow.
 */

/** The slice of a placement this module reads: the lane each issue is in, and why. */
export type PlacedIssue = {
  number: number;
  blockedBy?: { nodes: Array<{ number: number; state: string; stateReason?: string | null }> } | null;
};
export type AdmissionPlacement<I extends PlacedIssue> = Map<number, { lane: string; why: string; issue: I }>;

export type AdmissionDeps<I extends PlacedIssue> = {
  /** `--limit`: every issue handed to a worker this run counts, the first batch included. */
  limit: number;
  /** `--appraise-limit`: every issue appraised this run counts. */
  appraiseLimit: number;
  /** False under `--no-appraise`, a dry run, or when the start of the run could not size. */
  canAppraise: () => boolean;
  stopping: () => boolean;
  /** Fetch the base, so appraisers judge, and lanes branch from, what the last merge left. */
  fetchBase: () => void;
  /** Place the backlog from the tracker (the run's `placeBacklog(allIssues())`). */
  place: () => Promise<AdmissionPlacement<I>>;
  /**
   * Appraise the inbox lane, leaving out `skip`, at most `limit` issues; the numbers it appraised,
   * or null when the appraisal lock is held elsewhere and this pass must not size anything.
   */
  appraise: (placement: AdmissionPlacement<I>, skip: (issue: I) => boolean, limit: number) => Promise<number[] | null>;
  /** The run's selection over Ready, in its order, without logging every exclusion again. */
  select: (placement: AdmissionPlacement<I>) => I[];
  log: (line: string) => void;
};

export type Admission<I extends PlacedIssue> = {
  /** Issues handed to a worker this run. */
  readonly dispatched: Set<number>;
  /** Issues appraised this run. */
  readonly appraised: Set<number>;
  /** Records the start-of-run batch, so the refill neither repeats it nor forgets it in the budget. */
  start: (issues: Iterable<number>) => void;
  /** The refill: newly eligible issues, within the budgets, each admitted at most once per run. */
  admit: () => Promise<I[]>;
};

export function createAdmission<I extends PlacedIssue>(deps: AdmissionDeps<I>): Admission<I> {
  const dispatched = new Set<number>();
  const appraised = new Set<number>();
  const reportedStuck = new Set<number>();

  /**
   * A card waiting on a blocker closed without completing never leaves W1 by itself (that branch of
   * `BLOCKER_CLOSED` is not built), so the run says so once instead of leaving it silent.
   */
  const reportStuck = (placement: AdmissionPlacement<I>) => {
    for (const { lane, issue } of placement.values()) {
      if (lane !== 'W1' || reportedStuck.has(issue.number)) continue;
      const blockers = issue.blockedBy?.nodes ?? [];
      if (blockers.length === 0 || blockers.some((b) => b.state !== 'CLOSED')) continue;
      const dead = blockers.filter((b) => b.stateReason !== 'COMPLETED').map((b) => `#${b.number}`);
      if (dead.length === 0) continue;
      reportedStuck.add(issue.number);
      deps.log(`#${issue.number}  waits on ${dead.join(', ')}, closed without completing; a person decides whether it still applies`);
    }
  };

  return {
    dispatched,
    appraised,
    start: (issues) => {
      for (const n of issues) dispatched.add(n);
    },
    admit: async () => {
      if (deps.stopping()) return [];
      const room = deps.limit - dispatched.size;
      if (room <= 0) return [];
      deps.fetchBase();
      let placement = await deps.place();
      reportStuck(placement);
      const budget = deps.appraiseLimit - appraised.size;
      const unsized = [...placement.values()].some(({ lane, issue }) => lane === 'A1' && !appraised.has(issue.number));
      if (unsized && budget > 0 && deps.canAppraise() && !deps.stopping()) {
        const sized = await deps.appraise(placement, (issue) => appraised.has(issue.number), budget);
        if (sized === null) {
          deps.log('the appraisal lock is held elsewhere; cards freed mid-run are sized by the next run');
        } else {
          for (const n of sized) appraised.add(n);
          placement = await deps.place();
        }
      }
      if (deps.stopping()) return [];
      const admitted = deps
        .select(placement)
        .filter((issue) => !dispatched.has(issue.number))
        .slice(0, room);
      for (const issue of admitted) {
        dispatched.add(issue.number);
        deps.log(`#${issue.number}  admitted mid-run: ${placement.get(issue.number)?.why ?? 'Ready'}`);
      }
      return admitted;
    },
  };
}
