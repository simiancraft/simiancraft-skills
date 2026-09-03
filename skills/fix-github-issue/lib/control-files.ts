/**
 * The driver's own scratch files: the names an agent writes its answer into, and the set every
 * dirty-tree judgement has to look through. Kept in their own module because both the engine
 * registry and the agent runner need them, and neither owns the other.
 */

/** Where an agent's final message lands, used as the fallback verdict channel. */
export const LAST_MESSAGE_FILE = 'loop-last-message.txt';
export const VERDICT_FILE = 'loop-verdict.json';
export const APPRAISAL_FILE = 'loop-appraisal.json';
/** The confirmer's answer to an appraiser's close verdict; see the appraise-github-issues skill. */
export const CONFIRMATION_FILE = 'loop-confirmation.json';
export const REVIEW_FILE = 'loop-review.json';
/** The carver's answer; see the carve-github-issue skill. */
export const CARVING_FILE = 'loop-carving.json';

/**
 * The driver's own scratch, written untracked into each worktree root. Every dirty-tree judgement
 * must look through these: they exist in every worktree the moment an agent finishes, so a bare
 * `git status --porcelain` would call every tree dirty and park every issue.
 */
export const CONTROL_FILES = new Set([LAST_MESSAGE_FILE, VERDICT_FILE, APPRAISAL_FILE, CONFIRMATION_FILE, REVIEW_FILE, CARVING_FILE]);
