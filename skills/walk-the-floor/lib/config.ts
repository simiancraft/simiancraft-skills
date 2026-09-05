/**
 * The walker's config: the repository (shared with the fix pipeline), the environment it walks,
 * the standing walks, and the walker's own knobs. Read from `walk-the-floor.config.ts` at the
 * invoking checkout's root; the walker refuses to start without it.
 */

import { loadProjectConfig, type ProjectConfig } from '../../fix-github-issue/lib/config.ts';
import type { HealthPath } from './liveness.ts';

export type EnvironmentKind = 'web' | 'ios' | 'android';

/**
 * Which driver skill the walk prompt loads for each kind when the config names none. These are
 * the project-agnostic drivers; an environment built on a particular stack sets
 * `environment.driverSkill` to the specialised one (an Expo app names `expo-ios-simulator`).
 */
export const DRIVER_SKILLS: Record<EnvironmentKind, string> = {
  web: 'playwright-harness',
  ios: 'ios-simulator',
  android: 'android-emulator-harness',
};

export type Login = {
  url: string;
  /** Environment variable NAMES. The loader refuses anything that looks like a value. */
  userEnv: string;
  passwordEnv: string;
  restrictedUserEnv?: string;
  restrictedPasswordEnv?: string;
};

export type Environment = {
  kind: EnvironmentKind;
  /** The driver skill the walker loads, when the kind's default is not the right one. */
  driverSkill?: string;
  /** How long one health request may take before it counts as no response. */
  probeTimeoutMs: number;
  /** After a fix for a `down` merges, how long to wait before re-probing the environment. */
  postFixProbeDelaySeconds: number;
  /** The running instance. Absent means no liveness probe and no walks; only classification. */
  baseUrl?: string;
  /** Requests the in-process probe makes on every wake. Empty means `/`. */
  healthPaths: HealthPath[];
  /** Prints the running commit. Optional; without it items inside `graceMinutes` are `unverified`. */
  revisionCommand?: string;
  /** Prints recent logs, read when a walk fails. Optional. */
  logsCommand?: string;
  login?: Login;
  /** Paths the walker may POST to. Default none. */
  safeEndpoints: string[];
  graceMinutes: number;
  /**
   * Daily windows, in UTC `HH:MM`, when the environment is expected to be down or wrong: a nightly
   * database copy, a scheduled deploy. Inside one the walker still records what it sees but runs no
   * callback and files no incident; a `down` there is expected, not evidence.
   */
  quietWindows: Array<{ start: string; end: string }>;
};

export type Walk = { name: string; paths: string[]; steps: string };

export type WalkKnobs = {
  autoMerge: 'always' | 'code-only' | 'never';
  maxReviewRounds: number;
  checksTimeoutMinutes: number;
  smokeTimeoutMinutes: number;
  /** The size ceiling an incident's fix may attempt. */
  maxPoints: number;
  /** The default wake cadence for `--every` with no value. */
  cadenceMinutes: number;
  /** While the environment stays down across wakes, one notification per this many minutes. */
  notifyCooldownMinutes: number;
  /** Receives the on-fail ledger entry on stdin. Optional. */
  notifyCommand?: string;
  environment: Environment;
  walks: Walk[];
  seats: { walker: string; worker: string; reviewer: string };
};

/** What an adopting repository exports from `walk-the-floor.config.ts`. */
export type WalkConfig = Partial<Omit<WalkKnobs, 'environment' | 'seats'>> & {
  project: ProjectConfig;
  environment: Partial<Environment> & { kind: EnvironmentKind };
  /** Any seat left out keeps its default. */
  seats?: Partial<WalkKnobs['seats']>;
};

const DEFAULT_ENVIRONMENT: Environment = {
  kind: 'web',
  probeTimeoutMs: 10_000,
  postFixProbeDelaySeconds: 60,
  healthPaths: [],
  safeEndpoints: [],
  graceMinutes: 15,
  quietWindows: [],
};

export const DEFAULTS: WalkKnobs = {
  autoMerge: 'code-only',
  maxReviewRounds: 3,
  checksTimeoutMinutes: 45,
  smokeTimeoutMinutes: 10,
  maxPoints: 5,
  cadenceMinutes: 10,
  notifyCooldownMinutes: 60,
  environment: DEFAULT_ENVIRONMENT,
  walks: [],
  seats: {
    walker: 'claude:claude-opus-5',
    worker: 'codex:gpt-5.6-sol',
    reviewer: 'claude:claude-opus-5',
  },
};

