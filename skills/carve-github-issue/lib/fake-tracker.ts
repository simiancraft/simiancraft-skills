/**
 * An in-memory tracker for tests: an issue table the fake reads like GitHub and writes like the
 * knife, by interpreting the `gh` argv every mutation would have run. A test can make one write
 * throw, or interleave a second runner, and read the whole write log back.
 */

import { hashText, type Node, type TrackerIo, type TrackerWrite } from './tree.ts';
import { latestRecord } from './tree.ts';
import type { Issue } from '../../fix-github-issue/lib/pipeline.ts';

export type FakeIssue = Omit<Node, 'bodyHash' | 'record'> & { parentNumber: number | null };

let nextComment = 1000;

export function fakeIssue(number: number, partial: Partial<FakeIssue> = {}): FakeIssue {
  return {
    number,
    title: `issue ${number}`,
    createdAt: '2026-09-01T00:00:00Z',
    labels: [],
    author: 'person',
    body: '',
    state: 'OPEN',
    stateReason: null,
    closedAt: null,
    subIssues: [],
    comments: [],
    parentNumber: null,
    ...partial,
  };
}

export class FakeTracker implements TrackerIo {
  readonly issues = new Map<number, FakeIssue>();
  readonly writes: TrackerWrite[] = [];
  /** A write whose description matches throws once; the knife must leave a finishable state. */
  throwOn: RegExp | null = null;
  /** Called before every write; a test can interleave another runner's writes here. */
  beforeWrite: ((op: TrackerWrite) => void) | null = null;
  private nextNumber: number;

  constructor(
    readonly botLogin: string,
    issues: FakeIssue[] = [],
    public now = '2026-09-03T12:00:00Z',
  ) {
    for (const issue of issues) this.issues.set(issue.number, issue);
    this.nextNumber = Math.max(0, ...issues.map((i) => i.number)) + 1;
  }

  view(n: number): Node | null {
    const issue = this.issues.get(n);
    if (!issue) return null;
    const { parentNumber, ...rest } = issue;
    const node: Node = {
      ...rest,
      labels: issue.labels.map((l) => ({ ...l })),
      comments: issue.comments.map((c) => ({ ...c })),
      subIssues: [...issue.subIssues],
      parent: parentNumber === null ? null : { number: parentNumber },
      subIssuesSummary: {
        total: issue.subIssues.length,
        completed: issue.subIssues.filter((c) => this.issues.get(c)?.state === 'CLOSED').length,
      },
      blockedBy: {
        nodes: (issue.blockedBy?.nodes ?? []).map((b) => {
          const target = this.issues.get(b.number);
          return { number: b.number, state: target?.state ?? 'DELETED', stateReason: target?.stateReason ?? null };
        }),
      },
      bodyHash: hashText(issue.body),
      record: null,
    };
    node.record = latestRecord(node, this.botLogin);
    return node;
  }

