/**
 * The argument guard every driver runs before anything else. A driver that ignores what it does
 * not recognise runs its default, and a driver's default is a real run: `--help`, or a typo such as
 * `--dryrun`, would start work on a repository the operator only meant to ask about.
 */

export type CliSpec = {
  /** Switches that take no value. */
  flags: readonly string[];
  /** Options that take a value. */
  options: readonly string[];
  /** Options whose value may be left out (`--every`, which then takes the config's). */
  optionalValue?: readonly string[];
};

/** What is wrong with an argument list, or null. Nothing here is guessed at: an unknown word is a fault, never a default. */
export function cliFault(args: readonly string[], spec: CliSpec): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) return `unexpected argument '${arg}'`;
    const name = arg.slice(2);
    if (spec.flags.includes(name)) continue;
    if (!spec.options.includes(name)) return `unknown flag '${arg}'`;
    const value = args[i + 1];
    const missing = value === undefined || value.startsWith('--');
    if (missing && !spec.optionalValue?.includes(name)) return `'${arg}' needs a value`;
    if (!missing) i++;
  }
  return null;
}

/**
 * Runs first in a driver. `--help` or `-h` anywhere prints the usage and exits 0; a fault prints
 * itself and the usage and exits 2. Either way the driver has loaded no config, taken no lock,
 * and touched no tracker.
 */
export function guardCli(args: readonly string[], spec: CliSpec, usage: string): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    process.exit(0);
  }
  const fault = cliFault(args, spec);
  if (fault) {
    console.error(`${fault}\n\n${usage}`);
    process.exit(2);
  }
}
