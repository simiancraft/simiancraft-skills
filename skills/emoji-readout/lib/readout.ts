/**
 * The emoji readout as code: a header with the clock time and how long the work has run, the
 * producer's own sections in the order it gives them, and last, ⛔ for whatever needs the reader or
 * 🟢 when nothing does. See ../SKILL.md for what goes in.
 */

/** One bullet, or one bullet with peers nested under it. */
export type Line = string | { text: string; children: string[] };

/** A section is an emoji, an optional label, and its lines; one with no lines is dropped. */
export type Section = { emoji: string; label?: string; lines: Line[] };

export type Readout = {
  /** The moment the readout describes; the clock when omitted. */
  at?: Date;
  /** When the work started; the header says how long it has been running. */
  since: Date;
  /** Follows the time in the header: `16:56 CDT · 1h 12m in · floor walk`. */
  title?: string;
  /** IANA zone for the header; the process's own when omitted. */
  timeZone?: string;
  sections: Section[];
  /** What the reader has to decide, permit, or do. Empty says so. Always printed last. */
  needsYou?: Line[];
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

/** `<1m`, `12m`, `3h`, `1h 12m`, `2d 1h`; null for a date that is not one. */
export function elapsed(since: Date, at = new Date()): string | null {
  const span = at.getTime() - since.getTime();
  if (!Number.isFinite(span)) return null;
  const minutes = Math.max(0, Math.floor(span / 60_000));
  if (minutes === 0) return '<1m';
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** A bullet is one line of text: newlines and runs of space collapse, so a reason cannot break the shape. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Lines with any text left once flattened; a blank one would print an empty bullet. */
function kept(lines: Line[]): Line[] {
  return lines
    .map((line) => (typeof line === 'string' ? flat(line) : { text: flat(line.text), children: line.children.map(flat).filter(Boolean) }))
    .filter((line) => (typeof line === 'string' ? line !== '' : line.text !== ''));
}

function renderSection(emoji: string, label: string | undefined, lines: Line[]): string[] {
  const nested = (line: Line, indent: string) =>
    typeof line === 'string' ? [`${indent}- ${line}`] : [`${indent}- ${line.text}`, ...line.children.map((child) => `${indent}  - ${child}`)];
  // One line stays on one line, labelled or not.
  if (lines.length === 1) {
    const [line] = nested(lines[0], '');
    const lead = `- ${emoji} ${label ? `${label}: ` : ''}`;
    return [line.replace(/^- /, () => lead), ...nested(lines[0], '').slice(1)];
  }
  // Several with no label: each its own bullet behind the emoji, never a bare emoji heading.
  if (!label) return lines.flatMap((line) => nested(line, '').map((text, i) => (i === 0 ? text.replace(/^- /, () => `- ${emoji} `) : text)));
  return [`- ${emoji} ${label}:`, ...lines.flatMap((line) => nested(line, '  '))];
}

export function renderReadout(readout: Readout): string {
  const at = readout.at ?? new Date();
  const ran = elapsed(readout.since, at);
  const header = [clock(at, readout.timeZone), ran ? `${ran} in` : '', readout.title ? flat(readout.title) : ''].filter(Boolean).join(' · ');
  const out = [header, ''];
  // ⛔ is the reader's alone: a section that uses it joins the requests at the end.
  const needs = kept([...(readout.needsYou ?? []), ...readout.sections.filter((s) => s.emoji.trim() === '⛔').flatMap((s) => s.lines)]);
  for (const section of readout.sections) {
    const emoji = flat(section.emoji);
    const lines = kept(section.lines);
    if (emoji === '⛔' || lines.length === 0) continue;
    out.push(...renderSection(emoji, section.label ? flat(section.label) : undefined, lines));
  }
  out.push(...(needs.length === 0 ? ['- 🟢 Nothing needs you.'] : renderSection('⛔', 'Needs you', needs)));
  return out.join('\n');
}
