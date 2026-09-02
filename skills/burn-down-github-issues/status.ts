/**
 * Operator feedback: a board of every issue the run has touched, printed as one emoji line per
 * issue on every change (trigger) and as a whole on a cadence (pulse), so a person or an agent
 * watching the console can tell at a glance what merged, what parked, whether the line is paused,
 * and for how long. On by default; `--silent` turns the pulse and the trigger lines off, and the
 * timestamped driver log is unaffected either way.
 *
 * Line shape: 🎫 #1234  ✅ merged  🟢 active  ⏱ 14:56 3/3/2026  fix(search): return a page
 */

export type Stage =
  | 'appraising'
  | 'sized'
  | 'closed'
  | 'handed-off'
  | 'working'
  | 'merged'
  | 'parked'
  | 'dlq'
  | 'failed'
  | 'out-of-band';

const STAGE_EMOJI: Record<Stage, string> = {
  appraising: '📏',
  sized: '🏷️',
  closed: '🗂️',
  'handed-off': '🙋',
  working: '🔨',
  merged: '✅',
  parked: '🅿️',
  dlq: '☠️',
  failed: '❌',
  'out-of-band': '🌀',
};

type Card = { title: string; stage: Stage; note: string; at: Date };

export type LineState = { state: 'active' | 'paused'; since: Date; reason: string };

let silent = false;
const board = new Map<number, Card>();
let line: LineState = { state: 'active', since: new Date(), reason: '' };
let pulseTimer: ReturnType<typeof setInterval> | null = null;

export function configureStatus(options: { silent: boolean }): void {
  silent = options.silent;
}

/** Board stamps are local wall-clock time, the operator's clock; the driver log stays UTC. */
export function stamp(date = new Date()): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss} ${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

export function elapsed(since: Date, now = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function lineText(now = new Date()): string {
  return line.state === 'paused' ? `⏸️ paused ${elapsed(line.since, now)}` : '🟢 active';
}

function cardText(issue: number, card: Card, now = new Date()): string {
  const title = card.title.length > 60 ? `${card.title.slice(0, 57)}...` : card.title;
  const note = card.note ? `  (${card.note})` : '';
  return `🎫 #${issue}  ${STAGE_EMOJI[card.stage]} ${card.stage}${note}  ${lineText(now)}  ⏱ ${stamp(card.at)}  ${title}`;
}

/** Records where an issue is and prints its line now, unless `--silent`. */
export function mark(issue: number, title: string, stage: Stage, note = ''): void {
  const card: Card = { title, stage, note, at: new Date() };
  board.set(issue, card);
  if (!silent) console.log(cardText(issue, card));
}

/** Records the line state; a change is printed now, unless `--silent`. */
export function setLine(state: 'active' | 'paused', reason = ''): void {
  if (line.state === state) return;
  line = { state, since: new Date(), reason };
  if (!silent) console.log(state === 'paused' ? `⏸️ line paused${reason ? `: ${reason}` : ''}` : `🟢 line active again`);
}

export function lineState(): LineState {
  return line;
}

/** The whole board, printed on the cadence and at the end of a run. */
export function pulse(label = 'pulse'): void {
  if (silent) return;
  const now = new Date();
  const counts = new Map<Stage, number>();
  for (const card of board.values()) counts.set(card.stage, (counts.get(card.stage) ?? 0) + 1);
  const summary = [...counts.entries()].map(([stage, n]) => `${STAGE_EMOJI[stage]} ${n} ${stage}`).join('  ');
  console.log(`\n💓 ${label}  ${lineText(now)}${line.state === 'paused' && line.reason ? ` (${line.reason})` : ''}  ⏱ ${stamp(now)}  ${summary || 'nothing touched yet'}`);
  for (const [issue, card] of [...board.entries()].sort((a, b) => b[1].at.getTime() - a[1].at.getTime())) {
    console.log(`   ${cardText(issue, card, now)}`);
  }
  console.log('');
}

/** Starts the cadence; the timer never keeps the process alive. Returns the stop function. */
export function startPulse(minutes: number): () => void {
  if (silent || pulseTimer) return () => {};
  pulseTimer = setInterval(() => pulse(), minutes * 60 * 1000);
  pulseTimer.unref();
  return () => {
    if (pulseTimer) clearInterval(pulseTimer);
    pulseTimer = null;
  };
}
