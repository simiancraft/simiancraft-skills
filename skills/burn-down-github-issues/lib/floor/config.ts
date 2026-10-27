/**
 * The floor's block of the burndown config: the running environment merges are checked against,
 * the standing walks, and how often to walk. Absent means no floor. See references/floor.md.
 */

import type { HealthPath } from './probe.ts';

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
  /** The running instance the base branch deploys to. */
  baseUrl: string;
  /** Requests the in-process probe makes on every walk. Empty means `/`. */
  healthPaths: HealthPath[];
  /** How long one health request may take before it counts as no response. */
  probeTimeoutMs: number;
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
   * database copy, a scheduled deploy. Inside one a walk still records what it sees but pauses
   * nothing, runs no callback, and files no incident.
   */
  quietWindows: Array<{ start: string; end: string }>;
};

export type Walk = { name: string; paths: string[]; steps: string };

/** What a programmable cadence sees when it picks the wait before the next walk. */
export type FloorState = {
  /** Items with no terminal verdict yet. */
  pending: number;
  /** The last walk found the environment wrong. */
  wrong: boolean;
  /** The line is paused, by the floor or by a person. */
  paused: boolean;
  /** The run's own work is done and the floor is finishing what is pending. */
  draining: boolean;
};

export type FloorConfig = {
  /** Minutes between walks, or a function of the floor's state that returns them. Default 10. */
  every: number | ((state: FloorState) => number);
  /** After the run's own work is done, how long to keep walking until the floor is clear. Default 60. */
  drainMinutes: number;
  environment: Environment;
  walks: Walk[];
  /** Also put merges this loop did not make (a person's, another tool's) on the floor. Default true. */
  forge: boolean;
};

/** What an adopter writes under `floor` in burn-down-github-issues.config.ts. */
export type FloorConfigInput = Partial<Omit<FloorConfig, 'environment'>> & {
  environment: Partial<Environment> & { kind: EnvironmentKind; baseUrl: string };
};

const DEFAULT_ENVIRONMENT: Omit<Environment, 'kind' | 'baseUrl'> = {
  probeTimeoutMs: 10_000,
  healthPaths: [],
  safeEndpoints: [],
  graceMinutes: 15,
  quietWindows: [],
};

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

/**
 * Minutes until the next walk. A cadence function that throws or returns something other than a
 * positive number falls back to `fallback`, so a typo in the config slows the floor down rather
 * than stopping it.
 */
export function nextWalkMinutes(every: FloorConfig['every'], state: FloorState, fallback = 10): number {
  let value: unknown = every;
  if (typeof every === 'function') {
    try {
      value = every(state);
    } catch {
      return fallback;
    }
  }
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A variable name, not a value: upper-case identifier characters only. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** Walk paths match as prefixes or bare suffixes (`matchesPath`); a glob would silently never match. */
export function walkPathFaults(walks: Array<{ name: string; paths: unknown[] }>): string[] {
  const faults: string[] = [];
  for (const walk of walks) {
    for (const path of walk.paths) {
      if (typeof path !== 'string' || /[*?[\]{}]/.test(path)) {
        faults.push(`floor.walks '${walk.name}': path '${String(path)}' is not a prefix or suffix; use one such as 'src/search/' or '.schema.ts', not a glob`);
      }
    }
  }
  return faults;
}

/** The floor block with its defaults applied, and the list of what is wrong with it. */
export function resolveFloor(input: FloorConfigInput): { floor: FloorConfig; faults: string[] } {
  const environment = { ...DEFAULT_ENVIRONMENT, ...(input.environment ?? {}) } as Environment;
  const floor: FloorConfig = { every: input.every ?? 10, drainMinutes: input.drainMinutes ?? 60, environment, walks: input.walks ?? [], forge: input.forge ?? true };
  const faults: string[] = [];
  const positive = (value: unknown) => Number.isInteger(value) && (value as number) > 0;
  if (typeof floor.every !== 'function' && !positive(floor.every)) faults.push('floor.every must be minutes as a positive integer, or a function of the floor state that returns them');
  if (!positive(floor.drainMinutes)) faults.push('floor.drainMinutes must be a positive integer');
  if (typeof floor.forge !== 'boolean') faults.push('floor.forge must be true or false');
  if (!(environment.kind in DRIVER_SKILLS)) faults.push(`floor.environment.kind must be one of ${Object.keys(DRIVER_SKILLS).join(', ')}`);
  if (typeof environment.baseUrl !== 'string' || !/^https?:\/\//.test(environment.baseUrl)) faults.push('floor.environment.baseUrl must be an http(s) URL');
  if (!Array.isArray(environment.healthPaths)) faults.push('floor.environment.healthPaths must be an array');
  if (!Array.isArray(environment.safeEndpoints)) faults.push('floor.environment.safeEndpoints must be an array');
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!Array.isArray(environment.quietWindows) || environment.quietWindows.some((w) => !HHMM.test(w?.start) || !HHMM.test(w?.end))) {
    faults.push('floor.environment.quietWindows must be an array of { start: "HH:MM", end: "HH:MM" } in UTC');
  }
  if (!positive(environment.graceMinutes)) faults.push('floor.environment.graceMinutes must be a positive integer');
  if (!positive(environment.probeTimeoutMs)) faults.push('floor.environment.probeTimeoutMs must be a positive integer');
  if (environment.driverSkill !== undefined && (typeof environment.driverSkill !== 'string' || environment.driverSkill.trim() === '')) {
    faults.push('floor.environment.driverSkill must be a skill name');
  }
  const login = environment.login;
  if (login) {
    for (const key of ['userEnv', 'passwordEnv', 'restrictedUserEnv', 'restrictedPasswordEnv'] as const) {
      const value = login[key];
      if (value !== undefined && !ENV_NAME.test(value)) faults.push(`floor.environment.login.${key} must be an environment variable NAME such as FLOOR_USER, never a value`);
    }
    if (typeof login.url !== 'string' || !login.url) faults.push('floor.environment.login.url must be a URL');
  }
  if (!Array.isArray(floor.walks) || floor.walks.some((w) => !w?.name || !Array.isArray(w.paths) || !w.steps)) {
    faults.push('floor.walks must be an array of { name, paths, steps }');
  } else {
    faults.push(...walkPathFaults(floor.walks));
  }
  return { floor, faults };
}
