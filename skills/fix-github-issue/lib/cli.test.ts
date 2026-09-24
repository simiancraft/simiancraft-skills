import { describe, expect, it } from 'bun:test';
import { cliFault } from './cli.ts';

const SPEC = { flags: ['dry-run', 'silent'], options: ['issue', 'limit', 'every'], optionalValue: ['every'] };

describe('the argument guard', () => {
  it('passes what the driver knows, values and all', () => {
    for (const args of [[], ['--dry-run'], ['--issue', '7', '--dry-run'], ['--limit', '-1'], ['--every'], ['--every', '10'], ['--every', '--silent']]) expect(cliFault(args, SPEC)).toBeNull();
  });

  it('refuses a flag it does not know, which is how a typo becomes a real run', () => {
    expect(cliFault(['--dryrun'], SPEC)).toBe("unknown flag '--dryrun'");
    expect(cliFault(['--issue', '7', '--dry-rn'], SPEC)).toBe("unknown flag '--dry-rn'");
    expect(cliFault(['--verbose'], SPEC)).toBe("unknown flag '--verbose'");
  });

  it('refuses an option left without its value, and a word that belongs to nothing', () => {
    expect(cliFault(['--issue'], SPEC)).toBe("'--issue' needs a value");
    expect(cliFault(['--issue', '--dry-run'], SPEC)).toBe("'--issue' needs a value");
    expect(cliFault(['7'], SPEC)).toBe("unexpected argument '7'");
    expect(cliFault(['--dry-run', 'now'], SPEC)).toBe("unexpected argument 'now'");
  });
});
