/**
 * The fixture engine's process: stands in for a model by copying a prepared answer into the control
 * file the role would have written, then exits 0. `bun fixture-runner.ts <cwd> <answer-file>` with
 * `LOOP_ROLE` naming the seat. Exists so a gate can drive a whole flow to an exact verdict.
 */

import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { APPRAISAL_FILE, CARVING_FILE, CODE_FILE, CONFIRMATION_FILE, PANEL_JUDGMENT_FILE, PANEL_QUESTIONS_FILE, PANEL_REVIEW_FILE, PROOF_FILE, REVIEW_FILE, VERDICT_FILE } from './control-files.ts';

const FILE_BY_ROLE: Record<string, string> = {
  appraiser: APPRAISAL_FILE,
  confirmer: CONFIRMATION_FILE,
  worker: VERDICT_FILE,
  'worker-revise': VERDICT_FILE,
  'worker-reprove': VERDICT_FILE,
  coder: CODE_FILE,
  'coder-revise': CODE_FILE,
  prover: PROOF_FILE,
  reviewer: REVIEW_FILE,
  carver: CARVING_FILE,
  'panel-framer': PANEL_QUESTIONS_FILE,
  panelist: PANEL_REVIEW_FILE,
  'panel-judge': PANEL_JUDGMENT_FILE,
};

const [cwd, answer] = process.argv.slice(2);
const role = process.env.LOOP_ROLE ?? '';
const target = FILE_BY_ROLE[role];
if (!cwd || !answer || !target) {
  console.error(`fixture-runner: usage <cwd> <answer-file> with LOOP_ROLE set to one of ${Object.keys(FILE_BY_ROLE).join(', ')} (got '${role}')`);
  process.exit(2);
}
// One seat can fill two roles in one flow (the worker seat codes, then proves), so a role may have an
// answer of its own beside the seat's: `verdict.coder.json` next to `verdict.json`.
const own = answer.replace(/(\.json)?$/, `.${role}.json`);
const source = existsSync(own) ? own : answer;
copyFileSync(source, join(cwd, target));
console.log(`fixture ${role}: ${source} -> ${target}`);

// A test of the driver's cap: write the answer, then hang, and exit 0 when killed, the way an engine
// that traps SIGTERM does. The answer is on disk by then, which is what must not be trusted.
const linger = Number(process.env.LOOP_FIXTURE_LINGER_MS ?? 0);
if (linger > 0) {
  process.on('SIGTERM', () => process.exit(0));
  await Bun.sleep(linger);
}
