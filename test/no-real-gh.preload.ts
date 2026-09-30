// Preloaded for every `bun test`: no test may start a real `gh` process. A helper that bypasses the
// fake tracker throws here instead of writing to whatever repository the working directory names.
const originalSync = Bun.spawnSync.bind(Bun);
const originalAsync = Bun.spawn.bind(Bun);
function refuseGh(args: unknown[]) {
  const first = args[0] as { cmd?: string[] } | string[];
  const argv = Array.isArray(first) ? first : first?.cmd;
  if (argv?.[0] && /(^|\/)gh$/.test(argv[0])) throw new Error('a test tried to run a real gh subprocess');
}
Bun.spawnSync = ((...args: unknown[]) => {
  refuseGh(args);
  return (originalSync as (...args: unknown[]) => unknown)(...args);
}) as typeof Bun.spawnSync;
Bun.spawn = ((...args: unknown[]) => {
  refuseGh(args);
  return (originalAsync as (...args: unknown[]) => unknown)(...args);
}) as typeof Bun.spawn;
