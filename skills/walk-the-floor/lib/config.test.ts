import { describe, expect, it } from 'bun:test';
import { walkPathFaults } from './config.ts';

describe('standing-walk paths', () => {
  it('accept a prefix and a bare suffix', () => {
    expect(walkPathFaults([{ name: 'search', paths: ['src/search/', '.schema.ts'] }])).toEqual([]);
  });
  it('refuse a glob, which the matcher would never match', () => {
    expect(walkPathFaults([{ name: 'ui', paths: ['src/**/*.tsx'] }])).toHaveLength(1);
  });
});
