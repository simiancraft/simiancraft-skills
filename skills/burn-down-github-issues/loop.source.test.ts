import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'loop.ts'), 'utf8');

describe('--only bounds every pass that can land work', () => {
  it('refreshes descendant membership before every backlog consumer reads the shared set', () => {
    expect(source).toContain('const ONLY = SCOPE.effective;');
    expect(source).toMatch(/function allIssues\(\): Issue\[\] \{\s*const all = allOpenIssues\(ctx\);\s*SCOPE.refresh\(all\);\s*return all;/);
    expect(source.match(/allOpenIssues\(ctx\)/g)).toHaveLength(1);
    expect(source).toContain('only: ONLY,');
    expect(source).toContain('ONLY ? ONLY.has(issue.number)');
    expect(source).toContain('{ allAges: ONLY !== null }');
    expect(source).toContain('await CARVING.sweep(allIssues())');
    expect(source).toContain('await placeBacklog(allIssues())');
  });

  it('restricts startup resumption to the --only issues', () => {
    const call = source.split('\n').find((line) => line.includes('findStranded(ctx,'));
    expect(call).toBeDefined();
    expect(call).toContain('ONLY.has(issue.number)');
  });
});

describe('an unreadable thread at startup', () => {
  it('costs one issue its pass in the loop, never the run', () => {
    expect(source).not.toContain('readTree(ctx, issue.number, io)');
    expect(source).toContain('function threadOf(');
  });
});

describe('resume dispatch owns automatic redrive', () => {
  it('calls redriveIssue only inside resumePull, which the pool uses', () => {
    const start = source.indexOf('async function resumePull(');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n}', start) + 2;
    expect(source.slice(start, end)).toContain('redriveIssue(');
    expect(source.slice(0, start) + source.slice(end)).not.toContain('redriveIssue(');
    expect(source).toMatch(/await pool\(\s*resumable,\s*CONFIG.concurrency,\s*resumePull,/);
  });
});

describe('drivers drain the board before moving on or exiting', () => {
  const fix = readFileSync(join(import.meta.dir, '../fix-github-issue/fix.ts'), 'utf8');
  const carve = readFileSync(join(import.meta.dir, '../carve-github-issue/carve.ts'), 'utf8');
  const writer = readFileSync(join(import.meta.dir, 'lib/board-writer.ts'), 'utf8');

  it('uses the bounded wait in every stop handler', () => {
    expect(writer).toContain('timeoutMs = 10_000');
    expect(source).toMatch(/installStopHandler\(log, async \(\) => \{\s*FLOOR\?\.stop\(\);\s*await waitForBoard\(BOARD\);\s*releaseLock\(\);/);
    expect(fix).toContain('installStopHandler(log, () => waitForBoard(BOARD))');
    expect(carve).toContain('installStopHandler(log, () => waitForBoard(writer))');
    expect(carve.indexOf('let writer: BoardWriter | undefined')).toBeLessThan(carve.indexOf('installStopHandler(log'));
  });

  it('waits without a bound before normal lock release and exit', () => {
    const finish = source.slice(source.indexOf('const finish = async () =>'), source.indexOf('const stopPulse ='));
    expect(finish).toMatch(/await BOARD\?\.settled\(\);\s*releaseLock\(\);/);
    expect(source).toMatch(/process.exitCode = await walkTheFloorOnly\(FLOOR_MODE\);\s*await BOARD\?\.settled\(\);\s*releaseLock\(\);/);
    expect(carve).toMatch(/await writer\?\.settled\(\);\s*process.exit\(result.outcome/);
    expect(fix.trimEnd().endsWith('await BOARD?.settled();')).toBe(true);
  });
});

describe('the work phase takes on what the run made eligible', () => {
  it('works through a refilling pool whose refill is the mid-run admission', () => {
    expect(source).toMatch(/await refillingPool\(\s*first,\s*CONFIG\.concurrency,[\s\S]*?ADMISSION\.admit,/);
    expect(source).not.toMatch(/await pool\(\s*candidates,/);
  });

  it('records the start batch before any lane runs, and reads the same placement and selection', () => {
    const work = source.indexOf('await refillingPool(');
    expect(source.indexOf('ADMISSION.start(')).toBeGreaterThan(0);
    expect(source.indexOf('ADMISSION.start(')).toBeLessThan(work);
    expect(source).toContain('place: () => placeBacklog(allIssues()),');
    expect(source).toContain("select: (placement) => selectCandidates(placement as Placement, { quiet: true }),");
    expect(source).toContain("release = claimLock(ctx, 'appraise.lock');");
  });

  it('asks the refill before calling a run with nothing Ready idle, so children carved during startup sizing are worked', () => {
    const ask = source.indexOf('await ADMISSION.admit();');
    const idle = source.indexOf("log('nothing in Ready;");
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(idle);
  });

  it('counts the start-of-run appraisals in the run budget', () => {
    expect(source).toContain('for (const n of await sizeTheWindow(placement)) ADMISSION.appraised.add(n);');
  });
});