export const CONFIG_FILE = 'walk-the-floor.config.ts';

/** True when `now` (UTC) falls inside any configured quiet window; windows may cross midnight. */
export function inQuietWindow(windows: Array<{ start: string; end: string }>, now = new Date()): boolean {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return windows.some(({ start, end }) => {
    const a = toMinutes(start);
    const b = toMinutes(end);
    return a <= b ? minutes >= a && minutes <= b : minutes >= a || minutes <= b;
  });
}

/** A variable name, not a value: upper-case identifier characters only. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export async function loadWalkConfig(invokeRoot: string, repoRoot: string): Promise<WalkKnobs & { project: ProjectConfig }> {
  const loaded = await loadProjectConfig<WalkKnobs>({
    invokeRoot,
    repoRoot,
    fileName: CONFIG_FILE,
    defaults: DEFAULTS,
    positiveIntegers: ['maxReviewRounds', 'cadenceMinutes', 'maxPoints', 'notifyCooldownMinutes', 'checksTimeoutMinutes', 'smokeTimeoutMinutes'],
    help: [
      'The walker is shared across repositories; everything true of an environment lives in that file.',
      'Copy the template from references/adopting.md in the walk-the-floor skill and fill it in.',
    ],
  });

  // `environment` arrives whole from the file and replaces the default; merge the two so an
  // adopter that names only a kind and a URL still gets the empty lists and the grace window.
  const environment: Environment = { ...DEFAULT_ENVIRONMENT, ...(loaded.environment ?? {}) };
  const faults: string[] = [];
  if (!(environment.kind in DRIVER_SKILLS)) {
    faults.push(`environment.kind must be one of ${Object.keys(DRIVER_SKILLS).join(', ')}`);
  }
  if (environment.baseUrl !== undefined && !/^https?:\/\//.test(environment.baseUrl)) {
    faults.push('environment.baseUrl must be an http(s) URL');
  }
  if (!Array.isArray(environment.healthPaths)) faults.push('environment.healthPaths must be an array');
  if (!Array.isArray(environment.safeEndpoints)) faults.push('environment.safeEndpoints must be an array');
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!Array.isArray(environment.quietWindows) || environment.quietWindows.some((w) => !HHMM.test(w?.start) || !HHMM.test(w?.end))) {
    faults.push('environment.quietWindows must be an array of { start: "HH:MM", end: "HH:MM" } in UTC');
  }
  if (!Number.isInteger(environment.graceMinutes) || environment.graceMinutes <= 0) {
    faults.push('environment.graceMinutes must be a positive integer');
  }
  if (!Number.isInteger(environment.probeTimeoutMs) || environment.probeTimeoutMs <= 0) {
    faults.push('environment.probeTimeoutMs must be a positive integer');
  }
  if (!Number.isInteger(environment.postFixProbeDelaySeconds) || environment.postFixProbeDelaySeconds < 0) {
    faults.push('environment.postFixProbeDelaySeconds must be a non-negative integer');
  }
  if (environment.driverSkill !== undefined && (typeof environment.driverSkill !== 'string' || environment.driverSkill.trim() === '')) {
    faults.push('environment.driverSkill must be a skill name');
  }
  const login = environment.login;
  if (login) {
    for (const key of ['userEnv', 'passwordEnv', 'restrictedUserEnv', 'restrictedPasswordEnv'] as const) {
      const value = login[key];
      if (value !== undefined && !ENV_NAME.test(value)) {
        faults.push(`environment.login.${key} must be an environment variable NAME such as FLOOR_USER, never a value`);
      }
    }
    if (typeof login.url !== 'string' || !login.url) faults.push('environment.login.url must be a URL');
  }
  if (!Array.isArray(loaded.walks) || loaded.walks.some((w) => !w?.name || !Array.isArray(w.paths) || !w.steps)) {
    faults.push('walks must be an array of { name, paths, steps }');
  }
  if (faults.length > 0) {
    console.error([`config ${CONFIG_FILE} is invalid:`, ...faults.map((f) => `  - ${f}`)].join('\n'));
    process.exit(1);
  }
  return { ...loaded, environment };
}
