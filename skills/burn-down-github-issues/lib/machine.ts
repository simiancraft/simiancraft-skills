/**
 * The burndown as a hierarchical state machine, in the shape XState gives a statechart: compound
 * states for the phases, leaf states for the lanes, events the agents and the tracker raise,
 * guards on the counters and the facts, and named actions (an agent seat to run, a tracker
 * write to make, a card to move). The data is the specification; `machine.test.ts` checks it
 * against the lane table, and `references/state-machine.md` is its prose.
 *
 * Root is parallel: `ticket` walks the lanes, `line` is the operator's switch, and the three
 * seams the loop holds at (appraise, dispatch, merge) are guards on `line` rather than states of
 * the ticket, which is why a pause never moves a card.
 *
 * Targets are absolute dotted paths under the root. `ticket.reconcile` is the transient state the
 * reconcile precedence lives in: every hold removal, claim release, hand move, and run start
 * enters it, and its guarded `always` transitions put the card where the facts say. There is
 * deliberately no history node: re-entering a state runs its entry actions, and most of those
 * start an agent, so a card that left for a wait comes back through reconcile, not to where it was.
 */

export type Transition = {
  target: string;
  /** Name of a guard, as XState names them; the reference explains each. Absent means unconditional. */
  guard?: string;
  /** Names of actions run on the transition, in order. */
  actions?: string[];
};

/** What a leaf state shows as: a stable key code uses, and the name and description the board shows. */
export type LaneSpec = { key: string; name: string; description: string };

export type StateNode = {
  /** The lane this leaf state shows as on the board. Absent on compound, transient, and final states. */
  lane?: LaneSpec;
  type?: 'compound' | 'parallel' | 'history' | 'final' | 'transient';
  /** Actions run on entering the state; an agent seat to run is one of them. */
  entry?: string[];
  exit?: string[];
  initial?: string;
  states?: Record<string, StateNode>;
  /** Event name to one or more guarded transitions, tried in order. */
  on?: Record<string, Transition | Transition[]>;
  /** Eventless transitions, tried in order on entry; XState's `always`. The reconcile state is made of these. */
  always?: Transition[];
};

/**
 * A person's redrive (`fix.ts --redrive`, or the loop finding a lifted hold over a pull request):
 * the hold comes off, the redrive is counted, and the existing pull request is continued rather
 * than a second one opened. No seat begins on a stale lane, so a lane behind the base catches up
 * first; the objection that stopped the work stands as the brief, which is a standing rejection.
 */
const REDRIVE: Transition[] = [
  { target: 'ticket.landing.catchingUp', guard: 'prExists and behindBase', actions: ['countRedrive', 'unlabelHold', 'reclaim', 'prToDraft'] },
  { target: 'ticket.work.sentBack', guard: 'prExists', actions: ['countRedrive', 'unlabelHold', 'reclaim'] },
  { target: 'ticket.reconcile', actions: ['countRedrive', 'unlabelHold'] },
];

/** Transitions every ticket state inherits, tried before its own only for the events named here. */
const TICKET_WIDE: Record<string, Transition | Transition[]> = {
  ISSUE_CLOSED: [
    { target: 'ticket.terminal.merged', guard: 'aMergedPrReferencesIt' },
    { target: 'ticket.terminal.closedWithoutCode' },
  ],
  PR_MERGED: { target: 'ticket.terminal.merged', actions: ['closeIssueWithPointer'] },
  HOLD_ADDED_BY_PERSON: [
    { target: 'ticket.human.needsDecision', guard: 'holdIsNeedsDecision' },
    { target: 'ticket.human.needsHuman', guard: 'holdIsNeedsHuman' },
    { target: 'ticket.human.parked', guard: 'holdIsParked' },
  ],
  SKIPPED: { target: 'ticket.offBoard', actions: ['archiveCard'] },
  FOREIGN_CLAIM: { target: 'ticket.waits.claimedElsewhere' },
  RUN_STARTED: { target: 'ticket.reconcile' },
  HAND_MOVED: { target: 'ticket.reconcile', actions: ['logHandMove'] },
};

