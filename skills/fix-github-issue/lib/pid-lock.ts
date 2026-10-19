/**
 * A lock file holding a pid, taken by exclusive create and reclaimed when its pid is dead.
 *
 * Reclaiming is the racy part: two starters can both read the same dead pid, and the slower one
 * would then delete the faster one's fresh lock and take it as well. So a reclaim happens only
 * under a guard directory (mkdir is atomic), and the holder is read again inside it.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

/** A guard older than this was left by a starter that died mid-reclaim. */
const STALE_GUARD_MS = 60_000;

export type PidLockMessages = {
  /** The lock is held by a live process. */
  held: (pid: number) => string;
  /** Another starter won a race for it. */
  lost: string;
};

/** The live pid in the lock; 0 while a starter has created the file and not yet written it; null when free to reclaim. */
function holderOf(path: string): number | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
  if (text === '') return 0;
  const pid = Number(text);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export function acquirePidLock(path: string, messages: PidLockMessages, log: (m: string) => void = () => {}): () => void {
  const mine = String(process.pid);
  try {
    writeFileSync(path, mine, { flag: 'wx' });
  } catch {
    const guard = `${path}.reclaim`;
    try {
      mkdirSync(guard);
    } catch {
      try {
        if (Date.now() - statSync(guard).mtimeMs > STALE_GUARD_MS) rmSync(guard, { recursive: true, force: true });
      } catch {
        // gone already
      }
      throw new Error(messages.lost);
    }
    try {
      const holder = holderOf(path);
      if (holder === 0) throw new Error(messages.lost);
      if (holder !== null) throw new Error(messages.held(holder));
      log('clearing a stale lock from a dead process');
      rmSync(path, { force: true });
      try {
        writeFileSync(path, mine, { flag: 'wx' });
      } catch {
        throw new Error(messages.lost);
      }
    } finally {
      rmSync(guard, { recursive: true, force: true });
    }
  }
  if (readFileSync(path, 'utf8').trim() !== mine) throw new Error(messages.lost);

  // Release only a lock this process still owns; deleting unconditionally could take out the lock
  // a competing starter just legitimately claimed.
  return () => {
    try {
      if (readFileSync(path, 'utf8').trim() === mine) rmSync(path, { force: true });
    } catch {
      // already gone
    }
  };
}
