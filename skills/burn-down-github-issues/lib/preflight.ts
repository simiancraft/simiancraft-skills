import type { Context } from '../../fix-github-issue/lib/context.ts';
import { requiredStatusChecks } from '../../fix-github-issue/lib/pipeline.ts';
import { sh } from '../../fix-github-issue/lib/shell.ts';

/** Read-only landing preparation, independent of whether the backlog has any work. */
export function reportPreflight(
  ctx: Context,
  io: { read: (argv: string[]) => string; say: (message: string) => void } = {
    read: (argv) => sh(ctx, argv, ctx.repoRoot, 1),
    say: ctx.log,
  },
): void {
  const required = [...new Set([...(ctx.knobs.requiredChecks ?? []), ...requiredStatusChecks(ctx, io.read)])];
  io.say(`Preflight: ${ctx.project.repo} base ${ctx.project.baseBranch}, checks: '${ctx.knobs.checks}'`);
  io.say(`Required landing check names (requiredChecks + base protection): ${JSON.stringify(required)}`);
  if (ctx.knobs.checks === 'none') {
    io.say("checks: 'none': the landing check gate is disabled.");
  } else if (required.length === 0) {
    io.say(`WARNING: the required landing check list is empty. Configure requiredChecks or required status checks on base ${ctx.project.baseBranch} before the first real run. Repositories intentionally running no checks can set checks: 'none'.`);
  }
}