export const MACHINE: StateNode = {
  type: 'parallel',
  states: {
    line: {
      initial: 'active',
      states: {
        active: { on: { PAUSE: { target: 'line.paused', actions: ['banner'] } } },
        paused: { on: { GO: { target: 'line.active', actions: ['clearBanner'] } } },
      },
    },

    ticket: {
      initial: 'appraisal',
      on: TICKET_WIDE,
      states: {
        offBoard: { type: 'final' },

        /** The reconcile precedence, top to bottom; GitHub facts beat the lane, the lane beats labels. */
        reconcile: {
          type: 'transient',
          entry: ['readIssue', 'readPullRequests', 'readClaims', 'readRecords', 'readLabels', 'readCard'],
          always: [
              { target: 'ticket.terminal.merged', guard: 'issueClosedByMerge' },
              { target: 'ticket.terminal.closedWithoutCode', guard: 'issueClosed' },
              { target: 'ticket.terminal.merged', guard: 'prMergedIssueOpen', actions: ['closeIssueWithPointer'] },
              { target: 'ticket.human.needsDecision', guard: 'labelNeedsDecision' },
              { target: 'ticket.human.needsHuman', guard: 'labelNeedsHuman' },
              { target: 'ticket.human.parked', guard: 'labelParked' },
              { target: 'ticket.deadLetters.appraisal', guard: 'labelDlqAppraise' },
              { target: 'ticket.deadLetters.carve', guard: 'labelDlqCarve' },
              { target: 'ticket.deadLetters.work', guard: 'labelDlqWork' },
              { target: 'ticket.deadLetters.review', guard: 'labelDlqReview' },
              { target: 'ticket.deadLetters.landing', guard: 'labelDlqLand' },
              { target: 'ticket.waits.pausedByEpic', guard: 'pausedByAncestor' },
              { target: 'ticket.waits.claimedElsewhere', guard: 'foreignClaimLive' },
              { target: 'ticket.carving.spawningChildren', guard: 'ownClaimLive and applyingRecord' },
              { target: 'ticket.carving.revisiting', guard: 'ownClaimLive and trunkFingerprintMoved' },
              { target: 'ticket.carving.carving', guard: 'ownClaimLive and oversizedNoRecord' },
              { target: 'ticket.landing.approved', guard: 'ownClaimLive and readyPr and verdictMerge' },
              { target: 'ticket.review.readyForReview', guard: 'ownClaimLive and readyPr' },
              { target: 'ticket.work.drafted', guard: 'ownClaimLive and draftPr' },
              { target: 'ticket.work.coding', guard: 'ownClaimLive' },
              { target: 'ticket.deadLetters.work', guard: 'deadClaim and draftPr', actions: ['clearClaim'] },
              { target: 'ticket.review.readyForReview', guard: 'deadClaim and readyPr and trustedVerdict', actions: ['reclaim'] },
              // A pull request with nobody driving it (a lifted park, a lifted dead letter, a run
              // that died elsewhere): the card belongs with the work, not back in Ready.
              { target: 'ticket.review.readyForReview', guard: 'readyPr', actions: ['clearClaim'] },
              { target: 'ticket.work.drafted', guard: 'draftPr', actions: ['clearClaim'] },
              { target: 'ticket.carving.spawningChildren', guard: 'applyingRecord', actions: ['clearClaim'] },
              { target: 'ticket.carving.childrenInFlight', guard: 'liveRecord or openChild', actions: ['clearClaim'] },
              { target: 'ticket.carving.rollingUp', guard: 'releasedLabel', actions: ['clearClaim'] },
              { target: 'ticket.waits.blockedBySibling', guard: 'blockerOpen', actions: ['clearClaim'] },
              { target: 'ticket.carving.toCarve', guard: 'sizedOverCeiling', actions: ['clearClaim'] },
              { target: 'ticket.ready.ready', guard: 'sizedWithinCeiling', actions: ['clearClaim'] },
              { target: 'ticket.appraisal.inbox', actions: ['clearClaim'] },
          ],
        },

        appraisal: {
          initial: 'inbox',
          states: {
            inbox: {
              lane: { key: 'A1', name: 'Inbox', description: 'On the board, unsized, not yet looked at' },
              entry: ['moveCard'],
              on: {
                APPRAISER_DISPATCHED: { target: 'ticket.appraisal.appraising', guard: 'lineActive' },
                // fix.ts on one named issue: a person's own dispatch, which skips the sizing pass.
                // The worker's first step is still the appraisal, and its verdict can still be a close.
                PERSON_DISPATCHED: { target: 'ticket.work.coding', guard: 'noOpenPr', actions: ['claim', 'createWorktree'] },
              },
            },
            appraising: {
              lane: { key: 'A2', name: 'Appraising', description: 'An appraiser turn is running' },
              entry: ['moveCard', 'runAppraiser'],
              on: {
                APPRAISED: [
                  { target: 'ticket.appraisal.confirmingClose', guard: 'verdictIsClose' },
                  { target: 'ticket.human.needsDecision', guard: 'verdictNeedsDecision', actions: ['labelHold', 'commentQuestion'] },
                  { target: 'ticket.human.needsHuman', guard: 'verdictNeedsHuman', actions: ['labelHold', 'commentReason'] },
                  { target: 'ticket.carving.toCarve', guard: 'sizedOverCeiling', actions: ['labelSize', 'fireSizeCallback'] },
                  { target: 'ticket.ready.ready', guard: 'sizedWithinCeiling', actions: ['labelSize'] },
                ],
                AGENT_FAILED: [
                  { target: 'ticket.appraisal.inbox', guard: 'appraisalsUnderCap', actions: ['countAppraisal'] },
                  { target: 'ticket.deadLetters.appraisal', actions: ['labelDlq', 'commentReason'] },
                ],
              },
            },
            confirmingClose: {
              lane: { key: 'A3', name: 'Confirming close', description: 'A second engine re-checks the close receipt against the base' },
              entry: ['moveCard', 'runConfirmer'],
              on: {
                CONFIRMED: { target: 'ticket.terminal.closedWithoutCode', actions: ['commentBothReceipts', 'closeIssue'] },
                DISPUTED: { target: 'ticket.human.needsHuman', actions: ['labelHold', 'commentBothOpinions'] },
                AGENT_FAILED: { target: 'ticket.deadLetters.appraisal', actions: ['labelDlq', 'commentReason'] },
              },
            },
          },
        },

        ready: {
          initial: 'ready',
          states: {
            ready: {
              lane: { key: 'B1', name: 'Ready', description: 'Sized within the ceiling, unclaimed, unblocked, no open PR' },
              entry: ['moveCard'],
              on: {
                DISPATCHED: { target: 'ticket.work.coding', guard: 'lineActive and noOpenPr', actions: ['claim', 'createWorktree'] },
                BLOCKER_OPENED: { target: 'ticket.waits.blockedBySibling' },
                PAUSED_BY_TRUNK: { target: 'ticket.waits.pausedByEpic', actions: ['labelPaused'] },
              },
            },
          },
        },

        carving: {
          initial: 'toCarve',
          states: {
            toCarve: {
              lane: { key: 'C1', name: 'To carve', description: 'Sized over the ceiling; waiting for the knife' },
              entry: ['moveCard'],
              on: { KNIFE_DISPATCHED: { target: 'ticket.carving.carving', guard: 'lineActive', actions: ['claimCarving'] } },
            },
            carving: {
              lane: { key: 'C2', name: 'Carving', description: 'The knife is inventorying criteria and cutting along a seam' },
              entry: ['moveCard', 'runCarver'],
              on: {
                CUT_PROPOSED: { target: 'ticket.carving.confirmingCut' },
                KNIFE_VERDICT: [
                  { target: 'ticket.human.needsDecision', guard: 'verdictTooUncertain', actions: ['labelHold', 'commentQuestion', 'liveRecord'] },
                  { target: 'ticket.human.needsHuman', guard: 'verdictIndivisible', actions: ['labelHold', 'commentBothOpinions', 'liveRecord'] },
                ],
                AGENT_FAILED: [
                  { target: 'ticket.carving.toCarve', guard: 'carvesUnderCap', actions: ['countCarve', 'releaseClaim'] },
                  { target: 'ticket.deadLetters.carve', actions: ['labelDlq', 'commentReason', 'releaseClaim'] },
                ],
              },
            },
            confirmingCut: {
              lane: { key: 'C3', name: 'Confirming cut', description: 'A second engine checks cover, severability, ownership, sizes, seam' },
              entry: ['moveCard', 'runCarveConfirmer'],
              on: {
                CUT_CONFIRMED: { target: 'ticket.carving.spawningChildren' },
                CUT_DISPUTED: [
                  { target: 'ticket.carving.carving', guard: 'carveRoundsUnderCap', actions: ['countCarveRound'] },
                  { target: 'ticket.deadLetters.carve', actions: ['labelDlq', 'commentBothOpinions', 'releaseClaim'] },
                ],
                AGENT_FAILED: { target: 'ticket.deadLetters.carve', actions: ['labelDlq', 'commentReason', 'releaseClaim'] },
              },
            },
            spawningChildren: {
              lane: { key: 'C4', name: 'Spawning children', description: 'The cut is applied: children created in delivery order with edges' },
              entry: ['moveCard', 'postApplyingRecord', 'createChildren', 'addEdges', 'adoptReferences', 'postLiveRecord', 'labelTrunk'],
              on: {
                SPAWN_COMPLETE: { target: 'ticket.carving.childrenInFlight', actions: ['releaseClaim', 'admitChildren'] },
                AGENT_FAILED: { target: 'ticket.deadLetters.carve', actions: ['labelDlq', 'commentReason', 'releaseClaim'] },
              },
            },
            childrenInFlight: {
              lane: { key: 'C5', name: 'Epic: children in flight', description: 'The parent is held while its leaves move through their own lanes' },
              entry: ['moveCard'],
              on: {
                FINGERPRINT_CHANGED: { target: 'ticket.carving.revisiting', guard: 'lineActive', actions: ['claimCarving'] },
                ALL_CHILDREN_CLOSED: { target: 'ticket.carving.revisiting', guard: 'lineActive', actions: ['claimCarving'] },
              },
            },
            revisiting: {
              lane: { key: 'C6', name: 'Revisiting', description: 'The knife asks whether the carving is still good' },
              entry: ['moveCard', 'runCarver', 'runCarveConfirmer'],
              on: {
                REVISITED: [
                  { target: 'ticket.carving.childrenInFlight', guard: 'verdictStillGood', actions: ['postLiveRecord', 'countRevisit', 'releaseClaim'] },
                  { target: 'ticket.carving.spawningChildren', guard: 'verdictAmend', actions: ['countGeneration'] },
                  { target: 'ticket.carving.rollingUp', guard: 'verdictExhausted' },
                  { target: 'ticket.human.needsDecision', guard: 'verdictQuestion', actions: ['labelHold', 'commentQuestion', 'pauseTouchedLeaves', 'releaseClaim'] },
                  { target: 'ticket.deadLetters.carve', actions: ['labelDlq', 'commentReason', 'releaseClaim'] },
                ],
                CAP_REACHED: { target: 'ticket.deadLetters.carve', actions: ['labelDlq', 'commentReason', 'releaseClaim'] },
                AGENT_FAILED: [
                  { target: 'ticket.carving.childrenInFlight', guard: 'carvesUnderCap', actions: ['countCarve', 'releaseClaim'] },
                  { target: 'ticket.deadLetters.carve', actions: ['labelDlq', 'commentReason', 'releaseClaim'] },
                ],
              },
            },
            rollingUp: {
              lane: { key: 'C7', name: 'Rolling up', description: 'Children done or cut exhausted; the remainder is being accounted for' },
              entry: ['moveCard', 'commentRollUp', 'postReleasedRecord', 'unlabelTrunk', 'labelReleased'],
              on: {
                ROLLED_UP: [
                  { target: 'ticket.terminal.closedWithoutCode', guard: 'nothingRemains', actions: ['closeIssue'] },
                  { target: 'ticket.appraisal.appraising', actions: ['unlabelSize'] },
                ],
              },
            },
          },
        },

        work: {
          initial: 'coding',
          // The worker's turn is atomic to the driver. Proving and Drafted are the worker's own
          // progress reports from inside that turn; the verdict is the event the driver acts on,
          // from whichever of the four lanes the card was last reported in. A lane's own list is
          // tried first, so the hand-offs below are only the ones a lane does not refine.
          on: {
            WORKER_VERDICT: [
              { target: 'ticket.review.readyForReview', guard: 'verdictFixed and readyPr' },
              { target: 'ticket.deadLetters.work', guard: 'verdictFixed', actions: ['labelDlq', 'commentReason', 'releaseClaim'] },
              { target: 'ticket.appraisal.confirmingClose', guard: 'verdictIsClose' },
              { target: 'ticket.human.needsDecision', guard: 'verdictNeedsDecision', actions: ['labelHold', 'commentQuestion', 'parkPr', 'releaseClaim'] },
              { target: 'ticket.human.needsHuman', guard: 'verdictNeedsHuman', actions: ['labelHold', 'commentReason', 'parkPr', 'releaseClaim'] },
              { target: 'ticket.carving.toCarve', guard: 'verdictOutOfBandOverCeiling', actions: ['labelSize', 'parkPr', 'releaseClaim'] },
            ],
          },
          states: {
            sentBack: {
              lane: { key: 'D4', name: 'Sent back', description: 'Rejected with actionable items; a revision is pending or in progress' },
              entry: ['moveCard', 'prToDraft', 'runWorkerRevision'],
              on: {
                DRAFT_PUSHED: { target: 'ticket.work.drafted' },
                WORKER_VERDICT: [
                  { target: 'ticket.appraisal.confirmingClose', guard: 'verdictIsClose' },
                  { target: 'ticket.human.needsDecision', guard: 'verdictNeedsDecision', actions: ['labelHold', 'commentQuestion', 'parkPr', 'releaseClaim'] },
                  { target: 'ticket.human.needsHuman', guard: 'verdictNeedsHuman', actions: ['labelHold', 'commentReason', 'parkPr', 'releaseClaim'] },
                  { target: 'ticket.carving.toCarve', guard: 'verdictOutOfBandOverCeiling', actions: ['labelSize', 'parkPr', 'releaseClaim'] },
                ],
                AGENT_FAILED: { target: 'ticket.deadLetters.work', actions: ['countAttempt', 'labelDlq', 'commentReason', 'releaseClaim'] },
              },
            },
            coding: {
              lane: { key: 'D1', name: 'Coding', description: 'Claim held; confirming the appraisal, then the smallest change' },
              entry: ['moveCard', 'runWorker'],
              on: {
                WORKER_STARTED_PROOF: { target: 'ticket.work.proving' },
                WORKER_VERDICT: [
                  { target: 'ticket.appraisal.confirmingClose', guard: 'verdictIsClose' },
                  { target: 'ticket.human.needsDecision', guard: 'verdictNeedsDecision', actions: ['labelHold', 'commentQuestion', 'releaseClaim'] },
                  { target: 'ticket.human.needsHuman', guard: 'verdictNeedsHuman', actions: ['labelHold', 'commentReason', 'releaseClaim'] },
                  { target: 'ticket.carving.toCarve', guard: 'verdictOutOfBandOverCeiling', actions: ['labelSize', 'releaseClaim'] },
                ],
                AGENT_FAILED: [
                  { target: 'ticket.ready.ready', guard: 'attemptsUnderCap', actions: ['countAttempt', 'releaseClaim', 'removeWorktree'] },
                  { target: 'ticket.deadLetters.work', actions: ['countAttempt', 'labelDlq', 'commentReason', 'releaseClaim'] },
                ],
              },
            },
            proving: {
              lane: { key: 'D2', name: 'Proving', description: 'Change pushed; acquiring, storing, and rendering proof' },
              entry: ['moveCard'],
              on: {
                DRAFT_OPENED: { target: 'ticket.work.drafted' },
                // A reproof works on a pull request that already exists: the proof is reacquired
                // on the caught-up head and the card goes straight back to review.
                PROOF_REACQUIRED: { target: 'ticket.review.readyForReview', actions: ['prReady'] },
                AGENT_FAILED: { target: 'ticket.deadLetters.work', actions: ['countAttempt', 'labelDlq', 'commentReason', 'releaseClaim'] },
              },
            },
            drafted: {
              lane: { key: 'D3', name: 'Drafted', description: 'A draft PR with proof exists; not yet declared complete' },
              entry: ['moveCard'],
              on: {
                PR_READY: { target: 'ticket.review.readyForReview' },
                RUN_DIED: { target: 'ticket.deadLetters.work', actions: ['labelDlq', 'commentReason'] },
              },
            },
          },
        },

        review: {
          initial: 'readyForReview',
          states: {
            readyForReview: {
              lane: { key: 'E1', name: 'Ready for review', description: 'PR ready; CI running; no reviewer has started' },
              entry: ['moveCard'],
              on: {
                // No review begins on a stale lane.
                REVIEWER_DISPATCHED: [
                  { target: 'ticket.landing.catchingUp', guard: 'behindBase' },
                  { target: 'ticket.review.evidenceUnderReview' },
                ],
              },
            },
            evidenceUnderReview: {
              lane: { key: 'E2', name: 'Evidence under review', description: 'The reviewer reads the receipts, re-runs the checks, judges adequacy' },
              entry: ['moveCard', 'runReviewer'],
              on: {
                REVIEWED: [
                  { target: 'ticket.landing.approved', guard: 'decisionMerge', actions: ['pinReviewedHead'] },
                  { target: 'ticket.work.sentBack', guard: 'reviewRoundsUnderCap', actions: ['spendRound'] },
                  { target: 'ticket.deadLetters.review', actions: ['spendRound', 'labelDlq', 'commentObjection', 'clearRounds', 'releaseClaim'] },
                ],
                AGENT_FAILED: { target: 'ticket.deadLetters.review', actions: ['labelDlq', 'commentReason', 'releaseClaim'] },
                PR_TO_DRAFT: { target: 'ticket.work.drafted' },
              },
            },
          },
        },

        landing: {
          initial: 'approved',
          states: {
            approved: {
              lane: { key: 'F1', name: 'Approved', description: 'Merge verdict pinned to a head; waiting for the front of the queue' },
              entry: ['moveCard', 'enqueue', 'checkBoundary'],
              on: {
                // The boundary is a fact about the change, so it is asked once, before anything waits.
                BOUNDARY_REFUSED: { target: 'ticket.human.parked', actions: ['labelParked', 'parkPr', 'commentReason', 'leaveQueue', 'releaseClaim'] },
                // A lane that moved past the reviewed commit was never judged.
                HEAD_MOVED: { target: 'ticket.review.readyForReview', actions: ['leaveQueue'] },
                // Nothing lands that lacks the current base: behind at all is enough to catch up.
                FRONT_OF_QUEUE: [
                  { target: 'ticket.landing.catchingUp', guard: 'behindBase' },
                  { target: 'ticket.landing.checksPending' },
                ],
              },
            },
            catchingUp: {
              lane: { key: 'F2', name: 'Catching up', description: 'The base moved; merging it in before a revision, a review, or the merge, never rebasing' },
              entry: ['moveCard', 'leaveQueue', 'mergeBaseIntoBranch'],
              on: {
                // The closure decides what the catch-up costs, never whether it happens. Movement
                // outside the work leaves a standing approval or an unreviewed proof intact;
                // movement inside it sends an approval back to review and a proof back to its author.
                CAUGHT_UP: [
                  { target: 'ticket.landing.checksPending', guard: 'standingVerdictMerge and movementOutsideClosure and netChangeIntact', actions: ['pushBranch', 'pinLandingHead'] },
                  { target: 'ticket.review.readyForReview', guard: 'standingVerdictMerge and refreshesUnderCap', actions: ['countRefresh', 'pushBranch'] },
                  { target: 'ticket.work.sentBack', guard: 'standingVerdictRejection', actions: ['pushBranch'] },
                  { target: 'ticket.review.readyForReview', guard: 'noVerdictYet and movementOutsideClosure and netChangeIntact', actions: ['pushBranch'] },
                  // Stale proof is demoted to the closest lane that can correct it: Proving, not a revision.
                  { target: 'ticket.work.proving', guard: 'noVerdictYet and refreshesUnderCap', actions: ['countRefresh', 'pushBranch', 'prToDraft', 'runWorkerReproof'] },
                  { target: 'ticket.deadLetters.landing', actions: ['labelDlq', 'commentReason', 'releaseClaim'] },
                ],
                CONFLICT: { target: 'ticket.deadLetters.landing', actions: ['labelDlq', 'commentReason', 'releaseClaim'] },
              },
            },
            checksPending: {
              lane: { key: 'F3', name: 'Checks pending', description: 'Fresh at the front; waiting on the PR checks' },
              entry: ['moveCard', 'waitOnChecks'],
              on: {
                CHECKS: [
                  { target: 'ticket.landing.smoke', guard: 'checksGreen and smokeConfigured' },
                  { target: 'ticket.landing.merging', guard: 'checksGreen' },
                  { target: 'ticket.deadLetters.landing', actions: ['labelDlq', 'commentReason', 'leaveQueue', 'releaseClaim'] },
                ],
              },
            },
            smoke: {
              lane: { key: 'F4', name: 'Smoke', description: 'The smoke command runs against the exact head that would land' },
              entry: ['moveCard', 'runSmoke'],
              on: {
                SMOKE: [
                  { target: 'ticket.landing.merging', guard: 'smokePassed' },
                  { target: 'ticket.deadLetters.landing', actions: ['labelDlq', 'commentTail', 'leaveQueue', 'releaseClaim'] },
                ],
              },
            },
            merging: {
              lane: { key: 'F5', name: 'Merging', description: 'The line says go; merging the pinned head and confirming' },
              entry: ['moveCard', 'askMayMerge', 'liveGate', 'lookUpstreamOnceMore', 'mergeWithPinnedHead', 'confirmMerged'],
              on: {
                MERGED: { target: 'ticket.terminal.merged', actions: ['closeIssueWithPointer', 'putOnFloor', 'followBase', 'leaveQueue', 'releaseClaim', 'removeWorktree'] },
                ISSUE_CHANGED_UNDER_REVIEW: { target: 'ticket.human.parked', actions: ['labelParked', 'parkPr', 'commentReason', 'leaveQueue', 'releaseClaim'] },
                // Checks, smoke, and a paused line take time; anything that landed meanwhile is caught up first.
                BASE_MOVED_WHILE_WAITING: [
                  { target: 'ticket.landing.catchingUp', guard: 'refreshesUnderCap', actions: ['countRefresh'] },
                  { target: 'ticket.deadLetters.landing', actions: ['labelDlq', 'commentReason', 'leaveQueue', 'releaseClaim'] },
                ],
                MERGE_UNREPORTED: { target: 'ticket.deadLetters.landing', actions: ['cancelQueuedMerge', 'labelDlq', 'commentReason', 'leaveQueue', 'releaseClaim'] },
                LINE_GAVE_UP: { target: 'ticket.deadLetters.landing', actions: ['labelDlq', 'commentReason', 'leaveQueue', 'releaseClaim'] },
              },
            },
          },
        },

        waits: {
          initial: 'blockedBySibling',
          states: {
            blockedBySibling: {
              lane: { key: 'W1', name: 'Blocked by sibling', description: 'A blocked-by edge points at an issue not closed as completed' },
              entry: ['moveCard'],
              on: {
                BLOCKER_CLOSED: [
                  { target: 'ticket.ready.ready', guard: 'blockerCompleted' },
                  { target: 'ticket.reconcile', guard: 'hasOpenParent', actions: ['revisitParent'] },
                  { target: 'ticket.human.needsHuman', actions: ['labelHold', 'commentReason'] },
                ],
              },
            },
            pausedByEpic: {
              lane: { key: 'W2', name: 'Paused by epic', description: 'The trunk has an open question; the pause marker names it' },
              entry: ['moveCard'],
              on: { PAUSE_LIFTED: { target: 'ticket.reconcile', actions: ['unlabelPaused'] } },
            },
            claimedElsewhere: {
              lane: { key: 'W3', name: 'Claimed elsewhere', description: 'Another run holds a live claim on this issue' },
              entry: ['moveCard'],
              on: {
                // Not a history node: re-entering a state runs its entry actions, and most of those
                // start an agent. The facts decide where the card resumes.
                CLAIM_RELEASED: { target: 'ticket.reconcile' },
                CLAIM_EXPIRED: { target: 'ticket.reconcile' },
              },
            },
          },
        },

        deadLetters: {
          initial: 'work',
          states: {
            appraisal: {
              lane: { key: 'Q1', name: 'Appraisal DLQ', description: 'Appraiser or confirmer failed past the cap' },
              entry: ['moveCard', 'runTriage'],
              on: {
                TRIAGED: [
                  { target: 'ticket.appraisal.appraising', guard: 'decisionRetry and redrivesUnderCap', actions: ['countRedrive', 'unlabelDlq', 'applyStrategy'] },
                  { target: 'ticket.human.needsHuman', actions: ['unlabelDlq', 'labelHold', 'commentHistory'] },
                ],
                AGENT_FAILED: { target: 'ticket.human.needsHuman', actions: ['unlabelDlq', 'labelHold', 'commentReason'] },
              },
            },
            carve: {
              lane: { key: 'Q2', name: 'Carve DLQ', description: 'Carve failed, disputed past the cap, or hit a depth, generation, or revisit cap' },
              entry: ['moveCard', 'runTriage'],
              on: {
                TRIAGED: [
                  { target: 'ticket.carving.spawningChildren', guard: 'decisionRetry and redrivesUnderCap and applyingRecord', actions: ['countRedrive', 'unlabelDlq'] },
                  { target: 'ticket.carving.carving', guard: 'decisionRetry and redrivesUnderCap', actions: ['countRedrive', 'unlabelDlq', 'applyStrategy'] },
                  { target: 'ticket.human.needsHuman', actions: ['unlabelDlq', 'labelHold', 'commentBothOpinions'] },
                ],
                AGENT_FAILED: { target: 'ticket.human.needsHuman', actions: ['unlabelDlq', 'labelHold', 'commentReason'] },
              },
            },
            work: {
              lane: { key: 'Q3', name: 'Work DLQ', description: 'Worker failed past the cap, or the run died with undeclared work' },
              entry: ['moveCard', 'runTriage'],
              on: {
                REDRIVEN: REDRIVE,
                TRIAGED: [
                  { target: 'ticket.carving.toCarve', guard: 'decisionOversize', actions: ['unlabelDlq', 'labelSize'] },
                  { target: 'ticket.work.drafted', guard: 'decisionRetry and redrivesUnderCap and draftPr', actions: ['countRedrive', 'unlabelDlq', 'reclaim'] },
                  { target: 'ticket.work.coding', guard: 'decisionRetry and redrivesUnderCap', actions: ['countRedrive', 'unlabelDlq', 'applyStrategy', 'clearAttempts'] },
                  { target: 'ticket.human.parked', guard: 'prExists', actions: ['unlabelDlq', 'labelParked', 'parkPr', 'commentHistory'] },
                  { target: 'ticket.human.needsHuman', actions: ['unlabelDlq', 'labelHold', 'commentHistory'] },
                ],
                AGENT_FAILED: [
                  { target: 'ticket.human.parked', guard: 'prExists', actions: ['unlabelDlq', 'labelParked', 'parkPr', 'commentReason'] },
                  { target: 'ticket.human.needsHuman', actions: ['unlabelDlq', 'labelHold', 'commentReason'] },
                ],
              },
            },
            review: {
              lane: { key: 'Q4', name: 'Review DLQ', description: 'Review rounds exhausted, or no trusted verdict' },
              entry: ['moveCard', 'runTriage'],
              on: {
                REDRIVEN: REDRIVE,
                TRIAGED: [
                  { target: 'ticket.review.readyForReview', guard: 'decisionRerunReviewer and redrivesUnderCap', actions: ['countRedrive', 'unlabelDlq', 'reclaim'] },
                  { target: 'ticket.work.sentBack', guard: 'decisionRetry and redrivesUnderCap', actions: ['countRedrive', 'unlabelDlq', 'applyStrategy', 'reclaim'] },
                  { target: 'ticket.human.needsDecision', guard: 'decisionDesignObjection', actions: ['unlabelDlq', 'labelHold', 'commentQuestion', 'parkPr'] },
                  { target: 'ticket.human.parked', actions: ['unlabelDlq', 'labelParked', 'parkPr', 'commentHistory'] },
                ],
                AGENT_FAILED: { target: 'ticket.human.parked', actions: ['unlabelDlq', 'labelParked', 'parkPr', 'commentReason'] },
              },
            },
            landing: {
              lane: { key: 'Q5', name: 'Landing DLQ', description: 'Conflicts, red checks, smoke failure, refresh cap, or unreported merge' },
              entry: ['moveCard', 'runTriage'],
              on: {
                REDRIVEN: REDRIVE,
                TRIAGED: [
                  { target: 'ticket.landing.catchingUp', guard: 'decisionResolveConflict and redrivesUnderCap', actions: ['countRedrive', 'unlabelDlq', 'reclaim'] },
                  { target: 'ticket.landing.approved', guard: 'decisionRetry and redrivesUnderCap', actions: ['countRedrive', 'unlabelDlq', 'reclaim'] },
                  { target: 'ticket.human.parked', actions: ['unlabelDlq', 'labelParked', 'parkPr', 'commentHistory'] },
                ],
                AGENT_FAILED: { target: 'ticket.human.parked', actions: ['unlabelDlq', 'labelParked', 'parkPr', 'commentReason'] },
              },
            },
          },
        },

        human: {
          initial: 'needsHuman',
          states: {
            needsDecision: {
              lane: { key: 'H1', name: 'Needs decision', description: 'A product or domain ruling nobody has made; the question is on the thread' },
              entry: ['moveCard'],
              on: {
                HOLD_REMOVED: [
                  { target: 'ticket.carving.revisiting', guard: 'isTrunk', actions: ['newEpoch', 'claimCarving'] },
                  { target: 'ticket.appraisal.inbox', actions: ['unlabelSize'] },
                ],
              },
            },
            needsHuman: {
              lane: { key: 'H2', name: 'Needs human', description: 'Access, authority, an engine tie, or a DLQ past its redrive cap' },
              entry: ['moveCard'],
              on: { HOLD_REMOVED: { target: 'ticket.reconcile', actions: ['clearCappedCounter'] } },
            },
            parked: {
              lane: { key: 'H3', name: 'Parked', description: 'A PR exists and a person owns the landing' },
              entry: ['moveCard'],
              on: {
                HOLD_REMOVED: { target: 'ticket.reconcile', actions: ['unparkPr', 'keepPrForReuse'] },
                REDRIVEN: REDRIVE,
                LANDED_BY_HAND: { target: 'ticket.terminal.merged' },
              },
            },
          },
        },

        terminal: {
          initial: 'closedWithoutCode',
          states: {
            merged: {
              lane: { key: 'T1', name: 'Merged', description: 'The PR landed and the issue is closed with a pointer' },
              entry: ['moveCard', 'rollUpToParent'],
              on: {
                WALKED: [
                  { target: 'ticket.terminal.verifiedOnFloor', guard: 'walkPassed' },
                  { target: 'ticket.terminal.merged', actions: ['noteIncident'] },
                ],
                REOPENED: { target: 'ticket.reconcile', actions: ['newEpisode'] },
              },
            },
            closedWithoutCode: {
              lane: { key: 'T2', name: 'Closed without code', description: 'Closed with a re-checkable receipt, or by a person' },
              entry: ['moveCard', 'rollUpToParent'],
              on: { REOPENED: { target: 'ticket.reconcile', actions: ['newEpisode'] } },
            },
            verifiedOnFloor: {
              lane: { key: 'T3', name: 'Verified on the floor', description: 'Merged and found present on the deployed base' },
              entry: ['moveCard'],
              on: { REOPENED: { target: 'ticket.reconcile', actions: ['newEpisode'] } },
            },
          },
        },
      },
    },
  },
};

