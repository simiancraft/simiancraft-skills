/**
 * The run's stop, as every driver installs it: one handler, so no driver stops differently.
 */

import { awaitReleases } from '../../carve-github-issue/lib/claims.ts';
import { shutdownAgents } from './agent.ts';
import { beginStop, RunStopping } from './shell.ts';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * On a signal the run is stopping, from the handler's first statement and before anything is
 * awaited: nothing is dispatched, no agent's exit is an answer, and nothing is written but the
 * release of the run's claims. The agents go down with their process groups, the lanes get a
 * bounded wait to unwind and release, `beforeExit` does the driver's own cleanup (its lock, its
 * walker), and then the process exits. A second signal exits at once and says what it abandons.
 */
export function installStopHandler(log: (message: string) => void, beforeExit: () => Promise<void> | void = () => {}): void {
  // A stop unwinds the lanes by throwing, and a driver that awaits a lane at its top level would
  // die of that throw with exit code 1, ahead of this handler's wait and its own exit. The stop is
  // no error: the handler below makes the exit. Anything else fails the process as it would have.
  const passStop = (error: unknown) => {
    if (error instanceof RunStopping) return;
    // What the runtime would have done with it: say it and fail with exit code 1.
    console.error(error);
    process.exit(1);
  };
  process.on('uncaughtException', passStop);
  process.on('unhandledRejection', passStop);
  let signalled = false;
  for (const signal of SIGNALS) {
    process.on(signal, async () => {
      beginStop();
      const code = signal === 'SIGINT' ? 130 : 143;
      if (signalled) {
        const abandoned = await awaitReleases(0);
        log(`received ${signal} again; exiting now${abandoned.length > 0 ? `, abandoning claim(s) that expire on their own: ${abandoned.join(', ')}` : ''}`);
        process.exit(code);
      }
      signalled = true;
      log(`received ${signal}; the run is stopping: agents are killed, nothing further is written but the release of its claims`);
      // Wait for the agents to actually die before any lock goes: a child that ignores SIGTERM
      // would otherwise keep working, approvals bypassed, under a replacement run's lock.
      const survivors = await shutdownAgents();
      if (survivors > 0) log(`${survivors} agent(s) survived SIGKILL; check ps before starting another run`);
      // The lanes release their own claims as the stop unwinds them; an exit before that skips every finally.
      const abandoned = await awaitReleases();
      if (abandoned.length > 0) log(`exiting with claim(s) still held, which expire on their own: ${abandoned.join(', ')}`);
      await beforeExit();
      process.exit(code);
    });
  }
}
