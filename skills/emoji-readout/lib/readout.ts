/**
 * The emoji readout as code: a fixed vocabulary of sections in a fixed order, so a driver's status
 * print and an agent's written readout scan the same way. See ../SKILL.md for the rules the shape
 * carries.
 */

export const SECTIONS = {
  landed: { emoji: '✅', label: 'Landed' },
  inFlight: { emoji: '🔄', label: 'In flight' },
  health: { emoji: '🩺', label: 'Health' },
  headsUp: { emoji: '⚠️', label: 'Heads up' },
  waiting: { emoji: '⛔', label: 'Waiting on you' },
} as const;

export type SectionKey = keyof typeof SECTIONS;

/** One bullet, or one bullet with peers nested under it. */
export type Line = string | { text: string; children: string[] };

export type Readout = {
  /** The moment the readout describes; the clock when omitted. */
  at?: Date;
  /** Follows the time in the header: `16:56 CDT · floor walk`. */
  title?: string;
  /** IANA zone for the header; the process's own when omitted. */
  timeZone?: string;
  sections: Partial<Record<SectionKey, Line[]>>;
  /** Renames a section for one producer; the emoji and the order never change. */
  labels?: Partial<Record<SectionKey, string>>;
};

/** `16:56 CDT`: 24-hour local time with the zone's short name. */
export function clock(at = new Date(), timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
    timeZone,
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('hour')}:${part('minute')} ${part('timeZoneName')}`.trim();
}

/** A bullet is one line of text: newlines and runs of space collapse, so a reason cannot break the shape. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function renderLine(line: Line, indent: string): string[] {
  if (typeof line === 'string') return [`${indent}- ${flat(line)}`];
  return [`${indent}- ${flat(line.text)}`, ...line.children.map((child) => `${indent}  - ${flat(child)}`)];
}

export function renderReadout(readout: Readout): string {
  const header = clock(readout.at, readout.timeZone) + (readout.title ? ` · ${flat(readout.title)}` : '');
  const out = [header, ''];
  for (const key of Object.keys(SECTIONS) as SectionKey[]) {
    const lines = readout.sections[key] ?? [];
    const { emoji } = SECTIONS[key];
    const label = readout.labels?.[key] ?? SECTIONS[key].label;
    if (lines.length === 0) {
      if (key === 'waiting') out.push(`- ${emoji} Nothing waiting on you.`);
      continue;
    }
    const only = lines[0];
    if (lines.length === 1 && typeof only === 'string') {
      out.push(`- ${emoji} ${label}: ${flat(only)}`);
      continue;
    }
    out.push(`- ${emoji} ${label}:`);
    for (const line of lines) out.push(...renderLine(line, '  '));
  }
  return out.join('\n');
}
