import { describe, expect, it } from 'bun:test';
import { issueRefs } from './refs.ts';

const pr = (body: string, headRefName = 'feature/unrelated', title = 'A change') => ({ body, title, headRefName });

describe('issue references hold for every issue number, the first nine included', () => {
  it('reads a single-digit issue in each mode', () => {
    expect(issueRefs([pr('Fixes #7')], 'closing')).toEqual([7]);
    expect(issueRefs([pr('Fixes #7')], 'owning')).toEqual([7]);
    expect(issueRefs([pr('see #7')], 'any')).toEqual([7]);
  });

  it('reads a single-digit issue from the branch the loop names for it', () => {
    expect(issueRefs([pr('', 'fix/null-guard-7')], 'owning')).toEqual([7]);
    expect(issueRefs([pr('', 'fix/null-guard-7')], 'any')).toEqual([7]);
  });

  it('still reads no bare number as a reference', () => {
    expect(issueRefs([pr('1,234 packages, 7 of them new')], 'any')).toEqual([]);
    expect(issueRefs([pr('mentions #7 in passing')], 'owning')).toEqual([]);
  });
});
