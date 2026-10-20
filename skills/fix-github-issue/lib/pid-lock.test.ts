import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquirePidLock } from './pid-lock.ts';

const scratch = mkdtempSync(join(tmpdir(), 'pid-lock-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const MESSAGES = { held: (pid: number) => `held by ${pid}`, lost: 'lost' };
/** A pid no process has: spawned, waited on, gone. */
const deadPid = () => {
  const run = Bun.spawnSync(['true']);
  return run.pid;
};
let n = 0;
const lockPath = () => join(scratch, `lock-${n++}`);

describe('a pid lock', () => {
  it('is taken when free and released by its owner', () => {
    const path = lockPath();
    const release = acquirePidLock(path, MESSAGES);
    expect(readFileSync(path, 'utf8')).toBe(String(process.pid));
    release();
    expect(existsSync(path)).toBe(false);
  });

  it('refuses a lock a live process holds', () => {
    const path = lockPath();
    writeFileSync(path, String(process.pid));
    expect(() => acquirePidLock(path, MESSAGES)).toThrow(`held by ${process.pid}`);
  });

  it('reclaims a lock whose process is dead', () => {
    const path = lockPath();
    writeFileSync(path, String(deadPid()));
    acquirePidLock(path, MESSAGES)();
  });

  it('treats a lock still being written as taken, never as stale', () => {
    const path = lockPath();
    writeFileSync(path, '');
    expect(() => acquirePidLock(path, MESSAGES)).toThrow('lost');
    expect(existsSync(path)).toBe(true);
  });

  it('leaves a stale lock alone while another starter is reclaiming it', () => {
    const path = lockPath();
    const dead = String(deadPid());
    writeFileSync(path, dead);
    mkdirSync(`${path}.reclaim`);
    expect(() => acquirePidLock(path, MESSAGES)).toThrow('lost');
    expect(readFileSync(path, 'utf8')).toBe(dead);
  });

  it('clears a reclaim guard left by a starter that died, so the next start can reclaim', () => {
    const path = lockPath();
    writeFileSync(path, String(deadPid()));
    mkdirSync(`${path}.reclaim`);
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(`${path}.reclaim`, old, old);
    expect(() => acquirePidLock(path, MESSAGES)).toThrow('lost');
    acquirePidLock(path, MESSAGES)();
  });

  it('does not take a lock that a faster reclaimer already holds', () => {
    // The race the guard exists for: this starter saw the dead pid, but by the time it is inside
    // the guard the lock is a live process's. It must refuse, not delete and retake it.
    const path = lockPath();
    writeFileSync(path, String(process.ppid));
    expect(() => acquirePidLock(path, MESSAGES)).toThrow(`held by ${process.ppid}`);
    expect(readFileSync(path, 'utf8')).toBe(String(process.ppid));
  });
});