/** The phase a ticket state path belongs to, from its second segment. */
export const PHASE_OF_STATE: Record<string, Phase> = {
  appraisal: 'appraisal',
  ready: 'ready',
  carving: 'carving',
  work: 'work',
  review: 'review',
  landing: 'landing',
  waits: 'waits',
  deadLetters: 'dead-letters',
  human: 'human',
  terminal: 'terminal',
};

export type Phase =
  | 'appraisal'
  | 'ready'
  | 'carving'
  | 'work'
  | 'review'
  | 'landing'
  | 'waits'
  | 'dead-letters'
  | 'human'
  | 'terminal';

/** Every state path under the root, depth first, with its node. */
export function walk(node: StateNode = MACHINE, path = ''): Array<[string, StateNode]> {
  const out: Array<[string, StateNode]> = [];
  for (const [name, child] of Object.entries(node.states ?? {})) {
    const here = path ? `${path}.${name}` : name;
    out.push([here, child]);
    out.push(...walk(child, here));
  }
  return out;
}

/** Every transition in the machine with the path of the state it leaves and the event that fires it. */
export function transitions(): Array<{ from: string; event: string; transition: Transition }> {
  const out: Array<{ from: string; event: string; transition: Transition }> = [];
  for (const [from, node] of walk()) {
    for (const [event, list] of Object.entries(node.on ?? {})) {
      for (const transition of Array.isArray(list) ? list : [list]) out.push({ from, event, transition });
    }
    for (const transition of node.always ?? []) out.push({ from, event: 'always', transition });
  }
  return out;
}
