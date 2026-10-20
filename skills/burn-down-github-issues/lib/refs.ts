/**
 * The issue numbers a set of pull requests reference: by `#1234` in title or body or `-1234` in
 * the branch (`any`), or only by a closing keyword before the number at the start of a line or a
 * sentence (`closing`), which is what makes a merge a resolution rather than a mention. Lexical:
 * a sentence that starts with the keyword counts, one that starts with "not" or "does not" does not.
 */
export function issueRefs(prs: Array<{ body: string; title: string; headRefName: string }>, mode: 'any' | 'closing' | 'owning' = 'any'): number[] {
  const refs: number[] = [];
  const CLOSING = /^(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d{1,6})\b/i;
  const OWNING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s+#(\d{1,6})\b/gi;
  for (const pr of prs) {
    if (mode === 'owning') {
      // A pull request owns an issue when its branch names it or its body references it with a
      // keyword. A passing `#1234` in another change's body is a mention, not a claim: one such
      // mention kept a sized issue out of selection for a whole run.
      for (const match of `${pr.title}\n${pr.body}`.matchAll(OWNING)) refs.push(Number(match[1]));
      for (const match of pr.headRefName.matchAll(/(?:^|[/_-])(\d{1,6})(?=$|[/_-])/g)) refs.push(Number(match[1]));
      continue;
    }
    if (mode === 'closing') {
      for (const sentence of `${pr.title}\n${pr.body}`.split(/\r?\n|[.!?]\s+/)) {
        const match = CLOSING.exec(sentence.trim());
        if (match) refs.push(Number(match[1]));
      }
      continue;
    }
    for (const match of `${pr.title}\n${pr.body}`.matchAll(/#(\d{1,6})\b/g)) {
      refs.push(Number(match[1]));
    }
    // A branch name is structured, so a number standing alone between separators is a reference:
    // `fix/1234-null-guard` and `feat/1240-export-button` both name their issue.
    for (const match of pr.headRefName.matchAll(/(?:^|[/_-])(\d{1,6})(?=$|[/_-])/g)) {
      refs.push(Number(match[1]));
    }
  }
  return refs;
}
