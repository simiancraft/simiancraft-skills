/**
 * The landing watch: a pull request under watch while it lands. Each poll is one observation of
 * it: the pull request's state, its head, its branches, whether it is a draft, its merge when it has
 * one, and each check on that head with its status and the moment this watch first saw it. Every
 * read of the pull request a landing makes goes through it. A check's first sighting is kept across polls, so how long a
 * check has sat in one place is a fact the watch knows rather than one each poll guesses at.
 *
 * The reader only observes. What an observation means for the landing (wait, refuse, end) is the
 * checks wait's question (`awaitGreenChecks` in `pipeline.ts`).
 */

/** What a check's node reached: a satisfied run, a skip, a cancel, a run still going, or a failure. */
export type CheckStatus = 'passed' | 'skipped' | 'cancelled' | 'pending' | 'failed';

/** One check (a check run or a commit status) as one poll saw it. */
export type CheckObservation = {
  name: string;
  status: CheckStatus;
  /** The tracker's own word for it (`SUCCESS`, `FAILURE`, `QUEUED`, ...), or null when it gave none. */
  verdict: string | null;
  /** A check run the provider has not started: queued or requested, never in progress, and never waiting on a person's approval. */
  queued: boolean;
  /** Who runs it: the workflow, or the host its details link to; `unknown provider` when neither is given. */
  provider: string;
  /** When this watch first saw this check, on the watch's clock. */
  firstSeen: number;
  /** When the run last changed: its completion, else its start, else its first sighting. Orders the runs of one name. */
  at: number;
};

/** The pull request as one poll saw it. */
export type LandingObservation = {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  head: string;
  /** The branch it targets, and its own branch. */
  base: string;
  branch: string;
  draft: boolean;
  /** When it merged, and the commit the merge made on the base; null and empty until it has. */
  mergedAt: string | null;
  mergeCommit: string;
  checks: CheckObservation[];
};

/** A rollup node as `gh pr view --json statusCheckRollup` renders a check run or a commit status. */
export type CheckNode = {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  workflowName?: string;
  startedAt?: string;
  completedAt?: string;
  detailsUrl?: string;
  targetUrl?: string;
};

const PASSED = new Set(['SUCCESS', 'NEUTRAL']);
const RUNNING = new Set(['PENDING', 'EXPECTED', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'REQUESTED']);
/**
 * A check run's statuses before its provider starts it. Not `WAITING`: that run waits on a person
 * (an environment's required reviewer), and no provider queue is stuck behind it.
 */
const NOT_STARTED = new Set(['QUEUED', 'REQUESTED', 'PENDING']);

/**
 * What a node reached. SKIPPED and CANCELLED are neither a pass nor a failure: no verdict was
 * reached. GitHub renders an unfinished check run with conclusion "" (empty string, not null), so a
 * nullish coalesce would read "" as a verdict and fail-close a merely-running check.
 */
export function classify(node: CheckNode): CheckStatus {
  const verdict = node.conclusion || node.state || node.status || null;
  if (verdict === null || RUNNING.has(verdict)) return 'pending';
  if (PASSED.has(verdict)) return 'passed';
  if (verdict === 'SKIPPED') return 'skipped';
  // A cancelled run was superseded or stopped, often by the repository's own concurrency rule when
  // a draft is marked ready; it says nothing about the change, so it is waited out, not refused.
  if (verdict === 'CANCELLED') return 'cancelled';
  return 'failed';
}

const nameOf = (node: CheckNode): string => node.name ?? node.context ?? 'unnamed check';

function providerOf(node: CheckNode): string {
  if (node.workflowName) return node.workflowName;
  const link = node.detailsUrl || node.targetUrl;
  if (link) {
    try {
      return new URL(link).host;
    } catch {
      // not a link; fall through
    }
  }
  return 'unknown provider';
}

/** The argv of one observation's read. */
export const watchArgv = (pr: number): string[] => ['gh', 'pr', 'view', String(pr), '--json', 'statusCheckRollup,headRefOid,state,baseRefName,headRefName,isDraft,mergedAt,mergeCommit'];

/**
 * A watch on one pull request. `observe` reads it once (a read that throws is the caller's to
 * judge: a transport failure is retried there) and returns the observation, with each check's first
 * sighting carried over from earlier polls. A check is the same check from poll to poll by its name
 * and its details link, or by its name and its place among the nodes of that name when it has none.
 */
export function landingWatch(pr: number, io: { read: (argv: string[]) => string; now: () => number }): { observe: () => LandingObservation } {
  const firstSeen = new Map<string, number>();
  return {
    observe: () => {
      const view = JSON.parse(io.read(watchArgv(pr))) as {
        statusCheckRollup: CheckNode[] | null;
        headRefOid: string;
        state?: string;
        baseRefName?: string;
        headRefName?: string;
        isDraft?: boolean;
        mergedAt?: string | null;
        mergeCommit?: { oid?: string } | null;
      };
      const at = io.now();
      const occurrences = new Map<string, number>();
      const checks = (view.statusCheckRollup ?? []).map((node): CheckObservation => {
        const name = nameOf(node);
        const nth = occurrences.get(name) ?? 0;
        occurrences.set(name, nth + 1);
        const key = `${name}\u0000${node.detailsUrl || node.targetUrl || `#${nth}`}`;
        if (!firstSeen.has(key)) firstSeen.set(key, at);
        const stamp = (value: string | undefined) => (value && Number.isFinite(Date.parse(value)) && !value.startsWith('0001') ? Date.parse(value) : null);
        return {
          name,
          status: classify(node),
          verdict: node.conclusion || node.state || node.status || null,
          // Only a check run has a status apart from its verdict; a commit status's `PENDING` cannot
          // tell a queued job from a running one.
          queued: node.status !== undefined && !node.conclusion && NOT_STARTED.has(node.status),
          provider: providerOf(node),
          firstSeen: firstSeen.get(key) as number,
          at: stamp(node.completedAt) ?? stamp(node.startedAt) ?? (firstSeen.get(key) as number),
        };
      });
      const state = view.state === 'MERGED' || view.state === 'CLOSED' ? view.state : 'OPEN';
      return {
        state,
        head: view.headRefOid,
        base: view.baseRefName ?? '',
        branch: view.headRefName ?? '',
        draft: view.isDraft === true,
        mergedAt: view.mergedAt || null,
        mergeCommit: view.mergeCommit?.oid ?? '',
        checks,
      };
    },
  };
}
