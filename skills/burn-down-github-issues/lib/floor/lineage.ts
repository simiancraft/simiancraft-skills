/**
 * Where a merge's issue sits in a carved trunk: the issue itself, whose body holds the acceptance
 * the merge is judged against, and the trunk's other children that are still open. A carved child
 * promises its own slice of the trunk's outcome; an effect that an open sibling owns is that
 * sibling's work still to come, not a failure of the child that merged.
 */

import type { Context } from '../../../fix-github-issue/lib/context.ts';
import { sh } from '../../../fix-github-issue/lib/shell.ts';

export type IssueText = { number: number; title: string; body: string };
export type Lineage = { issue: IssueText; trunk: { number: number; title: string } | null; openSiblings: IssueText[] };
/** The lineage of an issue, or null when it cannot be read. */
export type LineageOf = (issue: number) => Lineage | null;

/** How much of an issue body goes into a prompt; acceptance criteria sit near the top. */
const BODY_LIMIT = 3000;
const SIBLING_BODY_LIMIT = 1200;

type RawIssue = { number: number; title: string; body?: string; state?: string; parent?: { number: number; title?: string } | null; subIssues?: { nodes: Array<{ number: number }> } | Array<{ number: number }> };

/** Reads an issue, its trunk, and the trunk's open children from the forge. */
export function ghLineage(ctx: Context): LineageOf {
  const view = (n: number, fields: string) => JSON.parse(sh(ctx, ['gh', 'issue', 'view', String(n), '--json', fields])) as RawIssue;
  return (number) => {
    const own = view(number, 'number,title,body,parent');
    const issue = { number: own.number, title: own.title, body: own.body ?? '' };
    if (!own.parent) return { issue, trunk: null, openSiblings: [] };
    const trunk = view(own.parent.number, 'number,title,subIssues');
    const children = Array.isArray(trunk.subIssues) ? trunk.subIssues : (trunk.subIssues?.nodes ?? []);
    const openSiblings: IssueText[] = [];
    for (const child of children) {
      if (child.number === number) continue;
      const sibling = view(child.number, 'number,title,body,state');
      if (sibling.state === 'OPEN') openSiblings.push({ number: sibling.number, title: sibling.title, body: sibling.body ?? '' });
    }
    return { issue, trunk: { number: trunk.number, title: trunk.title }, openSiblings };
  };
}

/** The open sibling a verdict names, or null when it names none or one that is not open under the trunk. */
export function owedTo(lineage: Lineage | null, sibling: unknown): IssueText | null {
  if (!lineage || typeof sibling !== 'number') return null;
  return lineage.openSiblings.find((s) => s.number === sibling) ?? null;
}

function excerpt(body: string, limit: number): string {
  const text = body.trim();
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text || '(empty)';
}

const quote = (text: string, indent: string) => text.split('\n').map((line) => `${indent}> ${line}`).join('\n');

/** The lineage as prompt text, each line prefixed with `indent`. */
export function renderLineage(lineage: Lineage, indent = ''): string {
  const lines = [`${indent}closes issue #${lineage.issue.number} (${lineage.issue.title}); its acceptance, which is what this item promised:`, quote(excerpt(lineage.issue.body, BODY_LIMIT), indent)];
  if (lineage.trunk) {
    lines.push(`${indent}carved from trunk #${lineage.trunk.number} (${lineage.trunk.title}); open siblings under it:${lineage.openSiblings.length === 0 ? ' none' : ''}`);
    for (const sibling of lineage.openSiblings) lines.push(`${indent}- #${sibling.number} ${sibling.title}`, quote(excerpt(sibling.body, SIBLING_BODY_LIMIT), `${indent}  `));
  }
  return lines.join('\n');
}
