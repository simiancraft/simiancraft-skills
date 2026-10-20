/**
 * Prompt rendering for the walker's own prompts. The fix pipeline's renderer supplies the project
 * vocabulary; this adds nothing but the search path, so the two skills' prompts never collide.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPrompt } from '../../fix-github-issue/lib/agent.ts';
import type { Context } from '../../fix-github-issue/lib/context.ts';

export const WALKER_PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

export function renderWalkerPrompt(ctx: Context, file: string, vars: Record<string, string>): string {
  return renderPrompt({ ...ctx, promptsDirs: [WALKER_PROMPTS, ...ctx.promptsDirs] }, file, vars);
}