  search(q: string): Issue[] {
    const words = q
      .replace(/\b(is|in|label|state|repo):\S+/g, '')
      .replace(/"/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.toLowerCase());
    return [...this.issues.values()]
      .filter((i) => words.every((w) => `${i.title} ${i.body}`.toLowerCase().includes(w)))
      .map((i) => ({
        number: i.number,
        title: i.title,
        createdAt: i.createdAt,
        labels: i.labels,
        parent: i.parentNumber === null ? null : { number: i.parentNumber },
        subIssuesSummary: { total: i.subIssues.length, completed: 0 },
        blockedBy: { nodes: i.blockedBy?.nodes ?? [] },
      }));
  }

  /** Posts a comment as `author`, the way a person or another run would. Returns the databaseId. */
  comment(n: number, author: string, body: string, createdAt = this.now): number {
    const issue = this.must(n);
    const databaseId = nextComment++;
    issue.comments.push({ id: `IC_${databaseId}`, databaseId, author, body, createdAt });
    return databaseId;
  }

  addLabel(n: number, name: string): void {
    const issue = this.must(n);
    if (!issue.labels.some((l) => l.name === name)) issue.labels.push({ name });
  }

  removeLabel(n: number, name: string): void {
    const issue = this.must(n);
    issue.labels = issue.labels.filter((l) => l.name !== name);
  }

  close(n: number, reason: 'completed' | 'not planned' = 'completed'): void {
    const issue = this.must(n);
    issue.state = 'CLOSED';
    issue.stateReason = reason === 'completed' ? 'COMPLETED' : 'NOT_PLANNED';
    issue.closedAt = this.now;
  }

  reopen(n: number): void {
    const issue = this.must(n);
    issue.state = 'OPEN';
    issue.stateReason = null;
    issue.closedAt = null;
  }

  /** Interprets the argv a mutation would have run against gh. Unknown shapes throw, so a test sees them. */
  write(op: TrackerWrite): void {
    this.beforeWrite?.(op);
    if (this.throwOn?.test(op.description)) {
      this.throwOn = null;
      throw new Error(`fake tracker: injected failure on "${op.description}"`);
    }
    this.writes.push(op);
    const [gh, sub, verb, ...rest] = op.argv;
    if (gh !== 'gh') throw new Error(`fake tracker: not a gh command: ${op.argv.join(' ')}`);
    const flag = (name: string): string | undefined => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const flags = (name: string): string[] => rest.flatMap((v, i) => (v === name ? [rest[i + 1]] : []));
    if (sub === 'issue' && verb === 'comment') {
      this.comment(Number(rest[0]), this.botLogin, flag('--body') ?? '');
      return;
    }
    if (sub === 'issue' && verb === 'edit') {
      const n = Number(rest[0]);
      for (const name of flags('--add-label')) this.addLabel(n, name);
      for (const name of flags('--remove-label')) this.removeLabel(n, name);
      const parent = flag('--parent');
      if (parent !== undefined) this.attach(Number(parent), n);
      for (const b of flags('--add-blocked-by')) this.must(n).blockedBy = { nodes: [...(this.must(n).blockedBy?.nodes ?? []), { number: Number(b), state: 'OPEN', stateReason: null }] };
      for (const b of flags('--remove-blocked-by')) this.must(n).blockedBy = { nodes: (this.must(n).blockedBy?.nodes ?? []).filter((x) => x.number !== Number(b)) };
      const body = flag('--body');
      if (body !== undefined) this.must(n).body = body;
      const title = flag('--title');
      if (title !== undefined) this.must(n).title = title;
      return;
    }
    if (sub === 'issue' && verb === 'close') {
      this.close(Number(rest[0]), flag('--reason') === 'not planned' ? 'not planned' : 'completed');
      return;
    }
    if (sub === 'issue' && verb === 'reopen') {
      this.reopen(Number(rest[0]));
      return;
    }
    if (sub === 'issue' && verb === 'create') {
      const number = this.nextNumber++;
      const issue = fakeIssue(number, { title: flag('--title') ?? '', body: flag('--body') ?? '', author: this.botLogin, createdAt: this.now });
      for (const name of flags('--label')) issue.labels.push({ name });
      this.issues.set(number, issue);
      const parent = flag('--parent');
      if (parent !== undefined) this.attach(Number(parent), number);
      return;
    }
    if (sub === 'api') {
      // comment edits: gh api -X PATCH repos/{r}/issues/comments/<id> -f body=...
      const path = op.argv.find((a) => a.includes('/issues/comments/'));
      const bodyArg = op.argv.find((a) => a.startsWith('body='));
      if (path && bodyArg) {
        const id = Number(path.split('/').pop());
        for (const issue of this.issues.values()) {
          const c = issue.comments.find((x) => x.databaseId === id);
          if (c) c.body = bodyArg.slice('body='.length);
        }
        return;
      }
    }
    if (sub === 'label') return;
    throw new Error(`fake tracker: unhandled write ${op.argv.join(' ')}`);
  }

  /** The number of the issue the last `gh issue create` made; the knife reads it from the URL gh prints. */
  lastCreated(): number {
    return this.nextNumber - 1;
  }

  create(op: TrackerWrite): number {
    this.write(op);
    return this.lastCreated();
  }

  attach(parent: number, child: number): void {
    const p = this.must(parent);
    if (!p.subIssues.includes(child)) p.subIssues.push(child);
    this.must(child).parentNumber = parent;
  }

  private must(n: number): FakeIssue {
    const issue = this.issues.get(n);
    if (!issue) throw new Error(`fake tracker: no issue #${n}`);
    return issue;
  }
}
