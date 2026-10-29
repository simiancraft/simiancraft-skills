import { describe, expect, it } from 'bun:test';
import { boundaryWaived, landBlocker } from './land.ts';

const BOUNDARY = 'autoMerge is code-only and the change touches code, stored-string';
const at = (minute: number) => `2026-10-28T20:${String(minute).padStart(2, '0')}:00Z`;
const comment = (body: string, minute: number) => ({ body, createdAt: at(minute) });

describe('landBlocker: --land acts only on a park the merge boundary wrote', () => {
  it('lets a boundary park through: its reason is the newest comment before the label', () => {
    expect(landBlocker(['loop/parked', 'size: 5'], [comment('an early note', 1), comment(BOUNDARY, 5)], at(5))).toBeNull();
  });
  it('ignores comments made after the park', () => {
    expect(landBlocker(['loop/parked'], [comment(BOUNDARY, 5), comment('a person asks a question', 9)], at(5))).toBeNull();
  });
  it('refuses a newer park of another kind, whatever older boundary comment exists', () => {
    const thread = [comment(BOUNDARY, 5), comment('The loop reached a fixed verdict but did not close the issue.', 30)];
    expect(landBlocker(['loop/parked'], thread, at(30))).toMatch(/not the merge boundary/);
  });
  it('refuses a boundary park for a missing classification, which the landing would only repeat', () => {
    const unstated = 'autoMerge is code-only and the change touches categories nobody stated';
    expect(landBlocker(['loop/parked'], [comment(unstated, 5)], at(5))).toMatch(/no classification/);
  });
  it('refuses a dead letter, which is --redrive work', () => {
    expect(landBlocker(['loop/parked', 'loop/dlq: landing'], [comment(BOUNDARY, 5)], at(5))).toMatch(/dead letter/);
  });
  it('refuses an issue that is not parked, or whose park has no recorded moment', () => {
    expect(landBlocker(['size: 2'], [comment(BOUNDARY, 5)], at(5))).toMatch(/not parked/);
    expect(landBlocker(['loop/parked'], [comment(BOUNDARY, 5)], null)).toMatch(/no record/);
  });
});

describe('boundaryWaived: the waiver is narrow', () => {
  it('waives for the issue a person named, with a classification', () => {
    expect(boundaryWaived(12, 12, ['code', 'stored-string'])).toBe(true);
  });
  it('never for another issue, or when no one asked', () => {
    expect(boundaryWaived(12, 13, ['code'])).toBe(false);
    expect(boundaryWaived(undefined, 12, ['code'])).toBe(false);
  });
  it('never for a missing classification, which still fails closed', () => {
    expect(boundaryWaived(12, 12, null)).toBe(false);
    expect(boundaryWaived(12, 12, undefined)).toBe(false);
    expect(boundaryWaived(12, 12, [])).toBe(false);
  });
});
