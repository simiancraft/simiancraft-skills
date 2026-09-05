/**
 * The fixture engine's process: stands in for a model by copying a prepared answer into the control
 * file the role would have written, then exits 0. `bun fixture-runner.ts <cwd> <answer-file>` with
 * `LOOP_ROLE` naming the seat. Exists so a gate can drive a whole flow to an exact verdict.
 */

import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPRAISAL_FILE, CARVING_FILE, CONFIRMATION_FILE, REVIEW_FILE, VERDICT_FILE } from './control-files.ts';

const FILE_BY_ROLE: Record<string, string> = {
  appraiser: APPRAISAL_FILE,
  confirmer: CONFIRMATION_FILE,
  worker: VERDICT_FILE,
  'worker-revise': VERDICT_FILE,
  reviewer: REVIEW_FILE,
  carver: CARVING_FILE,
};

const [cwd, answer] = process.argv.slice(2);
const role = process.env.LOOP_ROLE ?? '';
const target = FILE_BY_ROLE[role];
if (!cwd || !answer || !target) {
  console.error(`fixture-runner: usage <cwd> <answer-file> with LOOP_ROLE set to one of ${Object.keys(FILE_BY_ROLE).join(', ')} (got '${role}')`);
  process.exit(2);
}
copyFileSync(answer, join(cwd, target));
console.log(`fixture ${role}: ${answer} -> ${target}`);
